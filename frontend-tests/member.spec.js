import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { memberFixture, png } from "./member-fixture.mjs";
const clickSubmit = (page, id) => page.locator(`#${id} button[type='submit']`).click();
async function startRegistration(page) {
  await page.goto("/#register"); await expect(page.locator("#register-challenge-status")).toHaveText("已完成人機驗證");
  await page.locator("#register-email").fill("local@example.com"); await clickSubmit(page, "register-email-form");
  await expect(page.locator("#register-code-form")).toBeVisible();
}
async function enrollment(page, state) {
  await startRegistration(page); await page.locator("#register-code").fill("001234"); await clickSubmit(page, "register-code-form");
  await expect(page.locator("#register-password-form")).toBeVisible();
  await page.locator("#register-password").fill(state.password); await page.locator("#register-confirm").fill(state.password);
  await clickSubmit(page, "register-password-form"); await expect(page.locator("#register-totp-form")).toBeVisible();
}
async function recoveryCodes(page, state) {
  await enrollment(page, state); await page.locator("#register-totp").fill("001234"); await clickSubmit(page, "register-totp-form");
  await expect(page.locator("#register-recovery")).toBeVisible();
}
async function beginLogin(page, state) {
  await page.goto("/#login"); await page.locator("#login-email").fill("local@example.com"); await page.locator("#login-password").fill(state.password);
}
async function recoveryStart(page, state) {
  await page.goto("/#recover"); await page.locator("#recover-email").fill("local@example.com");
  await page.locator("#recover-totp").fill("001234"); await page.locator("#recover-code").fill(state.recoveryCodes[0]);
  await clickSubmit(page, "recover-proof-form"); await expect(page.locator("#recover-password-form")).toBeVisible();
}
async function submission(page, member = false) {
  await page.goto("/#submit"); await expect(page.locator("#submission-fields")).toBeEnabled();
  if (member) { await expect(page.locator("#member-mode")).toBeEnabled(); await page.locator("#submission-mode").selectOption("member"); }
  await page.locator("#nickname").fill("本機投稿"); await page.locator("#player-id").fill("local-player");
  await page.locator("#vote-date").fill(new Date().toISOString().slice(0, 10));
  await page.locator("#proof-images").setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: png });
  await expect(page.locator("#challenge-status")).toHaveText("已完成人機驗證");
}

