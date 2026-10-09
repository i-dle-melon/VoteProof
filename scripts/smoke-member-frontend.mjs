// Real static modules + Worker auth/cases/ledger + disposable D1/R2.
// HTTPS .example is routed entirely locally so secure HttpOnly cookies are
// exercised without a production host, provider credential or auth bypass.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { TOTP, Secret } from "otpauth";
import { AwsClient } from "aws4fetch";
import { mkdir } from "node:fs/promises";
import { localCaseRuntime } from "./lib/local-case-runtime.mjs";
import { frontendServer } from "./lib/frontend-server.mjs";
const local = await localCaseRuntime();
let server, browser;
try {
  server = await frontendServer(); browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), origin = "https://voteproof.example";
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} } }); });
  const clientRequests = [], consoleMessages = [], caseAttempts = []; let lost = false, puts = 0;
  page.on("request", request => clientRequests.push(new URL(request.url()).hostname));
  page.on("console", message => consoleMessages.push(message.text()));
  await page.route(origin + "/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) {
      const response = await context.request.get(server.base + url.pathname);
      await route.fulfill({ response }); return;
    }
    const response = await local.runtime.dispatchFetch(request.url(), {
      method: request.method(), headers: request.headers(),
      ...(["GET", "HEAD"].includes(request.method()) ? {} : { body: request.postData() }),
    });
    const cookies = response.headers.getSetCookie();
    const headers = Object.fromEntries(response.headers);
    if (cookies.length) headers["set-cookie"] = cookies.join("\n");
    if (url.pathname === "/api/cases") {
      caseAttempts.push({ body: request.postData(), key: request.headers()["idempotency-key"] });
      assert.equal(response.status, 201, "Real Member case status");
      if (!lost) { lost = true; await route.abort(); return; }
    }
    await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", route => route.fulfill({ contentType: "text/javascript", body:
    "let i=0;const widgets=new Map();globalThis.turnstile={render(container,opts){const id=String(i++);widgets.set(id,opts);queueMicrotask(()=>opts.callback('isolated-smoke'));return id;},reset(id){queueMicrotask(()=>widgets.get(id).callback('isolated-smoke'));}};" }));
  const config = local.authConfig, signer = new AwsClient({ accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  await page.route(/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\//, async route => {
    const request = route.request(), url = new URL(request.url()), signature = url.searchParams.get("X-Amz-Signature");
    url.searchParams.delete("X-Amz-Signature");
    const type = request.headers()["content-type"], signed = await signer.sign(url, { method: request.method(), headers: { "Content-Type": type }, aws: { signQuery: true, allHeaders: true } });
    assert.equal(new URL(signed.url).searchParams.get("X-Amz-Signature") === signature, true);
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    await local.bucket.put(key, request.postDataBuffer(), { httpMetadata: { contentType: type } }); puts++;
    await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": origin }, body: "" });
  });
  const submit = id => page.locator(`#${id} button[type='submit']`).click();
  const email = randomBytes(12).toString("hex") + "@local.example", password = randomBytes(24).toString("base64url");
  await page.goto(origin + "/#register");
  await page.locator("#register-email").fill(email); await submit("register-email-form"); await page.locator("#register-code-form").waitFor();
  await page.locator("#register-code").fill(local.provider.codeFor(email)); await submit("register-code-form"); await page.locator("#register-password-form").waitFor();
  await page.locator("#register-password").fill(password); await page.locator("#register-confirm").fill(password); await submit("register-password-form"); await page.locator("#register-totp-form").waitFor();
  const secret = await page.locator("#enrollment-key").textContent(), otp = new TOTP({ secret: Secret.fromBase32(secret), algorithm: "SHA1", digits: 6, period: 30 });
  await page.locator("#register-totp").fill(otp.generate()); await page.locator("#register-trust").check(); await submit("register-totp-form"); await page.locator("#register-recovery").waitFor();
  const recoveryCodes = await page.locator("#recovery-codes li").allTextContents(); assert.equal(recoveryCodes.length, 10);
  const cookies = await context.cookies(origin), sessionCookie = cookies.find(cookie => cookie.name === "__Host-vp-session");
  assert.ok(sessionCookie?.httpOnly && sessionCookie.secure && sessionCookie.sameSite === "Lax");
  assert.equal(await page.evaluate(() => document.cookie.includes("__Host-vp-session")), false);
  assert.equal(await page.locator("#enrollment-key").textContent(), "");
  await page.locator("#recovery-ack").check(); await page.locator("#registration-done").click(); await page.locator("#register-success a").click(); await page.locator("#points-content").waitFor();
  assert.equal(await page.locator("#member-points").textContent(), "0"); assert.equal(await page.locator("#tier-message").textContent(), "會員等級門檻尚未設定");
  await page.locator("#profile-nickname").fill("本機會員驗收"); await page.locator("#profile-player").fill("local-player"); await submit("profile-form");
  await page.locator("#profile-status").filter({ hasText: "已保存" }).waitFor();
  await page.goto(origin + "/#submit"); await page.locator("#submission-mode").selectOption("member");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=", "base64");
  await page.locator("#proof-images").setInputFiles({ name: "local.png", mimeType: "image/png", buffer: png });
  await page.locator("#submit-button").click(); await page.locator("#retry-note").waitFor(); await page.locator("#submit-button").click(); await page.locator("#submission-success").waitFor();
  assert.equal(puts, 1); assert.equal(caseAttempts.length, 2);
  assert.equal(caseAttempts[0].body === caseAttempts[1].body, true); assert.equal(caseAttempts[0].key === caseAttempts[1].key, true);
  assert.equal("member_id" in JSON.parse(caseAttempts[0].body), false);
  const memberId = (await local.db.prepare("SELECT member_id FROM members").first()).member_id;
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM cases WHERE member_id=?").bind(memberId).first()).n, 1);
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM case_idempotency").first()).n, 1);
  await page.locator("#lookup-created").click(); await page.locator("#lookup-button").click(); await page.locator("#lookup-result").waitFor();
  assert.ok((await page.locator("#lookup-result").innerText()).includes("待審核"));
  await page.locator("#member-entry").click(); await page.locator("#member-cases button").waitFor();
  await mkdir(".wrangler/frontend-previews", { recursive: true });
  // Member center has only disposable public-profile/points/case metadata.
  await page.screenshot({ path: ".wrangler/frontend-previews/mobile-member.png", fullPage: true });
  await page.locator("#logout-button").click(); await page.locator("#login-form").waitFor();
  await page.locator("#login-email").fill(email); await page.locator("#login-password").fill(password); await submit("login-form"); await page.locator("#points-content").waitFor();
  assert.equal(await page.locator("#login-totp-form").isHidden(), true, "Real trusted-device password login");
  await page.goto(origin + "/#recover"); await page.locator("#recover-email").fill(email);
  await page.locator("#recover-totp").fill(otp.generate({ timestamp: Date.now() + 30000 })); await page.locator("#recover-code").fill(recoveryCodes[0]);
  await submit("recover-proof-form"); await page.locator("#recover-password-form").waitFor();
  const replacement = randomBytes(24).toString("base64url"); await page.locator("#recover-password").fill(replacement); await page.locator("#recover-confirm").fill(replacement);
  await submit("recover-password-form"); await page.locator("#recover-success").waitFor();
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL").first()).n, 0);
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM trusted_devices WHERE revoked_at IS NULL").first()).n, 0);
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL").first()).n, 1);
  await page.locator("#recover-success a").click(); await page.locator("#login-email").fill(email); await page.locator("#login-password").fill(replacement); await submit("login-form"); await page.locator("#login-totp-form").waitFor();
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(clientRequests.some(host => host.includes("supabase") || host.endsWith("googleapis.com")), false);
  assert.equal(consoleMessages.some(message => [password, replacement, secret, ...recoveryCodes].some(value => message.includes(value))), false);
  assert.equal(local.unexpectedUpstreams.length, 0);
  console.log("Member frontend smoke PASS: real registration/email/TOTP, secure cookies, profile, ledger/tier, signed PUT/HEAD, ONE Member case/lost-201 replay, Guest query, trusted login, recovery/revoke, fresh MFA required; disposable local fixtures only");
} finally { if (browser) await browser.close(); if (server) await server.close(); await local.runtime.dispose(); }
