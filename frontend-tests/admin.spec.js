import { test, expect } from "@playwright/test";
import { adminFixture } from "./admin-fixture.mjs";
import { memberFixture } from "./member-fixture.mjs";
const panel = page => page.locator("#admin-panel");
const open = async (page, tab) => { await page.goto("/#admin"); await page.locator("#admin-tabs").getByRole("button", { name: tab, exact: true }).click(); };
const save = async (page, name) => name === "查看與審核" ? panel(page).locator(".case-preview").click({position:{x:12,y:12}}) : panel(page).getByRole("button", { name, exact: true }).click();
test("guest/ordinary member cannot see admin or infer it from storage/profile", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); state.member.role = "super_admin";
  await page.addInitScript(() => localStorage.setItem("role", "super_admin"));
  await page.goto("/#member"); await expect(page.locator("#admin-nav-group")).toBeHidden(); await expect(page.locator("#member-admin-entry")).toBeHidden();
  await page.goto("/#admin"); await expect(page.locator("#admin-content")).toBeHidden(); await expect(page.locator("#admin-gate")).toBeVisible();
});
test("admin/security use external scripts/styles and generate no script CSP violations", async ({ page }) => {
  await adminFixture(page); await page.addInitScript(() => {
    globalThis.__adminScriptCsp = [];
    document.addEventListener("securitypolicyviolation", e => { if (e.effectiveDirective.startsWith("script-src")) globalThis.__adminScriptCsp.push(e.effectiveDirective); });
  });
  await page.goto("/#admin"); await expect(page.locator("#admin-tabs button")).toHaveCount(11);
  for (const label of ["活動管理", "排行榜管理", "會員等級", "投稿設定"]) {
    await page.locator("#admin-tabs").getByRole("button", { name: label, exact: true }).click(); await expect(panel(page).locator("h2")).toHaveText(label);
    expect(await panel(page).evaluate(n => [...n.querySelectorAll("*")].every(el => [...el.attributes].every(a => a.name !== "style" && !/^on/i.test(a.name))))).toBe(true);
  }
  await page.goto("/#security"); await expect(page.locator("#security-password")).toContainText("已設定");
  await expect(page.locator("script:not([src])")).toHaveCount(0); expect(await page.evaluate(() => globalThis.__adminScriptCsp)).toEqual([]);
  await expect(page.locator("#view-security")).not.toContainText(/Supabase|OAuth|Cloudflare|provider|session|token|初版|示範/i);
});
test("admin nav requires server role and mobile retains five public slots", async ({ page }) => {
  await adminFixture(page); await page.goto("/#member"); await expect(page.locator("#member-admin-entry")).toBeVisible();
  await expect(page.locator("#admin-nav-group")).not.toHaveAttribute("hidden"); await expect(page.locator(".bottom-nav a")).toHaveCount(5);
  await page.locator("#member-admin-entry").click(); await expect(panel(page)).toContainText("案件審核");
});
test("privileged role recheck on foreground preserves unsaved profile fields", async ({ page }) => {
  const state = await adminFixture(page); await page.goto("/#member");
  await expect(page.locator("#member-admin-entry")).toBeVisible();
  await expect(page.locator("#profile-nickname")).toHaveValue(state.member.nickname);
  await page.locator("#profile-nickname").fill("尚未送出的暱稱");
  const before = state.calls.filter(c => c.path === "/api/admin/me").length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.calls.filter(c => c.path === "/api/admin/me").length).toBeGreaterThan(before);
  await expect(page.locator("#profile-nickname")).toHaveValue("尚未送出的暱稱"); await expect(page.locator("#profile-fan-readonly")).toHaveText("local-player");
});

