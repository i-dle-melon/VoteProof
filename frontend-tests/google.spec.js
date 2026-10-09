import { test, expect } from "@playwright/test";
import { memberFixture } from "./member-fixture.mjs";
const submit = (page, id) => page.locator(`#${id} button[type='submit']`).click();
test("provider cancellation returns to usable login and removes the fixed notice from URL", async ({ page }) => {
  const state = await memberFixture(page); await page.goto("/?auth_notice=google_cancelled#login");
  await expect(page.locator("#login-error")).toContainText("Google 登入已取消");
  await expect(page).toHaveURL(/\/#login$/); expect(state.authenticated).toBe(false);
  await page.goto("/#home"); await expect(page.locator("#view-home")).toBeVisible();
});
test("unknown provider notice cannot reflect untrusted text", async ({ page }) => {
  await memberFixture(page);
  for (const notice of ["untrusted-provider-message", "toString", "__proto__"]) {
    await page.goto("/?auth_notice=" + notice + "#login");
    await expect(page.locator("#login-error")).toHaveText(""); await expect(page).toHaveURL(/\/#login$/);
  }
});
test("login and registration expose two distinct authentication choices", async ({ page }) => {
  await memberFixture(page); await page.goto("/#login"); await expect(page.locator("#login-google")).toBeVisible(); await expect(page.locator("#login-form")).toBeVisible();
  await page.goto("/#register"); await expect(page.locator("#register-google")).toBeVisible(); await expect(page.locator("#view-register")).toContainText("不需要 VoteProof 密碼");
});
test("Google start navigates with no client provider credentials or password", async ({ page }) => {
  const state = await memberFixture(page); await page.goto("/#login"); await page.locator("#login-google").click();
  await expect(page.locator("#google-confirm-form")).toBeVisible(); const start = state.calls.find(c => c.path === "/api/auth/google/start");
  expect(start.body).toEqual({ purpose: "login" }); expect(start.headers["x-voteproof-request"]).toBe("1"); await expect(page.locator("#google-profile")).toBeVisible();
});
test("Google-only registration requests profile without password TOTP or recovery", async ({ page }) => {
  const state = await memberFixture(page); await page.goto("/#google"); await expect(page.locator("#google-profile")).toBeVisible();
  await page.locator("#google-nickname").fill("新Google會員"); await page.locator("#google-player").fill("player"); await submit(page, "google-confirm-form");
  await expect(page.locator("#member-content")).toBeVisible(); const call = state.calls.find(c => c.path === "/api/auth/google/confirm"); expect(call.body.nickname).toBe("新Google會員"); expect(call.body.password).toBeUndefined();
  expect(state.calls.some(c => /verify-totp|register\/start/.test(c.path))).toBe(false);
});
test("same-email confirmation truthfully states provider already linked", async ({ page }) => {
  const state = await memberFixture(page, { googleResult: "GOOGLE_CONFIRM_REQUIRED" }); await page.goto("/#google");
  await expect(page.locator("#google-message")).toContainText("Supabase 已連結"); await expect(page.locator("#google-message")).toContainText("取消只停止");
  await expect(page.locator("#google-email")).toHaveText("google@local.example"); await expect(page.locator("#google-profile")).toBeHidden();
  await submit(page, "google-confirm-form"); await expect(page.locator("#member-id")).toHaveText(state.member.member_id);
});
test("cancel does not claim provider unlink or create a VoteProof session", async ({ page }) => {
  const state = await memberFixture(page, { googleResult: "GOOGLE_CONFIRM_REQUIRED" }); await page.goto("/#google"); await expect(page.locator("#google-confirm-form")).toBeVisible();
  await page.locator("#google-cancel").click(); await expect(page.locator("#view-login")).toBeVisible(); expect(state.authenticated).toBe(false); expect(state.calls.some(c => c.path.endsWith("google/confirm"))).toBe(false);
});
test("existing Google login needs no VoteProof TOTP", async ({ page }) => {
  const state = await memberFixture(page, { googleResult: "GOOGLE_LOGIN_READY", googleOnly: true }); await page.goto("/#google"); await expect(page.locator("#google-confirm-form")).toBeVisible(); await submit(page, "google-confirm-form");
  await expect(page.locator("#member-content")).toBeVisible(); expect(state.calls.some(c => c.path.endsWith("/login/totp"))).toBe(false);
});
test("Google-only security shows Google and unconfigured password", async ({ page }) => {
  await memberFixture(page, { authenticated: true, googleOnly: true }); await page.goto("/#security");
  await expect(page.locator("#security-google")).toContainText("已連結"); await expect(page.locator("#security-password")).toContainText("尚未設定"); await expect(page.locator("#security-totp")).toContainText("一般 Google 登入不需要"); await expect(page.locator("#security-add")).toBeVisible();
});
test("password-only security shows connect Google and existing Authenticator", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); await page.goto("/#security"); await expect(page.locator("#security-connect")).toBeVisible(); await expect(page.locator("#security-totp")).toContainText("已設定");
  await page.locator("#security-connect").click(); await expect(page.locator("#security-link-notice")).toContainText("相同已驗證信箱"); expect(state.calls.some(c => c.path.endsWith("google/start"))).toBe(false);
  await page.locator("#security-link-cancel").click(); await expect(page.locator("#security-link-notice")).toBeHidden();
});
test("authenticated Google link requires explicit confirmation before OAuth", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true, googleResult: "GOOGLE_CONFIRM_REQUIRED" }); await page.goto("/#security"); await expect(page.locator("#security-connect")).toBeVisible(); await page.locator("#security-connect").click(); await page.locator("#security-link-confirm").click();
  await expect(page.locator("#google-confirm-form")).toBeVisible(); const call = state.calls.find(c => c.path.endsWith("google/start")); expect(call.body).toEqual({ purpose: "connect", confirmed: true }); expect(call.headers["x-csrf-token"] === state.csrf).toBe(true);
});
test("dual security keeps both methods and password TOTP rule", async ({ page }) => {
  await memberFixture(page, { authenticated: true, dual: true }); await page.goto("/#security"); await expect(page.locator("#security-password")).toContainText("已設定"); await expect(page.locator("#security-totp")).toContainText("密碼登入"); await expect(page.locator("#security-add")).toBeHidden(); await expect(page.locator("#security-change")).toBeVisible();
});
test("add password requires consent then local TOTP and recovery acknowledgement", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true, googleOnly: true }); await page.goto("/#security"); await expect(page.locator("#security-add")).toBeVisible(); await page.locator("#security-add").click();
  await expect(page.locator("#security-add-notice")).toContainText("同一會員"); expect(state.calls.some(c => c.path.endsWith("password/add/start"))).toBe(false);
  await page.locator("#security-add-confirm").click(); await expect(page.locator("#security-password-form")).toBeVisible(); expect(await page.locator("#security-key").textContent() === state.manual).toBe(true);
  await page.locator("#security-new-password").fill(state.password); await page.locator("#security-confirm-password").fill(state.password); await page.locator("#security-code").fill("001234"); await submit(page, "security-password-form");
  await expect(page.locator("#security-recovery")).toBeVisible(); await expect(page.locator("#security-key")).toHaveText(""); await expect(page.locator("#security-recovery-codes li")).toHaveCount(10); await expect(page.locator("#security-done")).toBeDisabled();
  await page.locator("#security-recovery-ack").check(); await page.locator("#security-done").click(); await expect(page.locator("#security-password")).toContainText("已設定"); await expect(page.locator("#security-recovery-codes li")).toHaveCount(0);
});
test("unfinished setup erases secret and password when leaving security", async ({ page }) => {
  await memberFixture(page, { authenticated: true, googleOnly: true }); await page.goto("/#security"); await expect(page.locator("#security-add")).toBeVisible(); await page.locator("#security-add").click(); await page.locator("#security-add-confirm").click(); await expect(page.locator("#security-password-form")).toBeVisible();
  await page.locator("#security-new-password").fill("temporary-value"); await page.goto("/#home"); await expect(page.locator("#security-key")).toHaveText(""); await expect(page.locator("#security-new-password")).toHaveValue("");
});
test("verified email matching Google offers same-account password confirmation", async ({ page }) => {
  const state = await memberFixture(page, { emailMatchesGoogle: true, googleOnly: true }); await page.goto("/#register"); await expect(page.locator("#register-challenge-status")).toHaveText("已完成人機驗證"); await page.locator("#register-email").fill("google@local.example"); await submit(page, "register-email-form"); await expect(page.locator("#register-code-form")).toBeVisible(); await page.locator("#register-code").fill("001234"); await submit(page, "register-code-form");
  await expect(page.locator("#security-add-notice")).toBeVisible(); await expect(page.locator("#security-password")).toContainText("不會建立第二個"); expect(state.calls.some(c => c.path.endsWith("register/credentials"))).toBe(false); await page.locator("#security-add-confirm").click(); await expect(page.locator("#security-password-form")).toBeVisible();
  expect(state.calls.find(c => c.path.endsWith("password/add/start")).body.transaction_id).toBeTruthy();
});
test("Google failure displays safe error and leaves Guest navigation available", async ({ page }) => {
  await memberFixture(page, { googleDown: true }); await page.goto("/#login"); await page.locator("#login-google").click(); await expect(page.locator("#login-error")).toContainText("暫時無法使用"); await page.goto("/#submit"); await expect(page.locator("#submission-fields")).toBeEnabled();
});
test("verified Google email is rendered as text not markup", async ({ page }) => {
  await memberFixture(page, { googleEmail: "<img src=x onerror=alert(1)>@local.example" }); await page.goto("/#google"); await expect(page.locator("#google-email")).toContainText("<img"); await expect(page.locator("#google-email img")).toHaveCount(0);
});
test("Google-assisted password change does not bypass password and TOTP", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true, dual: true }); await page.goto("/#security"); await expect(page.locator("#security-change")).toBeVisible(); await page.locator("#security-change").click(); await expect(page.locator("#security-change-form")).toContainText("Google 登入不會略過");
  await page.locator("#security-current-password").fill(state.password); await page.locator("#security-change-code").fill("001234"); await page.locator("#security-change-password").fill(state.password); await page.locator("#security-change-confirm").fill(state.password); await submit(page, "security-change-form"); await expect(page.locator("#view-login")).toBeVisible(); expect(state.calls.some(c => c.path.endsWith("step-up"))).toBe(true);
});
test("320px Google/security enrollment and long email do not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 }); await memberFixture(page, { authenticated: true, googleOnly: true, googleEmail: "a".repeat(64) + "@local.example" }); await page.goto("/#google"); await expect(page.locator("#google-email")).toContainText("@local.example");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto("/#security"); await expect(page.locator("#security-add")).toBeVisible(); await page.locator("#security-add").click(); await page.locator("#security-add-confirm").click(); await expect(page.locator("#security-password-form")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("security session expiry clears private email and enrollment", async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(Date.now()); await memberFixture(page, { authenticated: true, googleOnly: true, shortSession: true }); await page.goto("/#security"); await expect(page.locator("#security-google")).toContainText("google@local.example");
  await page.clock.fastForward(1000); await expect(page.locator("#security-google")).toHaveText(""); await expect(page.locator("#security-key")).toHaveText("");
});
