// Real disposable workerd/D1/R2 API + real browser public modules.
// Only this developer harness intercepts Turnstile/S3 transport. No deploy bypass.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { AwsClient } from "aws4fetch";
import { localCaseRuntime } from "./lib/local-case-runtime.mjs";
import { frontendServer } from "./lib/frontend-server.mjs";

const local = await localCaseRuntime();
let server, browser;
try {
  await local.setAuthConfig({ AUTH_SECRET: undefined, AUTH_PASSWORD_PEPPER: undefined, AUTH_TOTP_ENCRYPTION_KEY: undefined, AUTH_ORIGIN: undefined });
  server = await frontendServer({ backend: local });
  browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const nonce = randomBytes(24).toString("base64url");
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", (route) => route.fulfill({ contentType: "text/javascript", body:
    `let opts;globalThis.turnstile={render(container,o){opts=o;queueMicrotask(()=>o.callback(${JSON.stringify(nonce)}));return 'local';},reset(){queueMicrotask(()=>opts.callback(${JSON.stringify(nonce)}));}};` }));
  const config = local.authConfig;
  const signer = new AwsClient({ accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  let putCount = 0;
  await page.route(/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\//, async (route) => {
    const request = route.request(), url = new URL(request.url());
    const signature = url.searchParams.get("X-Amz-Signature"); url.searchParams.delete("X-Amz-Signature");
    const type = request.headers()["content-type"];
    const expected = await signer.sign(url, { method: request.method(), headers: { "Content-Type": type }, aws: { signQuery: true, allHeaders: true } });
    assert.equal(new URL(expected.url).searchParams.get("X-Amz-Signature") === signature, true, "Local PUT signature mismatch");
    assert.equal(request.method(), "PUT"); assert.equal(type, "image/png");
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    assert.equal(key.startsWith("proofs/staging/"), true);
    await local.bucket.put(key, request.postDataBuffer(), { httpMetadata: { contentType: type } }); putCount++;
    await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": server.base }, body: "" });
  });
  let lost = false; const requests = [];
  await page.route("**/api/cases", async (route) => {
    const request = route.request(); requests.push({ body: request.postData(), key: request.headers()["idempotency-key"] });
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    if (!lost) { lost = true; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await page.goto(server.base);
  await page.locator("#campaign-list .campaign-card").waitFor();
  await mkdir(".wrangler/frontend-previews", { recursive: true });
  await page.screenshot({ path: ".wrangler/frontend-previews/desktop-home.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".wrangler/frontend-previews/mobile-home.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.goto(server.base + "/#submit");
  await page.locator("#nickname").fill("本機投稿驗收"); await page.locator("#player-id").fill("local-player");
  await page.locator("#vote-date").fill(new Date().toISOString().slice(0, 10));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=", "base64");
  await page.locator("#proof-images").setInputFiles([{ name: "proof-a.png", mimeType: "image/png", buffer: png }, { name: "proof-b.png", mimeType: "image/png", buffer: png }]);
  await page.locator("#submit-button").click(); await page.locator("#retry-note").waitFor();
  await page.locator("#submit-button").click(); await page.locator("#submission-success").waitFor();
  assert.equal(requests.length, 2); assert.equal(requests[0].body === requests[1].body, true); assert.equal(requests[0].key === requests[1].key, true);
  assert.equal(putCount, 2);
  const count = await local.db.prepare("SELECT COUNT(*) AS n FROM cases WHERE member_id IS NULL").first(); assert.equal(count.n, 1);
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM case_files").first()).n, 2);
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM case_idempotency").first()).n, 1);
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM completed_uploads WHERE consumed_case_id IS NOT NULL").first()).n, 1);
  await page.locator("#lookup-created").click(); await page.locator("#lookup-button").click(); await page.locator("#lookup-result").waitFor();
  assert.equal((await page.locator("#lookup-result").innerText()).includes("待審核"), true);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(new URL(page.url()).search, "");
  assert.equal(local.unexpectedUpstreams.length, 0);
  console.log("Frontend smoke PASS: static UI, 2 signed PUTs, real HEAD/complete, lost 201 replay, ONE Guest case, safe query, no auth secrets");
} finally { if (browser) await browser.close(); if (server) await server.close(); await local.runtime.dispose(); }
