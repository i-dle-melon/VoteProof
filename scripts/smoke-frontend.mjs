// Real disposable workerd/D1/R2 API + real browser public modules.
// Only this developer harness intercepts Turnstile/S3 transport. No deploy bypass.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { localCaseRuntime } from "./lib/local-case-runtime.mjs";
import { frontendServer } from "./lib/frontend-server.mjs";

const local = await localCaseRuntime({ seedCampaign: false, submissionsEnabled: false });
let server, browser;
try {
  await local.campaign({ name: "本機公開活動", campaign_timezone: "Asia/Taipei", points_per_proof: 10, daily_limit: null });
  await local.setAuthConfig({ AUTH_SECRET: undefined, AUTH_PASSWORD_PEPPER: undefined, AUTH_TOTP_ENCRYPTION_KEY: undefined });
  server = await frontendServer({ backend: local });
  await local.setAuthConfig({AUTH_ORIGIN:server.base});
  browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const nonce = randomBytes(24).toString("base64url");
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", (route) => route.fulfill({ contentType: "text/javascript", body:
    `let opts;globalThis.turnstile={render(container,o){opts=o;queueMicrotask(()=>o.callback(${JSON.stringify(nonce)}));return 'local';},reset(){queueMicrotask(()=>opts.callback(${JSON.stringify(nonce)}));}};` }));
  let putCount=0;
  await page.route('**/api/uploads/put/**',async route=>{const request=route.request();assert.equal(request.method(),'PUT');const response=await local.runtime.dispatchFetch(request.url(),{method:'PUT',headers:request.headers(),body:request.postDataBuffer()});assert.equal(response.status,200);putCount++;await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});});
  let lost = false; const requests = [];
  await page.route("**/api/cases", async (route) => {
    const request = route.request(); requests.push({ body: request.postData(), key: request.headers()["idempotency-key"] });
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    if (!lost) { lost = true; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await page.goto(server.base);
  await page.locator("#campaign-list .campaign-card").waitFor();
  assert.equal((await page.locator("#campaign-list").innerText()).includes("每日計分：不限次數"), true);
  assert.equal(await page.locator("#home-submit-button").isDisabled(), true);
  assert.equal(await page.locator("#home-campaign-state").innerText(), "活動進行中");
  assert.equal(await page.locator("#home-submission-state").innerText(), "投稿暫停");
  await mkdir(".wrangler/frontend-previews", { recursive: true });
  await page.screenshot({ path: ".wrangler/frontend-previews/desktop-home.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".wrangler/frontend-previews/mobile-home.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.goto(server.base + "/#submit");
  await page.locator("#submit-state").waitFor();
  assert.equal(await page.locator("#proof-images").isDisabled(), true);
  await page.evaluate(() => document.getElementById("submission-form").dispatchEvent(new Event("submit", { cancelable: true })));
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM cases").first()).n, 0);
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM completed_uploads").first()).n, 0);
  assert.equal(putCount, 0);
  // Explicit test fixture only. This harness never points at Production D1.
  await local.db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => !document.getElementById("proof-images").disabled);
  await page.locator("#nickname").fill("本機投稿驗收"); await page.locator("#player-id").fill("local-player");
  await page.locator("#vote-date").fill(new Date().toISOString().slice(0, 10));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=", "base64");
  await page.locator("#proof-images").setInputFiles([{ name: "proof-a.png", mimeType: "image/png", buffer: png }, { name: "proof-b.png", mimeType: "image/png", buffer: png }]);
  await page.locator("#submit-button").click(); await page.locator("#retry-note").waitFor();
  await page.locator("#submit-button").click(); await page.locator("#submission-success").waitFor();
  assert.equal(requests.length, 3); assert.equal(requests[0].body === requests[2].body, true); assert.equal(requests[0].key === requests[2].key, true);
  assert.notEqual(requests[0].key, requests[1].key);
  assert.equal(putCount, 2);
  const count = await local.db.prepare("SELECT COUNT(*) AS n FROM cases WHERE member_id IS NULL").first(); assert.equal(count.n, 2);
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM case_files").first()).n, 2);
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM case_idempotency").first()).n, 2);
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM completed_uploads WHERE consumed_case_id IS NOT NULL").first()).n, 2);
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM cases c WHERE (SELECT COUNT(*) FROM case_files f WHERE f.case_id=c.id)!=1").first()).n, 0);
  await page.locator("#batch-items button").first().click(); await page.locator("#lookup-button").click(); await page.locator("#lookup-result").waitFor();
  assert.equal((await page.locator("#lookup-result").innerText()).includes("待審核"), true);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(new URL(page.url()).search, "");
  assert.equal(local.unexpectedUpstreams.length, 0);
  console.log("Frontend smoke PASS: real Campaign/unlimited, OFF blocks uploads/cases, ON enables 2 signed PUTs, real HEAD/complete, lost 201 replay, TWO independent Guest cases, safe query, no auth secrets");
} finally { if (browser) await browser.close(); if (server) await server.close(); await local.runtime.dispose(); }
