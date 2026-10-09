// Real frontend/Worker/D1 cookies, mock provider only. No live config read.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
import { TOTP, Secret } from "otpauth";
import { localCaseRuntime } from "./lib/local-case-runtime.mjs";
import { frontendServer } from "./lib/frontend-server.mjs";
const local = await localCaseRuntime();
let browser, server;
try {
  server = await frontendServer(); browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext(), page = await context.newPage(), origin = "https://voteproof.example";
  const email = randomBytes(12).toString("hex") + "@local.example", password = randomBytes(24).toString("base64url"), messages = [];
  page.on("console", message => messages.push(message.text()));
  await page.route(origin + "/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) { const response = await context.request.get(server.base + url.pathname); await route.fulfill({ response }); return; }
    const response = await local.runtime.dispatchFetch(request.url(), { method: request.method(), redirect: "manual", headers: request.headers(), ...(["GET","HEAD"].includes(request.method()) ? {} : { body: request.postData() }) });
    const headers = Object.fromEntries(response.headers), cookies = response.headers.getSetCookie();
    if (cookies.length) headers["set-cookie"] = cookies.join("\n");
    await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.route(local.provider.config.SUPABASE_URL + "/auth/v1/authorize?**", async route => {
    // Provider fixture performs pre-return automatic linking and issues a code
    // bound to the REAL server's PKCE challenge. No real upstream request.
    const flow = local.provider.oauth(route.request().url(), email);
    await route.fulfill({ status: 302, headers: { Location: origin + flow.path }, body: "" });
  });
  const submit = id => page.locator(`#${id} button[type='submit']`).click();
  await page.goto(origin + "/#login"); await page.locator("#login-google").click(); await page.locator("#google-profile").waitFor();
  await page.locator("#google-nickname").fill("雙登入驗收"); await page.locator("#google-player").fill("local-player"); await submit("google-confirm-form"); await page.locator("#member-content").waitFor();
  const member = await page.locator("#member-id").textContent();
  assert.equal((await local.db.prepare("SELECT count(*) n FROM members").first()).n, 1);
  assert.equal((await local.db.prepare("SELECT count(*) n FROM member_credentials").first()).n, 0);
  assert.equal(local.provider.mails.length, 0);
  await page.locator("a[href='#security']").click(); await page.locator("#security-add").waitFor(); await page.locator("#security-add").click(); await page.locator("#security-add-confirm").click(); await page.locator("#security-password-form").waitFor();
  const secret = await page.locator("#security-key").textContent(), otp = new TOTP({ secret: Secret.fromBase32(secret) });
  await page.locator("#security-new-password").fill(password); await page.locator("#security-confirm-password").fill(password); await page.locator("#security-code").fill(otp.generate()); await submit("security-password-form"); await page.locator("#security-recovery").waitFor();
  const recovery = await page.locator("#security-recovery-codes li").allTextContents(); assert.equal(recovery.length, 10);
  assert.equal(await page.locator("#security-done").isDisabled(), true); await page.locator("#security-recovery-ack").check(); await page.locator("#security-done").click();
  assert.equal((await local.db.prepare("SELECT password_enabled FROM auth_identities WHERE member_id=?").bind(member).first()).password_enabled, 1);
  await page.locator("#logout-button").click(); await page.locator("#login-form").waitFor();
  await page.locator("#login-google").click(); await page.locator("#google-confirm-form").waitFor(); assert.equal(await page.locator("#google-profile").isVisible(), false); await submit("google-confirm-form"); await page.locator("#member-content").waitFor();
  assert.equal(await page.locator("#member-id").textContent(), member); await page.locator("#logout-button").click(); await page.locator("#login-form").waitFor();
  await page.locator("#login-email").fill(email); await page.locator("#login-password").fill(password); await submit("login-form"); await page.locator("#login-totp-form").waitFor();
  await page.locator("#login-totp").fill(otp.generate({ timestamp: Date.now() + 30000 })); await submit("login-totp-form"); await page.locator("#member-content").waitFor();
  assert.equal(await page.locator("#member-id").textContent(), member); assert.equal((await local.db.prepare("SELECT count(*) n FROM members").first()).n, 1);
  const cookies = await context.cookies(origin); assert.ok(cookies.filter(c => c.name.startsWith("__Host-")).every(c => c.httpOnly && c.secure && c.sameSite === "Lax"));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  const secrets = [password, secret, ...recovery, ...local.provider.tokens]; assert.equal(messages.some(m => secrets.some(s => m.includes(s))), false); assert.equal(local.unexpectedUpstreams.length, 0);
  console.log("B4G frontend smoke PASS: real PKCE callback/state/Secure cookies/profile; Google-only without MFA/mail; same-member add password/TOTP/recovery; both logins same member; no browser provider tokens/log leakage; disposable local fixtures only");
} finally { if (browser) await browser.close(); if (server) await server.close(); await local.runtime.dispose(); }