test("logged-out navigation exposes login/registration and no admin", async ({ page }) => {
  const state = await memberFixture(page); await page.goto("/"); await page.locator("#login-entry").click();
  await expect(page.locator("#login-form")).toBeVisible(); await expect(page.locator("a[href='#register']")).toBeVisible();
  await expect(page.locator("#member-entry")).toBeHidden(); await expect(page.locator("a[href*='admin']")).toHaveCount(0);
  expect(state.providerRequests).toEqual([]);
});
test("email start, safe sent state, six-digit paste preserving zeros and password step", async ({ page }) => {
  const state = await memberFixture(page); await startRegistration(page);
  await expect(page.locator("#register-resend")).toBeDisabled(); await expect(page.locator("#register-sent")).toContainText("驗證信已寄出");
  await page.locator("#register-code").evaluate(input => {
    const data = new DataTransfer(); data.setData("text/plain", "001234"); input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await clickSubmit(page, "register-code-form"); await expect(page.locator("#register-password-form")).toBeVisible();
  expect(state.calls.find(call => call.path.endsWith("verify-email")).body.code === "001234").toBe(true);
  expect(new URL(page.url()).search).toBe(""); await expect(page.locator("#register-code")).toHaveValue("");
});
test("resend cooldown allows resend after 60s and resets it", async ({ page }) => {
  await page.clock.install(); const state = await memberFixture(page); await startRegistration(page);
  await expect(page.locator("#register-resend")).toBeDisabled(); await page.clock.fastForward(61000);
  await expect(page.locator("#register-resend")).toBeEnabled(); await page.locator("#register-resend").click();
  await expect(page.locator("#register-resend")).toBeDisabled(); expect(state.calls.filter(call => call.path.endsWith("resend"))).toHaveLength(1);
});
test("wrong email code stays on step with a generic retry error", async ({ page }) => {
  const state = await memberFixture(page); state.invalidCode = 1; await startRegistration(page);
  await page.locator("#register-code").fill("001234"); await clickSubmit(page, "register-code-form");
  await expect(page.locator("#register-error")).toContainText("驗證未完成"); await expect(page.locator("#register-code-form")).toBeVisible();
  expect((await page.locator("body").innerText()).includes("private provider")).toBe(false);
});
test("expired email challenge cannot continue and offers restart", async ({ page }) => {
  await page.clock.install(); const state = await memberFixture(page, { expired: true }); await startRegistration(page); await page.clock.fastForward(2000);
  await expect(page.locator("#register-expiry")).toContainText("已過期");
  await page.locator("#register-code").fill("001234"); await clickSubmit(page, "register-code-form");
  expect(state.calls.some(call => call.path.endsWith("verify-email"))).toBe(false);
  await page.locator("#register-restart").click(); await expect(page.locator("#register-email-form")).toBeVisible();
});
test("registration unavailable and rate limits do not reveal quota counts", async ({ page }) => {
  const state = await memberFixture(page, { unavailable: true }); await page.goto("/#register");
  await page.locator("#register-email").fill("local@example.com"); await clickSubmit(page, "register-email-form");
  await expect(page.locator("#register-error")).toContainText("註冊暫時無法使用"); expect(state.calls.some(call => call.path.endsWith("register/start"))).toBe(false);
});
test("registration 429 is generic and retryable", async ({ page }) => {
  await memberFixture(page, { rateLimited: true }); await page.goto("/#register"); await expect(page.locator("#register-challenge-status")).toHaveText("已完成人機驗證");
  await page.locator("#register-email").fill("local@example.com"); await clickSubmit(page, "register-email-form");
  await expect(page.locator("#register-error")).toContainText("操作過於頻繁"); await expect(page.locator("#register-email-form")).toBeVisible();
});
test("password length/confirmation/show-hide match backend, with no provider request", async ({ page }) => {
  const state = await memberFixture(page); await startRegistration(page); await page.locator("#register-code").fill("001234"); await clickSubmit(page, "register-code-form");
  await page.locator("#register-password").fill("short"); await page.locator("#register-confirm").fill("short"); await clickSubmit(page, "register-password-form");
  await expect(page.locator("#register-error")).toContainText("12～128");
  await page.locator("#register-password").fill(state.password); await page.locator("#register-confirm").fill("different-value"); await clickSubmit(page, "register-password-form");
  await expect(page.locator("#register-error")).toContainText("不相同");
  await page.locator("[data-password='register-password']").click(); await expect(page.locator("#register-password")).toHaveAttribute("type", "text");
  expect(state.calls.some(call => call.path.endsWith("credentials"))).toBe(false); expect(state.providerRequests).toEqual([]);
});
test("local TOTP QR/manual key, failed verification retry and immediate finalization erasure", async ({ page }) => {
  const state = await memberFixture(page); state.invalidTotp = 1; await enrollment(page, state);
  expect(await page.locator("#enrollment-key").textContent() === state.manual).toBe(true);
  expect(await page.locator("#enrollment-qr").evaluate(canvas => canvas.width > 200)).toBe(true);
  await page.locator("#register-totp").fill("001234"); await clickSubmit(page, "register-totp-form"); await expect(page.locator("#register-error")).toContainText("驗證未完成");
  await page.locator("#register-totp").fill("001234"); await clickSubmit(page, "register-totp-form"); await expect(page.locator("#register-recovery")).toBeVisible();
  await expect(page.locator("#enrollment-key")).toBeEmpty(); expect(await page.locator("#enrollment-qr").evaluate(canvas => canvas.width)).toBe(0);
  expect(state.providerRequests).toEqual([]);
});
test("recovery codes copy/acknowledgement then registration completion/member center", async ({ page }) => {
  const state = await memberFixture(page); await recoveryCodes(page, state);
  await expect(page.locator("#recovery-codes li")).toHaveCount(10); await expect(page.locator("#registration-done")).toBeDisabled();
  await page.locator("#copy-recovery-codes").click(); await expect(page.locator("#recovery-copy-status")).toContainText("已複製");
  expect(await page.evaluate(codes => globalThis.__copiedFixture === codes.join("\n"), state.recoveryCodes)).toBe(true);
  await page.locator("#recovery-ack").check(); await page.locator("#registration-done").click();
  await expect(page.locator("#register-success")).toBeVisible(); await expect(page.locator("#recovery-codes li")).toHaveCount(0);
  await page.locator("#register-success a").click(); await expect(page.locator("#member-points")).toHaveText("123");
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
test("leaving enrollment clears QR/key/password and resets registration transaction", async ({ page }) => {
  const state = await memberFixture(page); await enrollment(page, state); await page.locator(".bottom-nav a[href='#home'],.sidebar nav a[href='#home']").filter({ visible: true }).click();
  await expect(page.locator("#enrollment-key")).toBeEmpty(); expect(await page.locator("#enrollment-qr").evaluate(canvas => canvas.width)).toBe(0);
  await expect(page.locator("#register-password")).toHaveValue(""); await page.goto("/#register"); await expect(page.locator("#register-email-form")).toBeVisible();
});
test("leaving recovery-code step erases all codes, cannot redisplay on return", async ({ page }) => {
  const state = await memberFixture(page); await recoveryCodes(page, state); await page.locator("#member-entry").click();
  await expect(page.locator("#recovery-codes")).toBeEmpty(); await page.goto("/#register"); await expect(page.locator("#register-email-form")).toBeVisible();
  await expect(page.locator("#recovery-codes")).toBeEmpty();
});
test("registration duplicate submits issue one start request", async ({ page }) => {
  const state = await memberFixture(page); state.delay = true; await page.goto("/#register"); await expect(page.locator("#register-challenge-status")).toHaveText("已完成人機驗證");
  await page.locator("#register-email").fill("local@example.com"); await page.locator("#register-email-form").evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await expect(page.locator("#register-code-form")).toBeVisible(); expect(state.calls.filter(call => call.path.endsWith("register/start"))).toHaveLength(1);
});
test("trusted login requires password, supports remember-me and logs in directly", async ({ page }) => {
  const state = await memberFixture(page, { trusted: true }); await beginLogin(page, state); await page.locator("#login-remember").check();
  await clickSubmit(page, "login-form"); await expect(page.locator("#member-content")).toBeVisible();
  expect(state.calls.find(call => call.path === "/api/auth/login").body.remember_me).toBe(true);
  expect(state.calls.some(call => call.path.endsWith("login/totp"))).toBe(false); await expect(page.locator("#login-password")).toHaveValue("");
});
test("untrusted login TOTP failure/retry, trust device and remember-me contract", async ({ page }) => {
  const state = await memberFixture(page); state.invalidTotp = 1; await beginLogin(page, state); await page.locator("#login-remember").check();
  await clickSubmit(page, "login-form"); await expect(page.locator("#login-totp-form")).toBeVisible(); await page.locator("#login-trust").check();
  await page.locator("#login-totp").fill("001234"); await clickSubmit(page, "login-totp-form"); await expect(page.locator("#login-error")).toContainText("驗證未完成");
  await page.locator("#login-totp").fill("001234"); await clickSubmit(page, "login-totp-form"); await expect(page.locator("#member-content")).toBeVisible();
  expect(state.calls.filter(call => call.path.endsWith("login/totp")).every(call => call.body.trust_this_device === true)).toBe(true);
});
test("bad login uses generic failure and does not reveal account/suspension", async ({ page }) => {
  const state = await memberFixture(page, { badLogin: true }); await beginLogin(page, state); await clickSubmit(page, "login-form");
  await expect(page.locator("#login-error")).toHaveText("登入未完成，請確認登入資料後重試。"); await expect(page.locator("#login-password")).toHaveValue("");
});
test("full password recovery revokes session UI and requires fresh login", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); await recoveryStart(page, state);
  const next = randomBytes(16).toString("hex"); await page.locator("#recover-password").fill(next); await page.locator("#recover-confirm").fill(next);
  await clickSubmit(page, "recover-password-form"); await expect(page.locator("#recover-success")).toContainText("所有登入 session 與信任裝置已撤銷");
  await expect(page.locator("#member-entry")).toBeHidden(); await expect(page.locator("#login-entry")).toBeVisible();
  await expect(page.locator("#recover-code")).toHaveValue(""); await expect(page.locator("#recover-password")).toHaveValue("");
});
test("invalid recovery remains generic at finish without falsely asserting verified identity", async ({ page }) => {
  const state = await memberFixture(page); state.recoveryInvalid = true; await recoveryStart(page, state);
  await page.locator("#recover-password").fill(state.password); await page.locator("#recover-confirm").fill(state.password);
  await clickSubmit(page, "recover-password-form"); await expect(page.locator("#recover-error")).toContainText("驗證未完成"); await expect(page.locator("#recover-success")).toBeHidden();
});
test("logged-in center displays safe profile, points/tier/gap/progress and owner cases", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); await page.goto("/#member");
  await expect(page.locator("#member-points")).toHaveText("123"); await expect(page.locator("#member-tier")).toHaveText("青銅");
  await expect(page.locator("#tier-gap")).toContainText("77"); await expect(page.locator("#tier-progress")).toHaveAttribute("value", "23");
  await page.locator("#member-cases button").click(); await expect(page.locator("#member-case-detail")).toContainText("已通過");
  expect((await page.locator("#member-content").innerText()).includes("private")).toBe(false);
  await page.locator("#member-cases-more").click(); await expect(page.locator("#member-cases-more")).toBeHidden();
  expect(state.calls.filter(call => call.path === "/api/me/points")).toHaveLength(1);
});
test("unconfigured tier shows honest fallback without invented thresholds", async ({ page }) => {
  await memberFixture(page, { authenticated: true, unconfigured: true }); await page.goto("/#member");
  await expect(page.locator("#tier-message")).toHaveText("會員等級門檻尚未設定"); await expect(page.locator("#tier-next")).toBeHidden();
});
test("profile mutation uses CSRF, validates fields and only sends nickname/player_id", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); await page.goto("/#member"); await expect(page.locator("#member-content")).toBeVisible();
  await page.locator("#profile-nickname").fill(" "); await clickSubmit(page, "profile-form"); await expect(page.locator("#profile-status")).toContainText("請填寫");
  await page.locator("#profile-nickname").fill("新暱稱"); await clickSubmit(page, "profile-form"); await expect(page.locator("#profile-status")).toHaveText("會員資料已保存。");
  const call = state.calls.find(call => call.path === "/api/me/profile"); expect(Object.keys(call.body).sort()).toEqual(["nickname", "player_id"]);
  expect(call.headers["x-csrf-token"] === state.csrf).toBe(true); expect(call.headers["x-voteproof-request"]).toBe("1");
});
test("revoked session logs out cleanly without polling or erasing Guest draft", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); await page.goto("/#submit"); await page.locator("#nickname").fill("未送出訪客");
  state.revoked = true; await page.locator("#member-entry").click(); await expect(page.locator("#member-gate")).toBeVisible(); await expect(page.locator("#login-entry")).toBeVisible();
  await page.locator(".bottom-nav a[href='#submit'],.sidebar nav a[href='#submit']").filter({ visible: true }).click(); await expect(page.locator("#nickname")).toHaveValue("未送出訪客");
  expect(state.calls.filter(call => call.path === "/api/auth/me").length).toBeLessThanOrEqual(2);
});
test("logout calls revoke API and clears member state", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); await page.goto("/#member"); await expect(page.locator("#member-points")).toHaveText("123");
  await page.locator("#logout-button").click(); await expect(page.locator("#login-entry")).toBeVisible(); expect(state.calls.filter(call => call.path.endsWith("logout"))).toHaveLength(1);
  await expect(page.locator("#member-cases")).toBeEmpty();
});
test("member upload retry pins transport/body/idempotency and never sends member_id", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); state.failCase = 1; await submission(page, true);
  await page.locator("#submit-button").click(); await expect(page.locator("#retry-note")).toBeVisible(); await expect(page.locator("#submission-mode")).toBeDisabled();
  await page.locator("#submit-button").click(); await expect(page.locator("#submission-success")).toBeVisible();
  const calls = state.calls.filter(call => call.path === "/api/cases"); expect(calls).toHaveLength(2);
  expect(calls[0].serialized === calls[1].serialized).toBe(true); expect(calls[0].headers["idempotency-key"] === calls[1].headers["idempotency-key"]).toBe(true);
  expect(calls.every(call => !("member_id" in call.body) && call.headers["x-csrf-token"] === state.csrf)).toBe(true); expect(state.puts).toBe(1);
});
test("logout during pending member case cannot retry as Guest", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); state.failCase = 1; await submission(page, true);
  await page.locator("#submit-button").click(); await expect(page.locator("#retry-note")).toBeVisible(); await page.locator("#logout-button").click();
  await page.locator("#submit-button").click(); await expect(page.locator("#submission-error")).toContainText("登入身份已改變");
  expect(state.calls.filter(call => call.path === "/api/cases")).toHaveLength(1); expect(state.puts).toBe(1);
});
test("auth/provider outage leaves Guest upload/lookup/public navigation usable", async ({ page }) => {
  const state = await memberFixture(page, { authDown: true }); await beginLogin(page, state); await clickSubmit(page, "login-form");
  await expect(page.locator("#login-error")).toContainText("會員服務暫時無法使用"); await submission(page);
  await page.locator("#submit-button").click(); await expect(page.locator("#submission-success")).toBeVisible();
  await page.locator("#lookup-created").click(); await page.locator("#lookup-button").click(); await expect(page.locator("#lookup-result")).toContainText("待審核");
  const create = state.calls.find(call => call.path === "/api/cases"); expect(create.headers["x-csrf-token"]).toBeUndefined();
});
test("auth sensitive values never enter storage/URL/logs; backend text remains inert", async ({ page }) => {
  const logs = []; page.on("console", message => logs.push(message.text()));
  const state = await memberFixture(page, { nickname: '<img src=x onerror="unsafe=1">' }); await recoveryCodes(page, state);
  const secrets = [state.password, state.manual, ...state.recoveryCodes];
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  expect(logs.some(log => secrets.some(secret => log.includes(secret)))).toBe(false); expect(secrets.some(secret => page.url().includes(secret))).toBe(false);
  await page.locator("#member-entry").click(); await expect(page.locator("#member-welcome img")).toHaveCount(0);
  expect(state.providerRequests).toEqual([]); await expect(page.locator("#recovery-codes")).toBeEmpty();
});
test("auth forms/member center fit 320/375/390/430/768/desktop, labels/focus/tap targets", async ({ page }) => {
  await memberFixture(page, { authenticated: true });
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const view of ["login", "register", "recover", "member"]) {
      await page.goto("/#" + view); await expect(page.locator("#view-" + view)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator(`#view-${view} label[for]`).evaluateAll(labels => labels.every(label => document.getElementById(label.htmlFor)))).toBe(true);
      expect(await page.locator(`#view-${view} input:not([type='checkbox'])`).evaluateAll(inputs => inputs.every(input => parseFloat(getComputedStyle(input).fontSize) >= 16))).toBe(true);
    }
  }
});

