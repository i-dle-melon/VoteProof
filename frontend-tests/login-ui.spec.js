import { test, expect } from "@playwright/test";
import { memberFixture } from "./member-fixture.mjs";

const disclosure = page => page.locator("#login-password-options summary");

test("Google is the primary first-screen choice, password is collapsed and copy is public", async ({ page }) => {
  await memberFixture(page); await page.goto("/#login");
  await expect(page.locator("#login-title")).toHaveText("登入");
  await expect(page.locator("#view-login .sub")).toHaveText("登入後可管理你的會員資料與投稿紀錄");
  await expect(page.locator("#login-google")).toBeVisible();
  await expect(page.locator("#login-google")).toHaveClass(/btn-primary/);
  await expect(page.locator("#login-google svg")).toHaveCount(1);
  await expect(page.locator("#login-form")).toBeHidden();
  expect(await page.locator("#login-password-options").evaluate(node => node.open)).toBe(false);
  expect(await page.locator("#login-google").evaluate(node => {
    const rect = node.getBoundingClientRect(), secondary = document.querySelector("#login-password-options").getBoundingClientRect();
    return rect.height >= 48 && rect.bottom <= innerHeight && rect.top < secondary.top;
  })).toBe(true);
  await expect(page.locator("#view-login")).not.toContainText(/Apple|LINE|Facebook|Passkey|Supabase|OAuth|Cloudflare|AES|SSL SECURE/i);
  await expect(page.locator(".login-legal")).toHaveText("繼續使用即代表你同意服務條款與隱私政策。");
  await expect(page.locator(".login-legal a")).toHaveCount(0);
});

test("disclosure preserves password-manager fields, remember choice and visibility across toggles/app return", async ({ page }) => {
  const state = await memberFixture(page); await page.goto("/#login"); await disclosure(page).click();
  await page.locator("#login-email").fill("local@example.com"); await page.locator("#login-password").fill(state.password);
  await page.locator("#login-remember").check(); await page.locator('[data-password="login-password"]').click();
  await disclosure(page).click(); await expect(page.locator("#login-form")).toBeHidden();
  await disclosure(page).click();
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.locator("#login-email")).toHaveValue("local@example.com"); await expect(page.locator("#login-password")).toHaveValue(state.password);
  await expect(page.locator("#login-password")).toHaveAttribute("type", "text"); await expect(page.locator("#login-remember")).toBeChecked();
  await expect(page.locator("#login-email")).toHaveAttribute("autocomplete", "username");
  await expect(page.locator("#login-password")).toHaveAttribute("autocomplete", "current-password");
  await expect(page.locator("#login-password")).toHaveAttribute("name", "password");
  expect(state.calls.some(call => call.path === "/api/auth/login")).toBe(false);
});

test("disclosure supports keyboard and links to existing registration/recovery", async ({ page }) => {
  await memberFixture(page); await page.goto("/#login"); await disclosure(page).focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#login-form")).toBeVisible(); await page.keyboard.press("Space"); await expect(page.locator("#login-form")).toBeHidden();
  await disclosure(page).click(); await page.locator('.login-secondary-links a[href="#register"]').click();
  await expect(page.locator("#register-email-form")).toBeVisible();
  await page.goto("/#login"); await disclosure(page).click(); await page.locator('.login-secondary-links a[href="#recover"]').click();
  await expect(page.locator("#recover-proof-form")).toBeVisible();
});

test("authenticated login visits show member center, including a repeated login route", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); await page.goto("/#login");
  await expect(page).toHaveURL(/#member$/); await expect(page.locator("#member-id")).toHaveText(state.member.player_id);
  await expect(page.locator("#member-id")).not.toContainText(state.member.member_id);
  await expect(page.locator("#login-content")).toBeHidden();
  await page.evaluate(() => { location.hash = "login"; });
  await expect(page).toHaveURL(/#member$/); await expect(page.locator("#login-form")).toBeHidden();
});

