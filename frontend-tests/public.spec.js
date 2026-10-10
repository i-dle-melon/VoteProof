import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=", "base64");
const today = () => new Date().toISOString().slice(0, 10);
const campaign = { campaign_id: "LOCAL-BROWSER", name: "本機公開活動", category: "投票活動", status: "active", campaign_timezone: "Asia/Taipei",
  vote_start_date: "2000-01-01", vote_end_date: "2099-12-31" };
async function fixture(page, options = {}) {
  const query = randomBytes(32).toString("base64url"), token = randomBytes(24).toString("base64url");
  const caseId = `VP-${today().replaceAll("-", "")}-${"A".repeat(16)}`;
  const boards = [{ leaderboard_id: "LOCAL-BOARD", name: "公開榜", generated_at: new Date().toISOString(),
    rankings: [{ rank: 7, nickname: options.nickname ?? "測試粉絲", points: 10, proof_count: 2, player_id: "not-for-display", email: "not-for-display" }] },
  { leaderboard_id: "LOCAL-EMPTY", name: "尚無成績的榜", generated_at: new Date().toISOString(), rankings: [] }];
  const state = { calls: [], puts: [], query, caseId, failCase: 0, failLookup: 0, delayCase: false, prepareReject: false, putFailures: 0, failBoards: 0 };
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", (route) => route.fulfill({ contentType: "text/javascript", body:
    `let widget;globalThis.turnstile={render(container,opts){widget=opts;container.textContent='本機隔離驗證 fixture';queueMicrotask(()=>opts.callback(${JSON.stringify(token)}));return 'widget';},reset(){queueMicrotask(()=>widget.callback(${JSON.stringify(token)}));}};` }));
  await page.route(/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\//, async (route) => {
    state.puts.push({ method: route.request().method(), type: route.request().headers()["content-type"], bytes: route.request().postDataBuffer()?.length });
    if (state.putFailures-- > 0) { await route.abort("failed"); return; }
    await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "ETag": "local-test" }, body: "" });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const body = request.method() === "POST" ? request.postDataJSON() : undefined;
    state.calls.push({ path, method: request.method(), body: request.postData(), idempotency: request.headers()["idempotency-key"] });
    const reply = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
    const error = (code, status) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code, message: "untrusted internal message" } }) });
    if (path === "/api/submissions/status") {
      if (options.gateError) return error("SUBMISSIONS_UNAVAILABLE", 503);
      return reply({ submissions_enabled: !options.submissionsOff, submissions_message: options.submissionsMessage ?? null });
    }
    if (path === "/api/campaigns") {
      if (options.campaignError) return error("CAMPAIGN_SERVICE_UNAVAILABLE", 503);
      return reply({ campaigns: options.emptyCampaigns ? [] : [{ ...campaign, name: options.campaignName ?? campaign.name }] });
    }
    if (path === "/api/leaderboards") {
      if (state.failBoards-- > 0) return route.abort();
      return reply({ leaderboards: options.emptyBoards ? [] : boards.filter((b) => !url.searchParams.has("id") || b.leaderboard_id === url.searchParams.get("id")) });
    }
    if (path === "/api/uploads/prepare") {
      if (state.prepareReject) return error("TURNSTILE_INVALID", 403);
      const session_id = randomUUID();
      return reply({ session_id, expires_in: 300, uploads: body.files.map((file) => ({
        key: `proofs/staging/${today().replaceAll("-", "/")}/${session_id}/${randomUUID()}.png`, method: "PUT",
        upload_url: `https://${randomBytes(16).toString("hex")}.r2.cloudflarestorage.com/fixture/${randomUUID()}`,
        headers: { "Content-Type": file.type } })) });
    }
    if (path === "/api/uploads/complete") return reply({ session_id: body.session_id, files: [] });
    if (path === "/api/cases") {
      if (state.delayCase) await new Promise((r) => setTimeout(r, 350));
      if (state.failCase-- > 0) return route.abort();
      return reply({ case_id: caseId, query_key: query, status: "pending" }, 201);
    }
    if (path.startsWith("/api/cases/")) {
      if (state.failLookup-- > 0) return route.abort();
      if (path !== "/api/cases/" + caseId || request.headers()["x-case-query-key"] !== query) return error("CASE_NOT_FOUND", 404);
      return reply({ case_id: caseId, created_at: new Date().toISOString(), campaign_id: campaign.campaign_id, vote_type: "Solo", vote_date: today(),
        status: options.caseStatus ?? "pending", query_key_hash: "not-for-display", object_key: "not-for-display", reviewer_note: "not-for-display", files: [] });
    }
    return error("NOT_FOUND", 404);
  });
  return state;
}
async function form(page, files = 1) {
  await page.goto("/#submit");
  await expect(page.locator("#submission-fields")).toBeEnabled();
  await page.locator("#nickname").fill("測試粉絲"); await page.locator("#player-id").fill("player-123");
  await page.locator("#vote-date").fill(today());
  if (files) await page.locator("#proof-images").setInputFiles(Array.from({ length: files }, (_, i) => ({ name: `proof-${i}.png`, mimeType: "image/png", buffer: png })));
  await expect(page.locator("#challenge-status")).toHaveText("已完成人機驗證");
}
async function noOverflow(page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }

