import { test, expect } from "@playwright/test";
import { memberFixture } from "./member-fixture.mjs";
import { adminFixture } from "./admin-fixture.mjs";
import { TIER_ARTWORK } from "../public/js/tier-artwork.js";

const points = (tier_id, name) => ({ total_points: 123, tier: { tier_id, name }, next_tier: null, points_to_next_tier: null, tier_progress: 0, tier_configuration_ready: true });
const setTier = (page, id, name) => page.route("**/api/me/points", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: points(id, name) }) }));
const decoded = images => images.evaluateAll(rows => rows.every(img => img.complete && img.naturalWidth === Number(img.getAttribute("width")) && img.naturalHeight === Number(img.getAttribute("height"))));

for (const [id, art] of Object.entries(TIER_ARTWORK)) test(`member ${id} shows only the API current tier and matching artwork`, async ({ page }) => {
  const loaded = []; page.on('request', request => loaded.push(request.url()));
  await memberFixture(page, { authenticated: true }); await setTier(page, id, art.name); await page.goto('/#member');
  await expect(page.locator('#member-points')).toHaveText('123');
  await expect(page.locator('#member-tier')).toHaveText(art.name);
  await expect(page.locator('#member-tier').locator('..')).toHaveText('目前等級：' + art.name);
  const image = page.locator('#member-tier-artwork img'); await expect(image).toHaveAttribute('src', art.src);
  await expect.poll(() => decoded(image)).toBe(true);
  await expect(page.locator('#member-content .approved-tier-artwork')).toHaveCount(1);
  await expect(page.locator('#member-content .tier-card')).toHaveCount(0);
  await expect(page.locator('#tier-next')).toBeHidden();
  expect(loaded.filter(url => url.includes('/assets/tiers/')).every(url => new URL(url).pathname === art.src)).toBe(true);
});

test("all eight admin artworks retain disabled labels and fit themes and small screens", async ({ page }) => {
  const state = await adminFixture(page); const violations = [];
  await page.addInitScript(() => { globalThis.__tierCsp = []; document.addEventListener("securitypolicyviolation", e => globalThis.__tierCsp.push(e.effectiveDirective)); });
  await page.goto("/#admin"); await expect(page.locator("#admin-panel select")).toHaveCount(2);
  // WebKit reports style-src-attr for pre-existing native select internals.
  // Drain initial admin rendering, then assert the artwork introduces none.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => { globalThis.__tierCsp = []; });
  await page.locator("#admin-tabs").getByRole("button", { name: "會員等級", exact: true }).click();
  const cards = page.locator("#admin-panel .tier-card"), images = cards.locator("img");
  await expect(cards).toHaveCount(8); await expect.poll(() => decoded(images)).toBe(true);
  for (const [i, art] of Object.values(TIER_ARTWORK).entries()) {
    await expect(cards.nth(i).locator("img")).toHaveAttribute("src", art.src); await expect(cards.nth(i).locator("h3")).toHaveText(art.name);
    await expect(cards.nth(i).locator(".status")).toHaveText(i ? "未啟用" : "已啟用");
  }
  await expect(page.locator("#admin-panel").getByText("門檻尚未設定", { exact: true })).toHaveCount(7);
  for (const width of [1440, 320, 390, 430]) for (const theme of ["dark", "light"]) {
    await page.setViewportSize({ width, height: 600 });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme-toggle").evaluate(button => button.click());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await images.evaluateAll(rows => rows.every(img => Math.abs(img.getBoundingClientRect().width / img.getBoundingClientRect().height - img.naturalWidth / img.naturalHeight) < .01))).toBe(true);
  }
  expect(await page.evaluate(() => globalThis.__tierCsp)).toEqual(violations); expect(state.calls.some(c => c.method === "POST")).toBe(false);
  expect(state.tiers.filter(t => t.min_points === null)).toHaveLength(7);
});
test('unknown or missing tier metadata has a graceful fallback without a guessed badge', async ({ page }) => {
  await memberFixture(page, { authenticated: true });
  for (const tier of [null, undefined, {}, { tier_id: 'unknown', name: '無效等級' }, { tier_id: 'constructor' }]) {
    await page.route('**/api/me/points', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { total_points: 123, tier } }) }));
    await page.goto('/#member'); await page.reload();
    await expect(page.locator('#member-points')).toHaveText('123');
    await expect(page.locator('#member-tier')).toHaveText('暫時無法取得');
    await expect(page.locator('#member-content .approved-tier-artwork')).toHaveCount(0);
  }
});

test('unavailable current artwork preserves real tier text without a broken image', async ({ page }) => {
  await memberFixture(page, { authenticated: true }); await setTier(page, 'bronze', '青銅');
  await page.route('**/assets/tiers/bronze.webp', route => route.abort()); await page.goto('/#member');
  await expect(page.locator('#member-tier')).toHaveText('青銅');
  await expect(page.locator('#member-tier-artwork img')).toHaveCount(0);
});