test("session expiry returns logged-out UI once while preserving Guest work", async ({ page }) => {
  await page.clock.install(); const state = await memberFixture(page, { authenticated: true, shortSession: true });
  await page.goto("/#submit"); await page.locator("#nickname").fill("保留草稿"); await page.clock.fastForward(1000);
  await expect(page.locator("#login-entry")).toBeVisible(); await expect(page.locator("#nickname")).toHaveValue("保留草稿");
  await expect(page.locator("#account-status")).toContainText("登入已失效"); expect(state.calls.filter(call => call.path === "/api/auth/me")).toHaveLength(1);
});
test("pagehide/BFCache cannot retain enrollment QR or one-time recovery codes", async ({ page }) => {
  const state = await memberFixture(page); await recoveryCodes(page, state);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(page.locator("#recovery-codes")).toBeEmpty(); await expect(page.locator("#enrollment-key")).toBeEmpty();
  expect(await page.locator("#enrollment-qr").evaluate(canvas => canvas.width)).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.locator("#register-email-form")).toBeVisible();
});
test("late enrollment response after navigation cannot reinsert secret/QR", async ({ page }) => {
  const state = await memberFixture(page); await startRegistration(page); await page.locator("#register-code").fill("001234"); await clickSubmit(page, "register-code-form");
  state.delay = true; await page.locator("#register-password").fill(state.password); await page.locator("#register-confirm").fill(state.password);
  await clickSubmit(page, "register-password-form"); await page.evaluate(() => { location.hash = "home"; });
  await expect(page.locator("#view-home")).toBeVisible(); await expect(page.locator("#enrollment-key")).toBeEmpty();
  expect(await page.locator("#enrollment-qr").evaluate(canvas => canvas.width)).toBe(0); await expect(page.locator("#register-password")).toHaveValue("");
});
test("explicit Guest mode omits auth cookies even when logged in", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); await submission(page);
  await page.locator("#submit-button").click(); await expect(page.locator("#submission-success")).toBeVisible();
  expect(await page.evaluate(() => globalThis.__transportFixture.filter(call => call.path === "/api/cases").every(call => call.credentials === "omit"))).toBe(true);
  expect(state.calls.find(call => call.path === "/api/cases").headers["x-csrf-token"]).toBeUndefined();
});
test("cross-tab account change during member retry cannot submit as another member", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); state.failCase = 1; await submission(page, true);
  await page.locator("#submit-button").click(); await expect(page.locator("#retry-note")).toBeVisible();
  state.member.member_id = "M-other-local-user"; await page.locator("#submit-button").click();
  await expect(page.locator("#submission-error")).toContainText("登入身份已改變"); expect(state.calls.filter(call => call.path === "/api/cases")).toHaveLength(1);
});