test("global OFF disables submission with safe plaintext message; lookup and boards still work", async ({ page }) => {
  const state=await fixture(page,{submissionsOff:true,submissionsMessage:'<img src=x onerror=alert(1)> 投稿暫停'});
  await page.goto('/#submit');
  await expect(page.locator('#submission-fields')).toHaveJSProperty('disabled',true);await expect(page.locator('#nickname')).toBeDisabled();await expect(page.locator('#proof-images')).toBeDisabled();await expect(page.locator('#submit-button')).toBeDisabled();
  await expect(page.locator('#submit-availability')).toHaveText('<img src=x onerror=alert(1)> 投稿暫停');
  expect(await page.locator('#submit-availability img').count()).toBe(0);
  await expect(page.locator('nav[aria-label="主要導覽"] a[href="#submit"]')).toBeHidden();
  await page.goto('/#lookup');await expect(page.locator('#lookup-form')).toBeVisible();
  await page.goto('/#leaderboards');await expect(page.locator('#board-results')).toContainText('測試粉絲');
  expect(state.calls.some(c=>c.path.startsWith('/api/uploads/')||c.path==='/api/cases')).toBe(false);await noOverflow(page);
});
test("global status outage fails closed even with active campaigns", async ({ page }) => {
  await fixture(page,{gateError:true});await page.goto('/#submit');
  await expect(page.locator('#submit-availability')).toHaveText('投稿服務暫時無法使用，請稍後再試。');
  await expect(page.locator('#submit-button')).toBeDisabled();await expect(page.locator('#nickname')).toBeDisabled();
});
test("refreshing availability reflects admin OFF then ON without resetting form", async ({ page }) => {
  const options={};await fixture(page,options);await page.goto('/#submit');
  await expect(page.locator('#nickname')).toBeEnabled();await page.locator('#nickname').fill('保留資料');
  options.submissionsOff=true;options.submissionsMessage='維護中';await page.locator('a[data-view="home"]:visible').first().click();await page.locator('#campaign-refresh').click();await page.evaluate(()=>{location.hash='submit';});
  await expect(page.locator('#submit-button')).toBeDisabled();await expect(page.locator('#submit-availability')).toHaveText('維護中');
  options.submissionsOff=false;options.submissionsMessage=null;await page.locator('a[data-view="home"]:visible').first().click();await page.locator('#campaign-refresh').click();await page.evaluate(()=>{location.hash='submit';});
  await expect(page.locator('#nickname')).toBeEnabled();await expect(page.locator('#nickname')).toHaveValue('保留資料');
});

