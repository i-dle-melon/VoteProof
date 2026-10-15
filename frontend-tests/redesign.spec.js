import { test, expect } from "@playwright/test";
import { memberFixture, png } from "./member-fixture.mjs";
import { adminFixture } from "./admin-fixture.mjs";

test("four default categories append configured custom buttons and preserve honest empty states", async ({
  page,
}) => {
  await memberFixture(page);
  const boards = [
    ["history", "all_time", null],
    ["comeback", "campaign", "Solo"],
    ["group", "all_time", "團體"],
    ["solo", "all_time", "Solo"],
    ["custom-a", "custom", null],
    ["custom-b", "custom", null],
  ].map(([id, type, vote_type]) => ({
    leaderboard_id: id,
    name: "公開 " + id,
    type,
    vote_type,
    campaign_id: type === "campaign" ? "LOCAL" : null,
    rankings: [
      { rank: 7, nickname: "公開暱稱", points: 42, proof_count: 2, tier: { tier_id: "silver" } },
    ],
  }));
  await page.route("**/api/leaderboards*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { leaderboards: boards } }),
    }),
  );
  await page.goto("/#leaderboards");
  await expect(page.locator("#board-categories button")).toHaveText([
    "歷史累計",
    "本次回歸",
    "團體排行",
    "Solo排行",
    "公開 custom-a",
    "公開 custom-b",
  ]);
  await page.locator("[data-category=comeback]").click();
  await expect(page.locator("#board-name")).toHaveText("公開 comeback");
  await page.locator("[data-category=solo]").click();
  await expect(page.locator("#leader-tabs button:visible")).toHaveText([
    "公開 solo",
  ]);
  await page.locator("[data-custom-board=custom-b]").click();
  await expect(page.locator("#board-name")).toHaveText("公開 custom-b");
  await expect(page.locator("#board-results")).toContainText("7");
  await expect(page.locator("#board-results")).toContainText("42 點");
  boards.splice(1, 1);
  await page.locator("#boards-refresh").click();
  await page.locator("[data-category=comeback]").click();
  await expect(page.locator("#boards-message")).toContainText("目前沒有公開排行榜");
  await expect(page.locator("#board-table")).toBeHidden();
  boards.splice(0);
  await page.locator("#boards-refresh").click();
  await expect(page.locator("#board-categories button")).toHaveText([
    "歷史累計",
    "本次回歸",
    "團體排行",
    "Solo排行",
  ]);
});

test("admin custom button name and display switch persist without publishing invented scores", async ({
  page,
}) => {
  const state = await adminFixture(page);
  Object.assign(state.boards[0], {
    type: "custom",
    name: "尚未啟用",
    is_public: false,
    start_date: "2026-01-01",
    end_date: "2026-12-31",
  });
  await page.route("**/api/leaderboards*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          leaderboards: [],
          custom_boards: state.boards
            .filter((b) => b.type === "custom" && b.is_public && b.status === "active")
            .map(({ leaderboard_id, name, type, campaign_id, vote_type }) => ({
              leaderboard_id,
              name,
              type,
              campaign_id,
              vote_type,
            })),
        },
      }),
    }),
  );
  await page.goto("/#leaderboards");
  await expect(page.locator("#board-categories button")).toHaveCount(4);
  await page.goto("/admin");
  await page
    .locator("#admin-tabs")
    .getByRole("button", { name: "排行榜管理", exact: true })
    .click();
  await page.locator("#admin-panel").getByRole("button", { name: "查看設定", exact: true }).click();
  await expect(page.getByLabel("排行榜名稱 / 按鈕顯示名稱", { exact: true })).toBeVisible();
  await page.locator("#admin-field-name").fill("生日應援榜");
  await page.getByRole("switch", { name: "開啟顯示該排行按鈕", exact: true }).check();
  await page
    .locator("#admin-panel")
    .getByRole("button", { name: "保存排行榜", exact: true })
    .click();
  await expect(page.locator("#admin-panel")).toContainText("生日應援榜");
  expect(state.boards[0].is_public).toBe(true);
  await page.goto("/#leaderboards");
  await expect(page.locator("#board-categories button")).toHaveCount(5);
  await page.locator("[data-custom-board=BOARD]").click();
  await expect(page.locator("#boards-message")).toContainText("還沒有成績");
  await page.goto("/admin");
  await page
    .locator("#admin-tabs")
    .getByRole("button", { name: "排行榜管理", exact: true })
    .click();
  await page.locator("#admin-panel").getByRole("button", { name: "查看設定", exact: true }).click();
  await page.getByRole("switch", { name: "開啟顯示該排行按鈕", exact: true }).uncheck();
  await page
    .locator("#admin-panel")
    .getByRole("button", { name: "保存排行榜", exact: true })
    .click();
  await expect(page.locator("#admin-panel")).toHaveAttribute("aria-busy", "false");
  expect(state.boards[0].is_public).toBe(false);
  await page.goto("/#leaderboards");
  await expect(page.locator("#board-categories button")).toHaveCount(4);
  expect(state.calls.some((c) => c.path.endsWith("/rebuild") && c.method === "POST")).toBe(false);
});