test("login stays hidden while the initial session probe is pending", async ({ page }) => {
  const state = await memberFixture(page); let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route("**/api/auth/me", async route => {
    await pending;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { member: state.member, csrf_token: state.csrf, expires_in: 600 } }) });
  });
  try {
    await page.goto("/#login"); await expect(page.locator("#login-session-status")).toBeVisible();
    await expect(page.locator("#login-content")).toBeHidden(); release();
    await expect(page).toHaveURL(/#member$/); await expect(page.locator("#member-content")).toBeVisible();
  } finally { release(); }
});

test("password MFA keeps its transaction on app return and restart reopens password entry", async ({ page }) => {
  const state = await memberFixture(page); await page.goto("/#login"); await disclosure(page).click();
  await page.locator("#login-email").fill("local@example.com"); await page.locator("#login-password").fill(state.password);
  await page.locator('#login-form button[type="submit"]').click(); await expect(page.locator("#login-totp-form")).toBeVisible();
  await expect(page.locator("#login-methods")).toBeHidden(); await page.locator("#login-totp").fill("001234");
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
  await expect(page.locator("#login-totp")).toHaveValue("001234");
  await page.locator("#login-restart").click(); await expect(page.locator("#login-form")).toBeVisible();
  await expect(page.locator("#login-totp-form")).toBeHidden(); await expect(page.locator("#login-totp")).toHaveValue("");
});

test("login fits narrow screens, expanded short viewport and both existing themes", async ({ page }, testInfo) => {
  await memberFixture(page); await page.goto("/#login"); await expect(page.locator("#login-google")).toBeVisible();
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator("#login-google").evaluate(node => node.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
    }
    await page.screenshot({ path: `.wrangler/frontend-previews/login-${testInfo.project.name}-${theme}.png`, fullPage: true });
  }
  await disclosure(page).click(); await page.setViewportSize({ width: 320, height: 400 });
  expect(await page.locator("#login-form input:not([type=checkbox])").evaluateAll(inputs => inputs.every(node => parseFloat(getComputedStyle(node).fontSize) >= 16))).toBe(true);
  for (const selector of ["#login-email", "#login-password", '#login-form button[type="submit"]']) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    expect(await page.locator(selector).evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
  }
});

test("login adds no inline scripts/styles or new CSP violations", async ({ page, browserName }) => {
  const violations = [];
  await page.addInitScript(() => { document.addEventListener("securitypolicyviolation", event => {
    (globalThis.__loginCsp ??= []).push({ directive: event.effectiveDirective, blocked: event.blockedURI, line: event.lineNumber });
  }); });
  page.on("pageerror", error => violations.push(error.message));
  await memberFixture(page); const response = await page.goto("/#login"); await expect(page.locator("#login-google")).toBeVisible(); await disclosure(page).click();
  expect(response.headers()["content-security-policy"]).not.toContain("unsafe-inline");
  expect(await page.locator("#view-login").evaluate(node => [...node.querySelectorAll("*")].every(el => [...el.attributes].every(attr => !/^on/i.test(attr.name) && attr.name !== "style")))).toBe(true);
  await expect(page.locator("script:not([src])")).toHaveCount(0); await expect(page.locator("#login-google img")).toHaveCount(0);
  const reported = await page.evaluate(() => globalThis.__loginCsp ?? []);
  // WebKit reports its generated native select styles against style-src-attr.
  // These existing controls are outside Login. Never allow script CSP
  // violations or broadly ignore style violations introduced by this view.
  const nativeSelectLines = (await response.text()).split(/\r?\n/).flatMap((line, index) =>
    /<select id="(?:submission-mode|campaign|vote-type|board-select|solo-target-filter)"/.test(line) ? [index + 1] : []);
  const existingSelectReport = item => browserName === "webkit" && item.directive === "style-src-attr" && item.blocked === "inline" && nativeSelectLines.includes(item.line);
  expect(reported.filter(item => !existingSelectReport(item))).toEqual([]);
  expect(reported.filter(existingSelectReport).length).toBeLessThanOrEqual(nativeSelectLines.length); expect(violations).toEqual([]);
});
