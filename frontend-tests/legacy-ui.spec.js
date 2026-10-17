import { test, expect } from "@playwright/test";
import { memberFixture } from "./member-fixture.mjs";

test("legacy header uses theme, real session status and avatar without demo mode", async ({ page }) => {
  const state = await memberFixture(page); await page.goto("/#login");
  await expect(page.locator("#login-entry")).toHaveText("訪客模式");
  await expect(page.locator("#top-avatar")).toHaveText("G");
  expect(await page.locator(".topbar-right").evaluate(row => row.firstElementChild.id)).toBe("theme-toggle");
  await page.locator("#theme-toggle").click(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("#theme-toggle")).toHaveAccessibleName("切換深色");
  await expect(page.locator("#admin-nav-group")).toBeHidden();
  expect(state.calls.filter(call => call.method === "POST")).toHaveLength(0);
});

test("legacy upload panel retains real limits and OFF cannot open any upload flow", async ({ page }) => {
  const state = await memberFixture(page, { submissionsOff: true }); await page.goto("/#submit");
  await expect(page.locator(".submission-check-note")).toContainText("檔案格式與大小");
  await expect(page.locator("#proof-dropzone")).toContainText("點擊選擇圖片，或拖曳到這裡");
  await expect(page.locator("#image-help")).toContainText("5 MiB");
  await expect(page.locator("#proof-images")).toBeDisabled(); await expect(page.locator("#submit-button")).toBeDisabled();
  await expect(page.locator("#recent-cases-status")).toContainText("登入後");
  expect(state.calls.some(call => call.path === "/api/me/cases" || call.path.startsWith("/api/uploads/"))).toBe(false);
  expect(await page.locator("#view-submit").innerText()).not.toMatch(/示範上限|前端初版|可能與既有證明重複/);
});

test("recent submissions and member cases use owned API rows in the legacy list", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true }); await page.goto("/#submit");
  await expect(page.locator("#recent-cases .row")).toHaveCount(1);
  await expect(page.locator("#recent-cases")).toContainText(state.caseId);
  await expect(page.locator("#recent-cases .status")).toHaveText("已通過");
  await expect(page.locator("#top-avatar")).toHaveText("本");
  await page.goto("/#member"); await expect(page.locator("#member-cases .row")).toHaveCount(1);
  await expect(page.locator("#member-record-total")).toHaveText("123");
  await expect(page.locator(".points-record-card")).toContainText("點數異動明細");
  await page.locator("#logout-button").click(); await expect(page.locator("#recent-cases")).toBeEmpty();
  await expect(page.locator("#member-record-total")).toHaveText("—");
});

test("legacy leaderboard tabs, rows and pinned position use only published snapshots", async ({ page }, testInfo) => {
  const state = await memberFixture(page, { authenticated: true });
  const boards = [
    { leaderboard_id: "LOCAL-HISTORY", name: "歷史累計", generated_at: "2026-10-10T00:00:00Z", rankings: [
      { rank: 1, member_id: "LOCAL-OTHER", nickname: "本機榜首", points: 400, proof_count: 40 },
      { rank: 7, member_id: state.member.member_id, nickname: state.member.nickname, points: 123, proof_count: 12 }] },
    { leaderboard_id: "LOCAL-SOLO", name: "Solo排行", generated_at: "2026-10-10T00:00:00Z", rankings: [] },
  ];
  await page.route("**/api/leaderboards*", route => {
    const id = new URL(route.request().url()).searchParams.get("id");
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { leaderboards: id ? boards.filter(b => b.leaderboard_id === id) : boards } }) });
  });
  await page.goto("/#leaderboards"); await expect(page.locator("#leader-tabs button")).toHaveCount(2);
  await expect(page.locator("#board-results .rank-badge")).toHaveText(["1", "7"]);
  await expect(page.locator("#board-member-rank")).toHaveText("#7");
  for (const width of [1440, 390, 320]) for (const theme of ["dark", "light"]) {
    await page.setViewportSize({ width, height: 844 });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme-toggle").click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.wrangler/frontend-previews/legacy-leaderboard-${testInfo.project.name}-${width}-${theme}.png`, fullPage: true });
  }
  await page.locator("#leader-tabs").getByRole("button", { name: "Solo排行" }).click();
  await expect(page.locator("#board-name")).toHaveText("Solo排行");
  await expect(page.locator("#board-member-rank")).toHaveText("—");
  await expect(page.locator("#board-position-message")).toContainText("尚未列入");
  await expect(page.locator("#boards-message")).toContainText("還沒有成績");
  await page.locator("#logout-button").click(); await expect(page.locator("#board-position-content")).toBeHidden();
  await expect(page.locator("#board-member-name")).toBeEmpty();
});

test("legacy leaderboard has no invented categories or rows when no boards exist", async ({ page }) => {
  const state = await memberFixture(page); await page.goto("/#leaderboards");
  await expect(page.locator("#boards-message")).toHaveText("目前沒有公開排行榜。");
  await expect(page.locator("#leader-tabs")).toBeEmpty(); await expect(page.locator("#board-results")).toBeEmpty();
  await expect(page.locator("#board-position-login")).toBeVisible();
  expect(state.calls.some(call => call.path.startsWith("/api/me/"))).toBe(false);
});