test('10-point normal member displays only normal artwork across mobile widths and themes', async ({ page }, testInfo) => {
  await memberFixture(page, { authenticated: true });
  await page.route('**/api/me/points', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { ...points('normal', '普通'), total_points: 10, tier_configuration_ready: false } }) }));
  await page.goto('/#member');
  await expect(page.locator('#member-points')).toHaveText('10');
  await expect(page.locator('#member-tier')).toHaveText('普通');
  const image = page.locator('#member-tier-artwork img'); await expect(image).toHaveAttribute('src', '/assets/tiers/normal.webp');
  await expect.poll(() => decoded(image)).toBe(true);
  for (const width of [1440, 320, 390, 430]) for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 844 });
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').evaluate(button => button.click());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#member-content .approved-tier-artwork')).toHaveCount(1);
    await expect(page.locator('#member-content .tier-card')).toHaveCount(0);
    await expect(page.locator('#tier-next')).toBeHidden();
    await expect(page.locator('#tier-message')).toHaveText('升級門檻尚未設定');
    expect(await image.evaluate(img => Math.abs(img.getBoundingClientRect().width / img.getBoundingClientRect().height - img.naturalWidth / img.naturalHeight) < .01)).toBe(true);
    if (width === 390) await page.screenshot({ path: `.wrangler/frontend-previews/current-member-tier-${testInfo.project.name}-${theme}.png`, fullPage: true });
  }
});

test('configured upgrade progress appears on refresh without rendering the next tier artwork', async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true });
  let summary = { ...points('normal', '普通'), total_points: 10, tier_configuration_ready: false };
  await page.route('**/api/me/points', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: summary }) }));
  await page.goto('/#member');
  await expect(page.locator('#tier-message')).toHaveText('升級門檻尚未設定');
  await expect(page.locator('#tier-next')).toBeHidden();
  summary = { total_points: 10, tier: { tier_id: 'normal', name: '普通', min_points: 0, rank_order: 1 },
    next_tier: { tier_id: 'bronze', name: '青銅', min_points: 100, rank_order: 2 }, tier_configuration_ready: true };
  await page.locator('#member-refresh').click();
  await expect(page.locator('#tier-next')).toBeVisible();
  await expect(page.locator('#tier-points')).toHaveText('10 / 100 點');
  await expect(page.locator('#tier-gap')).toHaveText('距離「青銅」還差 90 點');
  await expect(page.locator('#tier-progress')).toHaveAttribute('value', '10');
  await expect(page.locator('#tier-message')).toBeEmpty();
  await expect(page.locator('#member-tier-artwork img')).toHaveAttribute('src', '/assets/tiers/normal.webp');
  await expect(page.locator('#member-content .approved-tier-artwork')).toHaveCount(1);
  for (const width of [320, 390, 430]) for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 844 });
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').evaluate(button => button.click());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#tier-next')).toBeVisible();
  }
  expect(state.calls.some(call => call.method !== 'GET')).toBe(false);
});

test('highest configured enabled tier has an honest message without a progress bar', async ({ page }) => {
  await memberFixture(page, { authenticated: true });
  await page.route('**/api/me/points', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: {
    ...points('stellar', '星耀'), total_points: 1000, tier: { tier_id: 'stellar', name: '星耀', min_points: 700, rank_order: 8 },
  } }) }));
  await page.goto('/#member');
  await expect(page.locator('#tier-message')).toHaveText('已達目前最高等級');
  await expect(page.locator('#tier-next')).toBeHidden();
  await expect(page.locator('#member-tier-artwork img')).toHaveAttribute('src', '/assets/tiers/stellar.webp');
  await expect(page.locator('#member-content .approved-tier-artwork')).toHaveCount(1);
});

test("leaderboard without tier metadata does not infer artwork or fetch member tiers", async ({ page }) => {
  const state = await memberFixture(page);
  const leaderboard = { leaderboard_id: "LOCAL-ART-BOARD", name: "本機排行榜", generated_at: new Date().toISOString(), rankings: [{ rank: 1, member_id: "LOCAL-MEMBER", nickname: "本機會員", points: 123, proof_count: 1 }] };
  await page.route("**/api/leaderboards*", route => {
    state.calls.push({ path: new URL(route.request().url()).pathname, method: "GET" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { leaderboards: [leaderboard] } }) });
  });
  await page.goto("/#leaderboards"); await expect(page.locator("#board-name")).toHaveText(leaderboard.name);
  await expect(page.locator("#view-leaderboards .approved-tier-artwork")).toHaveCount(0);
  expect(state.calls.some(c => c.path.includes("member-tiers") || c.path === "/api/me/points")).toBe(false);
});