test("homepage CTA, public navigation, keyboard focus and responsive layout", async ({ page }) => {
  const state = await fixture(page); await page.goto("/");
  await expect(page.locator("#home-title")).toBeVisible(); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#campaign-list")).toContainText(campaign.name); await noOverflow(page);
  await page.locator(".hero-actions a[href='#lookup']").click(); await expect(page.locator("#lookup-form")).toBeVisible();
  await expect(page.locator("#lookup-title")).toBeFocused();
  expect(await page.locator("body").innerText()).not.toMatch(/會員登入|建立會員|管理員登入|模擬|Coming Soon/);
  expect(state.calls.filter((c) => c.path.includes("/auth/")).map(c => c.path)).toEqual(["/api/auth/me"]);
  expect(state.calls.some((c) => c.path.includes("/me/") || c.path.includes("/admin/"))).toBe(false);
  await page.locator("#lookup-id").focus();
  expect(await page.locator("#lookup-id").evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
});
test("theme preference is the only local storage value", async ({ page }) => {
  await fixture(page); await page.goto("/"); await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(["voteproof-theme"]);
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
test("empty campaign disables submission without sample IDs", async ({ page }) => {
  const state = await fixture(page, { emptyCampaigns: true }); await page.goto("/#submit");
  await expect(page.locator("#submit-availability")).toHaveText("目前沒有開放中的投票活動");
  await expect(page.locator("#submit-button")).toBeDisabled(); expect(state.calls.some((c) => c.path.includes("uploads"))).toBe(false); await noOverflow(page);
});
test("campaign service failure has a usable reload path", async ({ page }) => {
  await fixture(page, { campaignError: true }); await page.goto("/");
  await expect(page.locator("#campaign-message")).toContainText("重新載入");
  await expect(page.locator("#campaign-refresh")).toBeEnabled(); await expect(page.locator("#submit-button")).toBeDisabled();
});
test("invalid form and missing images do not send an upload request", async ({ page }) => {
  const state = await fixture(page); await form(page, 0); await page.locator("#submit-button").click();
  await expect(page.locator("#submission-error")).toContainText("至少選擇");
  await page.locator("#nickname").fill(" "); await page.locator("#proof-images").setInputFiles({ name: "p.png", mimeType: "image/png", buffer: png });
  await page.locator("#submit-button").click(); await expect(page.locator("#submission-error")).not.toBeEmpty();
  expect(state.calls.some((c) => c.path.includes("uploads"))).toBe(false);
});
test("multi-image preview and remove single image", async ({ page }) => {
  await fixture(page); await form(page, 2); await expect(page.locator(".image-item")).toHaveCount(2);
  await page.locator(".image-item button").first().click(); await expect(page.locator(".image-item")).toHaveCount(1); await noOverflow(page);
});
test("unsupported MIME and too many images are clear validation errors", async ({ page }) => {
  await fixture(page); await form(page, 0);
  await page.locator("#proof-images").setInputFiles({ name: "proof.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.locator("#image-error")).toContainText("PNG");
  await page.locator("#proof-images").setInputFiles(Array.from({ length: 6 }, () => ({ name: "p.png", mimeType: "image/png", buffer: png })));
  await expect(page.locator("#image-error")).toContainText("最多"); await expect(page.locator(".image-item")).toHaveCount(0);
});
test("full upload success shows query warning, copy controls and safe lookup", async ({ page }) => {
  const state = await fixture(page), logs = []; page.on("console", (message) => logs.push(message.text()));
  await form(page, 2); await page.locator("#submit-button").click();
  await expect(page.locator("#submission-success")).toBeVisible();
  expect((await page.locator("#success-query-key").textContent()) === state.query).toBe(true);
  await expect(page.locator("#submission-success")).toContainText("請自行保存");
  await expect(page.locator("#copy-case")).toBeVisible(); await expect(page.locator("#copy-key")).toBeVisible(); await expect(page.locator("#copy-all")).toBeVisible();
  expect(state.puts.length).toBe(2);
  expect(state.puts.every((p) => p.method === "PUT" && p.type === "image/png")).toBe(true);
  // WebKit's interception protocol can omit Blob/File request bodies. Check
  // exposed bodies, while real transport bytes/HEAD are covered by smoke.
  expect(state.puts.every((p) => p.bytes === undefined || p.bytes > 0)).toBe(true);
  expect(state.calls.filter((c) => c.path.includes("uploads") || c.path === "/api/cases").map((c) => c.path)).toEqual(["/api/uploads/prepare", "/api/uploads/complete", "/api/cases"]);
  await page.locator("#lookup-created").click(); await page.locator("#lookup-button").click();
  await expect(page.locator("#lookup-result")).toContainText("待審核");
  expect((await page.locator("#lookup-result").innerText()).includes("not-for-display")).toBe(false);
  expect(page.url().includes(state.query)).toBe(false); expect(await page.evaluate(() => Object.keys(localStorage).length + sessionStorage.length)).toBe(0);
  expect(logs.some((text) => text.includes(state.query) || text.includes("proofs/staging") || text.includes("r2.cloudflarestorage"))).toBe(false); await noOverflow(page);
});
test("network case retry reuses exact payload and key without another upload", async ({ page }) => {
  const state = await fixture(page); state.failCase = 1; await form(page);
  await page.locator("#submit-button").click(); await expect(page.locator("#retry-note")).toBeVisible();
  await expect(page.locator("#nickname")).toBeDisabled(); await expect(page.locator("#submit-button")).toHaveText("重試本次投稿");
  await page.locator("#submit-button").click(); await expect(page.locator("#submission-success")).toBeVisible();
  const creates = state.calls.filter((c) => c.path === "/api/cases");
  expect(creates.length).toBe(2); expect(creates[0].body === creates[1].body).toBe(true); expect(creates[0].idempotency === creates[1].idempotency).toBe(true);
  expect(state.puts.length).toBe(1);
});
test("rapid repeated submit does not create a second request", async ({ page }) => {
  const state = await fixture(page); state.delayCase = true; await form(page);
  await page.locator("#submission-form").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await expect(page.locator("#submission-success")).toBeVisible(); expect(state.calls.filter((c) => c.path === "/api/cases").length).toBe(1);
});
test("PUT network retry preserves images and completes", async ({ page }) => {
  const state = await fixture(page); state.putFailures = 1; await form(page);
  await page.locator("#submit-button").click(); await expect(page.locator("#submission-error")).toContainText("圖片未能上傳");
  await page.locator("#submit-button").click(); await expect(page.locator("#submission-success")).toBeVisible();
  expect(state.calls.filter((c) => c.path.endsWith("prepare")).length).toBe(1); expect(state.puts.length).toBe(2);
});
test("Turnstile rejection remains a failure, with no PUT/case bypass", async ({ page }) => {
  const state = await fixture(page); state.prepareReject = true; await form(page);
  await page.locator("#submit-button").click(); await expect(page.locator("#submission-error")).toContainText("重新驗證");
  expect(state.puts.length).toBe(0); expect(state.calls.some((c) => c.path === "/api/cases")).toBe(false);
});
test("wrong credential and nonexistent case produce the same generic lookup message", async ({ page }) => {
  const state = await fixture(page); await page.goto("/#lookup");
  await page.locator("#lookup-id").fill(state.caseId); await page.locator("#lookup-key").fill(randomBytes(32).toString("base64url"));
  await page.locator("#lookup-button").click(); await expect(page.locator("#lookup-message")).toHaveText("無法查詢此案件，請確認案件編號與查詢碼。");
  await page.locator("#lookup-id").fill("VP-20261009-" + "B".repeat(16)); await page.locator("#lookup-key").fill(state.query);
  await page.locator("#lookup-button").click(); await expect(page.locator("#lookup-message")).toHaveText("無法查詢此案件，請確認案件編號與查詢碼。");
  await expect(page.locator("#lookup-result")).toBeHidden();
});
test("lookup network error can retry successfully", async ({ page }) => {
  const state = await fixture(page); state.failLookup = 1; await page.goto("/#lookup");
  await page.locator("#lookup-id").fill(state.caseId); await page.locator("#lookup-key").fill(state.query);
  await page.locator("#lookup-button").click(); await expect(page.locator("#lookup-message")).toContainText("連線");
  await page.locator("#lookup-button").click(); await expect(page.locator("#lookup-result")).toBeVisible();
});
for (const [status, label] of [["approved", "已通過"], ["completed", "已完成"], ["rejected", "未通過"], ["duplicate", "重複投稿"], ["revoked", "已撤銷"]]) {
  test(`lookup maps ${status} to Chinese`, async ({ page }) => {
    const state = await fixture(page, { caseStatus: status }); await page.goto("/#lookup");
    await page.locator("#lookup-id").fill(state.caseId); await page.locator("#lookup-key").fill(state.query); await page.locator("#lookup-button").click();
    await expect(page.locator("#lookup-result")).toContainText(label);
  });
}
test("public leaderboard list/detail preserves server ranking without member requests", async ({ page }) => {
  const state = await fixture(page); await page.goto("/#leaderboards");
  await expect(page.locator("#board-results tr")).toHaveCount(1); await expect(page.locator("#board-results td").first()).toHaveText("7");
  expect((await page.locator("#view-leaderboards").innerText()).includes("not-for-display")).toBe(false);
  await page.locator("#board-select").selectOption("LOCAL-EMPTY"); await expect(page.locator("#boards-message")).toContainText("還沒有成績");
  expect(state.calls.some((c) => c.path.includes("/me/") || c.path.includes("/members/"))).toBe(false); await noOverflow(page);
});
test("empty public board list stays empty without sample fallback", async ({ page }) => {
  await fixture(page, { emptyBoards: true }); await page.goto("/#leaderboards");
  await expect(page.locator("#boards-message")).toHaveText("目前沒有公開排行榜"); await expect(page.locator("#board-select")).toBeDisabled();
});
test("leaderboard network failure has a working reload", async ({ page }) => {
  const state = await fixture(page); state.failBoards = 1; await page.goto("/#leaderboards");
  await expect(page.locator("#boards-message")).toContainText("重新載入"); await page.locator("#boards-refresh").click();
  await expect(page.locator("#board-results tr")).toHaveCount(1);
});
test("external text is inert, labels target controls and navigation targets are usable", async ({ page }) => {
  await fixture(page); await form(page); await noOverflow(page);
  expect(await page.locator("#submission-fields label").evaluateAll((labels) => labels.every((label) => Boolean(document.getElementById(label.htmlFor))))).toBe(true);
  const nav = page.locator(await page.locator(".sidebar").isVisible() ? ".sidebar nav a" : ".bottom-nav a");
  expect(await nav.evaluateAll((links) => links.every((link) => link.getBoundingClientRect().height >= 44))).toBe(true);
});
test("API strings render as text and cannot create HTML elements", async ({ page }) => {
  const attack = '<img src=x onerror="globalThis.unsafeMarker=1">';
  await fixture(page, { campaignName: attack, nickname: attack }); await page.goto("/");
  await expect(page.locator("#campaign-list h3")).toHaveText(attack); await expect(page.locator("#campaign-list img")).toHaveCount(0);
  await page.goto("/#leaderboards"); await expect(page.locator("#board-results")).toContainText(attack);
  await expect(page.locator("#board-results img")).toHaveCount(0); expect(await page.evaluate(() => globalThis.unsafeMarker === undefined)).toBe(true);
});
test("320px form layout, readable progress, and both themes have sufficient text contrast", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await fixture(page); await form(page); await noOverflow(page);
  await expect(page.locator("label[for='progress']")).toHaveText("投稿進度");
  for (let i = 0; i < 2; i++) {
    const ratios = await page.locator("#submit-button").evaluate((button) => {
      const luminance = (color) => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map((n) => Number(n) / 255).map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
        return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
      };
      const style = getComputedStyle(button), a = luminance(style.color), b = luminance(style.backgroundColor);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    });
    expect(ratios >= 4.5).toBe(true); await page.locator("#theme-toggle").click();
  }
});
