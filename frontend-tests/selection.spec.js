import { test, expect } from "@playwright/test";
import { memberFixture, png } from "./member-fixture.mjs";

const files = (count, offset = 0) => Array.from({ length: count }, (_, index) => ({
  name: `selected-${offset + index}.png`, mimeType: "image/png", buffer: png,
}));

async function setup(page) {
  const state = await memberFixture(page, { authenticated: true });
  // Selection must work even when no human-verification response exists yet.
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", route => route.fulfill({
    contentType: "text/javascript", body: "globalThis.turnstile={render(){return 'local';},reset(){}};",
  }));
  await page.goto("/#submit");
  await expect(page.locator("#submission-fields")).toBeEnabled();
  // Editable fields may now stay enabled during a refresh. Wait for initial
  // gate/campaign loading to finish before deliberately holding the next check.
  await expect(page.locator("#campaign-refresh")).toBeEnabled();
  await expect(page.locator("#submit-button")).toBeEnabled();
  return state;
}

async function holdGate(page, { enabled = true, fail = false } = {}) {
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { entered = resolve; });
  await page.route("**/api/submissions/status", async route => {
    entered(); await pending;
    if (fail) await route.abort();
    else await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      ok: true, data: { submissions_enabled: enabled, submissions_message: enabled ? null : "測試暫停投稿" },
    }) });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await requested;
  await expect(page.locator("#submit-button")).toBeDisabled();
  return release;
}

async function drop(page, count) {
  await page.locator("#proof-dropzone").evaluate((element, { count, bytes }) => {
    const data = new DataTransfer();
    for (let index = 0; index < count; index++) data.items.add(new File([new Uint8Array(bytes)], `drop-${index}.png`, { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, { count, bytes: [...png] });
}

function noUploads(state) {
  expect(state.calls.filter(call => call.path.startsWith("/api/uploads/") || call.path === "/api/cases")).toEqual([]);
  expect(state.puts).toBe(0);
}

test("picker preserves all 20 files across focus revalidation before human verification", async ({ page }) => {
  const state = await setup(page), release = await holdGate(page);
  try {
    // Keeping the existing picker enabled also avoids browser-suppressed change events.
    await expect(page.locator("#proof-images")).toBeEnabled();
    await page.locator("#proof-images").setInputFiles(files(20));
    await expect(page.locator("#image-list .image-item")).toHaveCount(0);
    await expect(page.locator("#image-error")).toContainText("確認後會載入");
    // A synthetic submit cannot overtake the pending selection or upload anything.
    await page.locator("#submission-form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    noUploads(state);
    release();
    await expect(page.locator("#image-list .image-item")).toHaveCount(20);
    await expect(page.locator("#image-error")).toBeEmpty();
    await expect(page.locator("#challenge-status")).not.toHaveText("已完成人機驗證");
    noUploads(state);
  } finally { release(); }
});

test("dropping files during a visibility recheck loads them after ON without waiting for a challenge", async ({ page }) => {
  const state = await setup(page), release = await holdGate(page);
  try {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await drop(page, 20);
    await expect(page.locator("#image-list .image-item")).toHaveCount(0);
    release();
    await expect(page.locator("#image-list .image-item")).toHaveCount(20);
    noUploads(state);
  } finally { release(); }
});

test("rapid 16 plus 4 selections are serialized; a genuine 21st file gives count context", async ({ page }) => {
  const state = await setup(page), release = await holdGate(page);
  try {
    await page.locator("#proof-images").setInputFiles(files(16));
    await page.locator("#proof-images").setInputFiles(files(4, 16));
    release();
    await expect(page.locator("#image-list .image-item")).toHaveCount(20);
    await page.locator("#proof-images").setInputFiles(files(1, 20));
    await expect(page.locator("#image-error")).toContainText("已選 20 張，本次新增 1 張");
    await expect(page.locator("#image-list .image-item")).toHaveCount(20);
    const names = await page.locator("#image-list .image-item p:first-of-type").allTextContents();
    expect(names).toEqual(files(20).map(file => file.name));
    noUploads(state);
  } finally { release(); }
});

for (const fail of [false, true]) test(`${fail ? "failed" : "OFF"} recheck discards queued new files, preserves existing files, and blocks uploads`, async ({ page }) => {
  const state = await setup(page);
  await page.locator("#proof-images").setInputFiles(files(1));
  await expect(page.locator("#image-list .image-item")).toHaveCount(1);
  const release = await holdGate(page, { enabled: false, fail });
  try {
    await drop(page, 1);
    await page.locator("#proof-images").setInputFiles(files(1, 1));
    release();
    await expect(page.locator("#image-error")).toContainText(fail ? "暫時無法使用" : "測試暫停投稿");
    await expect(page.locator("#image-list .image-item")).toHaveCount(1);
    await expect(page.locator("#proof-images")).toBeDisabled();
    await expect(page.locator("#submit-button")).toBeDisabled();
    await page.locator("#submission-form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    noUploads(state);
  } finally { release(); }
});

test("clicking the file picker can select 20 at once before human verification", async ({ page }) => {
  const state = await setup(page);
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator("#proof-images").click();
  const chooser = await chooserPromise;
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles(files(20));
  await expect(page.locator("#image-list .image-item")).toHaveCount(20);
  await expect(page.locator("#image-error")).toBeEmpty();
  noUploads(state);
});

test("selection also waits for an in-flight campaign refresh without losing files", async ({ page }) => {
  const state = await setup(page);
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { entered = resolve; });
  await page.route("**/api/campaigns", async route => { entered(); await pending; await route.fallback(); });
  try {
    await page.locator('[data-view="home"]').first().evaluate(link => link.click());
    await expect(page.locator("#view-home")).toBeVisible();
    await page.locator("#campaign-refresh").click();
    await requested;
    await page.locator('[data-view="submit"]').first().evaluate(link => link.click());
    await expect(page.locator("#view-submit")).toBeVisible();
    await page.locator("#proof-images").setInputFiles(files(20));
    await expect(page.locator("#image-list .image-item")).toHaveCount(0);
    await expect(page.locator("#submit-button")).toBeDisabled();
    release();
    await expect(page.locator("#image-list .image-item")).toHaveCount(20);
    await expect(page.locator("#image-error")).toBeEmpty();
    noUploads(state);
  } finally { release(); }
});

test("unsupported photo MIME is explained without guessing a format or starting uploads", async ({ page }) => {
  const state = await setup(page);
  await page.locator("#proof-images").setInputFiles({ name: "local-photo.heic", mimeType: "image/heic", buffer: png });
  await expect(page.locator("#image-error")).toContainText("只接受 PNG、JPEG 或 WebP");
  await expect(page.locator("#image-list .image-item")).toHaveCount(0);
  noUploads(state);
});
