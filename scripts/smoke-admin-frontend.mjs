// Real static UI + Worker/RBAC/CSRF/D1/private R2. Disposable local data only.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { localAdminRuntime } from "./lib/local-admin-runtime.mjs";
import { frontendServer } from "./lib/frontend-server.mjs";
const h = await localAdminRuntime(), { local } = h;
let browser, server;
try {
  const actor = await h.identity({ role: "super_admin" });
  server = await frontendServer(); browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const origin = "https://voteproof.example", page = await context.newPage(), logs = [];
  await context.addCookies([{ name: "__Host-vp-session", value: actor.token, url: origin, httpOnly: true, secure: true, sameSite: "Lax" }]);
  page.on("dialog", dialog => dialog.accept()); page.on("console", message => logs.push(message.text()));
  await page.route(origin + "/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) { await route.fulfill({ response: await context.request.get(server.base + url.pathname) }); return; }
    const response = await local.runtime.dispatchFetch(request.url(), { method: request.method(), redirect: "manual", headers: request.headers(), ...(["GET", "HEAD"].includes(request.method()) ? {} : { body: request.postData() }) });
    const headers = Object.fromEntries(response.headers), cookies = response.headers.getSetCookie(); if (cookies.length) headers["set-cookie"] = cookies.join("\n");
    await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  });
  const panel = page.locator("#admin-panel"), click = label => panel.getByRole("button", { name: label, exact: true }).click();
  const tab = label => page.locator("#admin-tabs").getByRole("button", { name: label, exact: true }).click();
  await page.goto(origin + "/#admin"); await expect(page.locator("#admin-content")).toBeVisible(); await expect(panel).toContainText("案件審核");
  await tab("活動管理"); await click("建立活動");
  for (const [id, value] of [["campaign_id", "LOCAL-UI"], ["name", "本機正式介面驗收"], ["category", "Solo"], ["start_at", "2000-01-01T08:00"], ["end_at", "2100-01-01T08:00"], ["points_per_proof", "10"]]) await page.locator("#admin-field-" + id).fill(value);
  await page.locator("#admin-field-daily_mode").selectOption("unlimited"); await page.locator("#admin-field-status").selectOption("active");
  await click("保存活動"); await expect(panel).toContainText("本機正式介面驗收");
  const campaign = await local.db.prepare("SELECT * FROM campaigns WHERE campaign_id='LOCAL-UI'").first(); assert.equal(campaign.daily_limit, null); assert.equal(campaign.points_per_proof, 10);
  const fixture = await h.makeCase({ member: actor, metadata: { campaign_id: "LOCAL-UI" } });
  await tab("案件審核"); await click("查看與審核"); await click("查看證明 1"); await expect(panel.locator("img")).toBeVisible();
  assert.match(await panel.locator("img").getAttribute("src"), /^blob:/); await click("確認審核結果"); await expect(panel).toContainText("已通過");
  const reviewed = await local.db.prepare("SELECT status,points_awarded FROM cases WHERE case_id=?").bind(fixture.case_id).first(); assert.equal(reviewed.points_awarded, 10); assert.equal(reviewed.status, "approved");
  await tab("排行榜管理"); await click("建立排行榜");
  await page.locator("#admin-field-leaderboard_id").fill("LOCAL-UI-BOARD"); await page.locator("#admin-field-name").fill("本機應援排行榜"); await page.locator("#admin-field-top_n").fill("10"); await page.locator("#admin-field-is_public").selectOption("true"); await page.locator("#admin-field-status").selectOption("active");
  await click("保存排行榜"); await expect(panel).toContainText("本機應援排行榜"); await click("重建成績"); await expect(panel).toContainText("本機應援排行榜"); await click("查看目前成績"); await expect(panel.locator("tbody tr")).toHaveCount(1); await expect(panel.locator("tbody tr td").nth(2)).toHaveText("10");
  await tab("會員等級"); await expect(panel.getByText("未啟用", { exact: true })).toHaveCount(7); await panel.getByRole("button", { name: "編輯等級" }).first().click();
  await page.locator("#admin-field-min_points").fill("100"); await page.locator("#admin-field-reason").fill("本機配置驗收"); await click("保存等級"); await expect(panel).toContainText("100 點");
  await tab("投稿設定"); await page.locator("#admin-field-submissions_enabled").selectOption("false"); await page.locator("#admin-field-submissions_message").fill("本機投稿暫停"); await click("保存投稿設定"); await expect(page.locator("#admin-field-submissions_enabled")).toHaveValue("false");
  await expect.poll(async () => (await local.db.prepare("SELECT submissions_enabled FROM submission_settings WHERE id=1").first()).submissions_enabled).toBe(0);
  const gate = await local.fetch("/api/submissions/status"); assert.equal((await gate.json()).data.submissions_enabled, false);
  const blocked = await local.fetch("/api/uploads/prepare", "POST", { turnstile_token: crypto.randomUUID(), files: [{ name: "local.png", type: "image/png", size:3,algorithm:'sha256',sha256:'a'.repeat(64) }] });
  assert.equal(blocked.status, 503); assert.equal((await blocked.json()).error.code, "SUBMISSIONS_DISABLED");
  await tab("操作紀錄"); await expect(panel).toContainText("建立活動"); await expect(panel).toContainText("更新會員等級");
  assert.deepEqual((await local.db.prepare("PRAGMA foreign_key_check").all()).results, []); assert.equal((await local.db.prepare("PRAGMA quick_check").first()).quick_check, "ok");
  assert.equal(local.unexpectedUpstreams.length, 0); assert.equal(logs.some(line => line.includes(actor.token) || line.includes(actor.csrf)), false);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  console.log("Admin frontend smoke PASS: real RBAC/CSRF/versions, private proof, review+ledger, NULL campaign, published leaderboard, tier config, gate OFF and audit; isolated local D1/R2 only");
} finally { if (browser) await browser.close(); if (server) await server.close(); await local.runtime.dispose(); }