test("whole own case row opens safe detail without query credentials", async ({ page }) => {
  const state = await memberFixture(page, { authenticated: true });
  await page.goto("/#lookup");
  const row = page.locator("#owned-cases button").first();
  await expect(row).toBeVisible();
  await row.getByText(state.caseId, { exact: false }).click();
  await expect(page.locator("#owned-case-detail")).toBeVisible();
  await expect(page.locator("#owned-case-fields")).toContainText(state.caseId);
  await expect(page.locator("#lookup-key")).toHaveValue("");
  expect(state.calls.some((c) => c.path === "/api/me/cases/" + state.caseId)).toBe(true);
  expect(state.calls.some((c) => c.path.startsWith("/api/cases/"))).toBe(false);
  await page.goto("/#submit");
  await page.locator("#recent-cases button").first().click();
  await expect(page.locator("#owned-case-detail")).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
});

test("admin quick review preselects action and waits for the existing confirmation form", async ({
  page,
}) => {
  const state = await adminFixture(page);
  await page.goto("/admin");
  await expect(page.locator("#admin-case-list")).toHaveCount(0);
  await page.getByRole("button", { name: "全部案件", exact: true }).click();
  await expect(page.locator("#admin-panel")).toHaveAttribute("aria-busy", "false");
  await page.locator(".admin-case-row").getByRole("button", { name: "駁回", exact: true }).click();
  await expect(page.locator("#admin-panel select[name=action]")).toHaveValue("reject");
  expect(state.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  await page
    .locator("#admin-panel")
    .getByRole("button", { name: "收合", exact: true })
    .click();
  await page
    .locator(".admin-status-tabs")
    .getByRole("button", { name: "待審核", exact: true })
    .click();
  await expect(page.locator("#admin-field-filter-status")).toHaveValue("pending");
  await expect(page.locator("#admin-panel")).toHaveAttribute("aria-busy", "false");
  await page.locator("#admin-field-filter-search").fill("不存在的暱稱");
  await expect(page.locator(".admin-case-row")).toBeHidden();
  await page.locator("#admin-field-filter-search").fill(state.cases[0].player_id);
  await expect(page.locator(".admin-case-row")).toBeVisible();
});

test("receipt download preserves RAM credentials without visible DOM, URL or storage exposure", async ({
  page,
}) => {
  const state = await memberFixture(page, { authenticated: true });
  await page.goto("/#submit");
  await page.locator("#vote-date").fill(new Date().toISOString().slice(0, 10));
  await page
    .locator("#proof-images")
    .setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: png });
  await expect(page.locator("#challenge-status")).toHaveText("已完成人機驗證");
  await page.locator("#submit-button").click();
  await expect(page.locator("#submission-success")).toBeVisible();
  await page.locator("#success-query-info > summary").click();
  await expect(page.locator("#receipt-download")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.locator("#receipt-download").click();
  const download = await downloading;
  const stream = await download.createReadStream(),
    chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString("utf8").includes(state.query)).toBe(true);
  expect((await page.locator("body").innerText()).includes(state.query)).toBe(false);
  expect(page.url().includes(state.query)).toBe(false);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("help dialog traps focus, closes on Escape and returns focus", async ({ page }) => {
  await memberFixture(page);
  await page.goto("/");
  const trigger = page.locator("#workflow-help");
  await trigger.click();
  await expect(page.locator("#workflow-dialog")).toBeVisible();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      document.querySelector("#workflow-dialog").contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("#workflow-dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const width of [320, 390, 430, 768, 1024, 1440])
  for (const theme of ["dark", "light"])
    test(`responsive ${width} ${theme}: views fit and mobile retains five tabs`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await adminFixture(page);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript((value) => localStorage.setItem("voteproof-theme", value), theme);
      for (const view of [
        "home",
        "submit",
        "lookup",
        "leaderboards",
        "member",
        "security",
        "admin",
      ]) {
        await page.goto("/#" + view);
        await expect(page.locator("#view-" + view)).toBeVisible();
        if (view === "admin") await expect(page.locator(".admin-case-row")).toBeVisible();
        if (view === "lookup")
          await expect(page.locator("#owned-cases button").first()).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          view,
        ).toBe(true);
      }
      if (width <= 980) {
        await expect(page.locator(".bottom-nav a")).toHaveCount(5);
        await expect(page.locator(".bottom-nav a[data-view=admin]")).toHaveCount(0);
      }
      expect(errors).toEqual([]);
    });