test("session-bound admin MFA remains available beyond one hour and revocation still closes it", async ({ page }) => {
  const now = Date.now(), state = await adminFixture(page);
  state.elevationUntil = now / 1000 + 7 * 86400;
  await page.clock.setFixedTime(now);
  await page.goto("/#admin"); await expect(page.locator("#admin-tabs button")).toHaveCount(11);
  await expect(page.locator("#admin-panel")).toHaveAttribute("aria-busy", "false");
  await page.clock.setFixedTime(now + 2 * 3600000);
  const checks = state.calls.filter(c => c.path === "/api/admin/me").length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.calls.filter(c => c.path === "/api/admin/me").length).toBeGreaterThan(checks);
  await expect(page.locator("#admin-nav-group")).not.toHaveAttribute("hidden");
  await expect(page.locator("#admin-content")).toBeVisible();
  expect(state.calls.filter(c => c.path.endsWith("/step-up"))).toHaveLength(0);
  state.revoked = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#admin-nav-group")).toBeHidden();
  await expect(page.locator("#admin-content")).toBeHidden();
});
test("expired MFA closes all privileged content and offers security reauth", async ({ page }) => {
  await adminFixture(page, { expiredMfa: true }); await page.goto("/#admin"); await expect(page.locator("#admin-content")).toBeHidden();
  await expect(page.locator("#admin-gate a")).toHaveText("重新驗證身份"); await expect(page.locator("#admin-nav-group")).toBeHidden();
});
test("Google security callback uses real step-up contract and preserves code on app return", async ({ page }) => {
  const state = await adminFixture(page, { expiredMfa: true }); state.invalidTotp = 1;
  await page.goto("/#security"); await page.locator("#security-google-step").click(); await expect(page.locator("#google-step-form")).toBeVisible();
  await expect(page.locator("#google-confirm-form")).toBeHidden(); await page.locator("#google-step-code").fill("001234");
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); }); await expect(page.locator("#google-step-code")).toHaveValue("001234");
  await page.locator("#google-step-form button[type=submit]").click(); await expect(page.locator("#google-error")).toContainText("驗證未完成");
  await page.locator("#google-step-code").fill("001234"); await page.locator("#google-step-form button[type=submit]").click();
  await expect(page).toHaveURL(/#security$/); await expect(page.locator("#admin-nav-group")).not.toHaveAttribute("hidden");
  expect(state.calls.find(c => c.path === "/api/auth/google/start").body).toEqual({ purpose: "security", confirmed: true });
  const request = state.calls.find(c => c.path === "/api/auth/google/step-up"); expect(request.body.code).toBe("001234"); expect(request.headers["x-csrf-token"]).toBe(state.csrf);
});
test("password step-up uses password and TOTP, never edits timestamps", async ({ page }) => {
  const state = await adminFixture(page, { expiredMfa: true }); await page.goto("/#security");
  await page.locator("#security-step-password").fill("local-safe-password"); await page.locator("#security-step-code").fill("001234"); await page.locator("#security-step-form button").click();
  await expect(page.locator("#security-step-status")).toContainText("身份驗證完成"); await expect(page.locator("#admin-nav-group")).not.toHaveAttribute("hidden");
  expect(Object.keys(state.calls.find(c => c.path === "/api/auth/step-up").body).sort()).toEqual(["code", "password"]);
});
test("review preview uses private stream/blob and is erased on leaving", async ({ page }) => {
  const state = await adminFixture(page); await page.goto("/#admin"); await save(page, "查看與審核");
  await expect(panel(page).locator(".inline-review img")).toBeVisible(); expect(await panel(page).locator(".inline-review img").getAttribute("src")).toMatch(/^blob:/);
  const proof = state.calls.find(c => c.path.includes("/files/")); expect(proof.method).toBe("GET");
  await page.locator("#member-entry").click(); await expect(panel(page).locator(".inline-review img")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toMatch(/proofs\/|cloudflarestorage|private SQL/);
});
test("reviewer sees review only and cannot complete/revoke or manage", async ({ page }) => {
  await adminFixture(page, { role: "reviewer", caseStatus: "approved" }); await page.goto("/#admin");
  await expect(page.locator("#admin-tabs button")).toHaveCount(3); await save(page, "查看與審核"); await expect(panel(page)).toContainText("沒有可用審核操作"); await expect(page.locator("#admin-field-action")).toHaveCount(0);
});
test("review sends expected_version and conflict requires a fresh explicit read", async ({ page }) => {
  const state = await adminFixture(page); await page.goto("/#admin"); await save(page, "查看與審核"); state.conflict = true; await save(page, "確認審核結果");
  await expect(page.locator("#admin-status")).toContainText("未自動重送"); await expect(panel(page)).toContainText("重新載入確認");
  const writes = state.calls.filter(c => c.path.endsWith("/review")); expect(writes).toHaveLength(1); expect(writes[0].body.expected_version).toBe(0); expect(writes[0].headers["x-csrf-token"]).toBe(state.csrf);
});
test("empty admin case list is honest", async ({ page }) => {
  await adminFixture(page, { emptyCases: true }); await page.goto("/#admin"); await expect(panel(page)).toContainText("目前沒有符合條件的案件。");
});
test("campaign editor preserves active timestamps and null unlimited", async ({ page }) => {
  const state = await adminFixture(page); await open(page, "活動管理"); await expect(panel(page)).toContainText("不限次數"); await save(page, "編輯活動");
  await expect(page.locator("#admin-field-start_at")).toHaveValue(/^2026-09-10T23:00(?::00)?$/); await expect(page.locator("#admin-field-start_at")).toBeDisabled();
  await expect(page.locator("#admin-field-daily_mode")).toHaveValue("unlimited"); await save(page, "保存活動");
  await expect(panel(page)).toContainText("本機應援活動"); const write = state.calls.find(c => c.path.endsWith("LOCAL/update")); expect(write.body.daily_limit).toBeNull(); expect(write.body.expected_version).toBe(0); expect(write.body.start_at).toBe(state.campaigns[0].start_at);
});
for (const [mode, limit] of [["zero", 0], ["limited", 1], ["limited", 1000]]) test(`campaign daily cap ${mode}/${limit} preserves semantics`, async ({ page }) => {
  const state = await adminFixture(page); await open(page, "活動管理"); await save(page, "編輯活動"); await page.locator("#admin-field-daily_mode").selectOption(mode);
  if (mode === "limited") await page.locator("#admin-field-daily_limit").fill(String(limit)); await save(page, "保存活動");
  await expect(panel(page).getByRole("button", { name: "編輯活動" })).toBeVisible(); expect(state.calls.find(c => c.path.endsWith("LOCAL/update")).body.daily_limit).toBe(limit);
});
test("campaign create converts Taiwan datetime and uses explicit supported values", async ({ page }) => {
  const state = await adminFixture(page); await open(page, "活動管理"); await save(page, "建立活動");
  for (const [id, val] of [["campaign_id", "NEW"], ["name", "新活動"], ["start_at", "2026-09-10T23:00"], ["end_at", "2026-10-20T22:59"], ["points_per_proof", "10"]]) await page.locator("#admin-field-" + id).fill(val);
  await expect(page.locator('select#admin-field-solo_target option')).toHaveCount(6);
  await page.locator('#admin-field-solo_target').selectOption('yuqi');
  await page.locator("#admin-field-daily_mode").selectOption("unlimited"); await save(page, "保存活動"); await expect(panel(page)).toContainText("新活動");
  const write = state.calls.find(c => c.path === "/api/admin/campaigns" && c.method === "POST"); expect(write.body.start_at).toBe("2026-09-10T15:00:00.000Z"); expect(write.body.daily_limit).toBeNull();expect(write.body.solo_target).toBe('yuqi');
});
test('group campaign hides target and saves null; registry label comes from backend',async({page})=>{
 const state=await adminFixture(page);state.soloTargets[3].display_name='YUQI updated';await open(page,'活動管理');await save(page,'建立活動');
 await expect(page.locator('#admin-field-solo_target option[value=yuqi]')).toHaveText('YUQI updated');
 await page.locator('#admin-field-category').selectOption('團體');await expect(page.locator('#admin-field-solo_target')).toBeHidden();await expect(page.locator('#admin-field-solo_target')).toBeDisabled();
 for(const [id,value]of [['campaign_id','NEW-GROUP'],['name','團體活動'],['start_at','2026-09-10T23:00'],['end_at','2026-10-20T22:59'],['points_per_proof','10']])await page.locator('#admin-field-'+id).fill(value);
 await page.locator('#admin-field-daily_mode').selectOption('unlimited');await save(page,'保存活動');await expect(panel(page)).toContainText('團體活動');
 expect(state.calls.find(c=>c.path==='/api/admin/campaigns'&&c.method==='POST').body.solo_target).toBeNull();
});
test("leaderboard preserves server ranks and rebuild is versioned, no result editing", async ({ page }) => {
  const state = await adminFixture(page); await open(page, "排行榜管理"); await save(page, "重建成績");
  await expect(panel(page)).toContainText("本機公開成績"); await save(page, "查看目前成績"); await expect(panel(page).locator("tbody tr td").first()).toHaveText("4");
  expect(state.calls.find(c => c.path.endsWith("/rebuild")).body).toEqual({ expected_version: 0 }); await expect(panel(page).locator("input")).toHaveCount(0);
});
test("leaderboard definition update uses explicit scoped filters", async ({ page }) => {
  const state = await adminFixture(page); await open(page, "排行榜管理"); await save(page, "查看設定"); await page.locator("#admin-field-type").selectOption("custom");
  await page.locator("#admin-field-start_date").fill("2026-10-01"); await page.locator("#admin-field-end_date").fill("2026-10-20"); await page.locator("#admin-field-vote_type").selectOption("Solo"); await save(page, "保存排行榜");
  await expect(panel(page)).toContainText("本機公開成績"); const write = state.calls.find(c => c.path.endsWith("BOARD/update")); expect(write.body.start_date).toBe("2026-10-01"); expect(write.body.campaign_id).toBeNull(); expect(write.body.vote_type).toBe("Solo");
});
test("tier configuration has no invented thresholds and edits with reason/version", async ({ page }) => {
  const state = await adminFixture(page); await open(page, "會員等級"); await expect(panel(page)).toContainText("門檻尚未設定"); await expect(panel(page).getByText("未啟用", { exact: true })).toHaveCount(7);
  await panel(page).getByRole("button", { name: "編輯等級" }).first().click(); await expect(page.locator("#admin-field-min_points")).toHaveValue("");
  await page.locator("#admin-field-min_points").fill("100"); await page.locator("#admin-field-reason").fill("開放等級"); await save(page, "保存等級");
  await expect(panel(page)).toContainText("100 點"); const write = state.calls.find(c => c.path.includes("bronze/update")); expect(write.body.expected_version).toBe(0); expect(write.body.status).toBe("disabled");
});
test("foreground revalidation preserves campaign draft without writing or bypassing MFA", async ({ page }) => {
  const state = await adminFixture(page); await open(page, "活動管理"); await save(page, "編輯活動");
  await page.locator("#admin-field-name").fill("未送出的變更");
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.locator("#admin-field-name")).toHaveValue("未送出的變更"); expect(state.calls.some(c => c.method === "POST")).toBe(false);
});
test("submission OFF to ON requires explicit confirmation and never toggles automatically", async ({ page }) => {
  const state = await adminFixture(page, { autoConfirm: false }); await open(page, "投稿設定"); await page.locator("#admin-field-submissions_enabled").selectOption("true");
  page.once("dialog", d => d.dismiss()); await save(page, "保存投稿設定"); expect(state.calls.some(c => c.path.endsWith("submissions/update"))).toBe(false);
  page.once("dialog", d => { expect(d.message()).toContain("確定開放"); void d.accept(); }); await save(page, "保存投稿設定"); await expect(page.locator("#admin-field-submissions_enabled")).toHaveValue("true");
  await expect.poll(() => state.calls.find(c => c.path.endsWith("submissions/update"))?.body.expected_version).toBe(0);
});
test("audit renders real safe fields as text, no internal result JSON", async ({ page }) => {
  const state = await adminFixture(page); state.audit.push({ action: "campaign_create", target_id: '<img src=x onerror="unsafe()">', admin_member_id: state.member.member_id, created_at: new Date().toISOString(), before: { private: "not-for-display" } });
  await open(page, "操作紀錄"); await expect(panel(page)).toContainText("建立活動"); await expect(panel(page)).toContainText("<img"); await expect(panel(page).locator(".inline-review img")).toHaveCount(0); await expect(panel(page)).not.toContainText("not-for-display");
});
test("MFA expires during admin fetch, private previews/nav are cleared", async ({ page }) => {
  const state = await adminFixture(page); await page.goto("/#admin"); await save(page, "查看與審核"); await expect(panel(page).locator(".inline-review img")).toBeVisible();
  state.elevationUntil = 0; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect(page.locator("#admin-content")).toBeHidden(); await expect(panel(page).locator(".inline-review img")).toHaveCount(0);
});
test("security devices/recovery/reset require confirmation and use supported endpoints", async ({ page }) => {
  const state = await adminFixture(page); state.devices = [{ id: "12345678-1234-4234-8234-123456789abc", label: "本機手機", expires_at: Date.now() / 1000 + 500 }];
  await page.goto("/#security"); await page.locator("#security-devices").getByRole("button").click(); await expect(page.locator("#security-devices-status")).toContainText("沒有信任");
  await page.locator("#security-regenerate").click(); await expect(page.locator("#security-recovery-codes li")).toHaveCount(10); await page.locator("#security-recovery-ack").check(); await page.locator("#security-done").click(); await expect(page.locator("#security-recovery-codes")).toBeEmpty();
  await page.locator("#security-reset").click(); await expect(page.locator("#security-enroll-form")).toBeVisible(); await page.locator("#security-enroll-code").fill("001234"); await page.locator("#security-enroll-form button").click();
  await expect(page.locator("#security-recovery-codes li")).toHaveCount(10); await expect(page.locator("#login-entry")).toBeVisible(); await page.locator("#security-recovery-ack").check(); await page.locator("#security-done").click(); await expect(page).toHaveURL(/#login$/);
});
test("Google-only enrollment grants no admin role/elevation", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true, googleOnly: true }); page.on("dialog", d => d.accept());
  await page.goto("/#security"); await page.locator("#security-enroll").click(); await expect(page.locator("#security-enroll-form")).toBeVisible(); await page.locator("#security-enroll-code").fill("001234"); await page.locator("#security-enroll-form button").click();
  await expect(page.locator("#security-recovery-codes li")).toHaveCount(10); await expect(page.locator("#admin-nav-group")).toBeHidden(); expect(state.calls.some(c => c.path.endsWith("google/step-up"))).toBe(false);
});
test("all new admin/security screens fit 320/390/430 and both themes", async ({ page }) => {
  await adminFixture(page); await page.goto("/#admin");
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 560 });
    for (const theme of ["dark", "light"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme-toggle").click();
      for (const tab of ["案件審核", "活動管理", "排行榜管理", "會員等級", "投稿設定", "操作紀錄"]) {
        await page.locator("#admin-tabs").getByRole("button", { name: tab, exact: true }).click(); await expect(panel(page).locator("h2")).toHaveText(tab);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
  }
  await page.goto("/#security"); await expect(page.locator("#security-password")).toContainText("已設定"); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
