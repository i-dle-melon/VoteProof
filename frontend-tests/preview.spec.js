import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { adminFixture } from "./admin-fixture.mjs";
import { memberFixture } from "./member-fixture.mjs";
const preview = "http://127.0.0.1:4174/VoteProof/";
test("Pages artifact is clearly preview before any JavaScript executes", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage(); await page.goto(preview);
  await expect(page.locator("#ui-preview-banner")).toBeVisible();
  await expect(page.locator("#ui-preview-banner")).toContainText("UI PREVIEW · 非正式網站");
  await expect(page.locator('#view-admin, #view-security, #admin-ui-copy, #login-totp-form')).toHaveCount(0);
  await context.close();
});
test("guest preview has no network API, OAuth, challenge, submissions or private data", async ({ page }) => {
  const requests = []; page.on("request", request => requests.push(request.url()));
  await page.goto(preview + "#login"); await expect(page.locator("#login-content")).toBeVisible();
  await expect(page.locator("#login-google")).toBeDisabled();
  await page.locator("#login-password-options").evaluate(e => { e.open = true; });
  await page.locator("#login-email").fill("preview@example.invalid"); await page.locator("#login-password").fill("preview-only-input");
  await page.locator("#login-form").evaluate(form => form.requestSubmit());
  await page.goto(preview + "#submit"); await expect(page.locator("#submit-button")).toBeDisabled();
  await expect(page.locator("#proof-images")).toBeDisabled();
  await page.goto(preview + "#leaderboards"); await expect(page.locator("#board-results")).toBeEmpty();
  expect(requests.some(url => new URL(url).pathname.includes("/api/") || new URL(url).hostname !== "127.0.0.1")).toBe(false);
  expect(page.url()).toContain("127.0.0.1:4174/VoteProof/");
});
test("preview blocks mutations at every transport even if controls are manipulated", async ({ page }) => {
  const requests = []; page.on("request", request => requests.push(request.url()));
  await page.goto(preview + "?ui=admin#admin"); await expect(page.locator("#view-home")).toBeVisible();
  const codes = await page.evaluate(async () => {
    const { api, putImage } = await import("./js/api.js");
    const { MemberSession } = await import("./js/pages-public-ui.js");
    const { Challenge } = await import("./js/turnstile.js");
    const session = new MemberSession();
    const operations = [
      () => api("/api/uploads/prepare", { method: "POST", body: {} }),
      () => api("/api/cases", { method: "POST", body: {} }),
      () => api("https://production.invalid/api/cases", { method: "POST", body: {} }),
      () => session.request("/api/auth/google/start", { method: "POST", body: { purpose: "login" } }),
      () => session.adminRequest("/api/admin/submissions/update", { method: "POST", body: { submissions_enabled: true } }),
      () => putImage({ upload_url: "https://proof.invalid/object", headers: {} }, new Blob(), () => {}),
      () => new Challenge(document.getElementById("challenge-widget"), () => {}).mount(),
    ];
    return Promise.all(operations.map(async operation => { try { await operation(); return "UNEXPECTED_SUCCESS"; } catch (error) { return error.code; } }));
  });
  expect(codes).toEqual(Array(7).fill("UI_PREVIEW_ONLY"));
  expect(requests.some(url => new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname.includes("/api/"))).toBe(false);
});
test("public artifact physically excludes protected screens and their modules", async ({ page, request }) => {
  for (const view of ["admin", "security", "member", "register", "recover", "google"]) {
    await page.goto(preview + "?ui=admin#" + view);
    await expect(page.locator("#view-home")).toBeVisible();
    await expect(page.locator('#view-admin, #view-security, #view-member, #admin-ui-copy, [data-preview-scene="admin"], [data-preview-scene="member"]')).toHaveCount(0);
  }
  for (const file of ["admin.js", "admin-api.js", "member.js", "member-api.js", "qr.js", "vendor/qrcode.js"]) expect((await request.get(preview + "js/" + file)).status()).toBe(404);
  const html = await (await request.get(preview)).text();
  expect(html).not.toMatch(/security-step-form|security-recovery-codes|admin-copy-\d|login-totp-form|turnstile-site-key/);
  expect(await page.evaluate(async () => {
    const { fixtureResponse } = await import('./js/preview-fixtures.js');
    return Promise.all(['/api/admin/me', '/api/admin/submissions', '/api/auth/login-security'].map(async path => (await fixtureResponse(path)).status));
  })).toEqual([403,403,403]);
});
test("Production source ignores ui query and never loads preview fixtures", async ({ page }) => {
  const state = await memberFixture(page); const loaded = []; page.on("request", request => loaded.push(request.url()));
  await page.goto("/?ui=admin#login"); await expect(page.locator("#login-content")).toBeVisible();
  await expect(page.locator("#ui-preview-banner")).toBeHidden(); await expect(page.locator("#admin-nav-group")).toBeHidden();
  await expect(page.locator("#login-google")).toBeEnabled();
  expect(loaded.some(url => url.includes("preview-fixtures.js"))).toBe(false);
  expect(state.calls.some(call => call.path === "/api/auth/me")).toBe(true);
});
test("operator can change HTML admin copy and nest view panels without editing logic", async ({ page }) => {
  const state = await adminFixture(page);
  let html = await readFile("public/index.html", "utf8");
  html = html.replace('<span id="admin-copy-018">活動管理</span>', '<span id="admin-copy-018">應援活動設定</span>');
  html = html.replace(/(<main\b[^>]*>)/, '$1<div class="operator-layout">').replace("</main>", "</div></main>");
  await page.route("http://127.0.0.1:4173/", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("/#admin"); await page.locator("#admin-tabs").getByRole("button", { name: "應援活動設定" }).click();
  await expect(page.locator("#admin-panel h2")).toHaveText("應援活動設定");
  await page.goto("/#leaderboards"); await expect(page.locator("#view-leaderboards")).toBeVisible(); await expect(page.locator("#view-admin")).toBeHidden();
  expect(state.calls.filter(call => call.method === "POST")).toHaveLength(0);
});
for (const width of [320, 390, 430, 1440]) test(`preview layouts fit ${width}px in dark/light including all tier artwork`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(preview); await expect(page.locator("#view-home")).toBeVisible();
  for (const theme of ["dark", "light"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme-toggle").click();
    for (const view of ["home", "submit", "lookup", "leaderboards", "login", "about"]) {
      await page.goto(preview + "#" + view);
      await expect(page.locator('#view-' + view)).toBeVisible();
      if (view === "about") {
        await expect(page.locator("#preview-tier-artwork img")).toHaveCount(8);
        expect(await page.locator("#preview-tier-artwork img").evaluateAll(images => images.every(image => image.src.includes("/VoteProof/assets/tiers/")))).toBe(true);
        expect(await page.locator("#preview-tier-artwork img").evaluateAll(async images => {
          // Explicitly load offscreen artwork; lazy images otherwise never
          // start decoding until the operator scrolls to them.
          images.forEach(image => { image.loading = "eager"; });
          await Promise.all(images.map(image => image.decode()));
          return images.every(image => image.complete && image.naturalWidth > 0);
        })).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: `.wrangler/frontend-previews/editable-preview-${testInfo.project.name}-${width}-${theme}.png`, fullPage: true });
  }
  await page.locator('[data-preview-scene="guest"]').click();
  await expect(page.locator("#login-content")).toBeVisible();
  await page.locator("#login-title").evaluate(node => { node.textContent = "手機長文案版型檢查".repeat(10); });
  await page.locator("#login-password-options").evaluate(node => { node.open = true; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (width < 980) await expect(page.locator(".bottom-nav")).toBeVisible();
});
