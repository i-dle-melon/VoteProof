import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { memberFixture } from "./member-fixture.mjs";
const preview = "http://127.0.0.1:4174/VoteProof/";
const ready = async (page) =>
  expect(page.locator("html")).toHaveAttribute("data-preview-ready", "true");
const scene = (values = {}, view = "home") =>
  preview +
  "?" +
  new URLSearchParams(Object.entries(values).map(([k, v]) => ["preview_" + k, v])) +
  "#" +
  view;
const control = async (page, key, value) => {
  await page.locator("#preview-controls").evaluate((d) => (d.open = true));
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get("preview_" + key) === value),
    page.locator("#preview-" + key).selectOption(value),
  ]);
  await ready(page);
};

test("banner exists before JS and Production has no preview control bar", async ({
  browser,
  page,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false }),
    plain = await context.newPage();
  await plain.goto(preview);
  await expect(plain.locator("#ui-preview-banner")).toContainText("全部是假資料");
  await context.close();
  await memberFixture(page);
  await page.goto("/?preview_identity=admin#login");
  await expect(page.locator("#ui-preview-banner")).toHaveCount(0);
  await expect(page.locator("#admin-nav-group")).toBeHidden();
  const loaded = [];
  page.on("request", (r) => loaded.push(r.url()));
  await page.reload();
  expect(
    loaded.some((u) => u.includes("preview-fixtures") || u.includes("pages-preview-state")),
  ).toBe(false);
});

test("normal member fixture fills shared Home, seven board buttons, own Cases and Security", async ({
  page,
}) => {
  const requests = [],
    errors = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(preview);
  await ready(page);
  await expect(page.locator("#home-personal")).toBeVisible();
  await expect(page.locator("#home-member-points")).toHaveText("420");
  await expect(page.locator("#home-member-rank")).toHaveText("#4");
  await page.goto(scene({}, "leaderboards"));
  await ready(page);
  await expect(page.locator("#board-categories button")).toHaveText([
    "歷史累計",
    "本次回歸",
    "團體排行",
    "Solo排行",
    "展示生日應援榜",
    "展示週末衝刺榜",
    "展示特別活動榜",
  ]);
  await expect(page.locator("#board-results tr")).toHaveCount(5);
  await expect(page.locator("#board-results .board-proof-count").first()).toBeVisible();
  await page.locator('[data-custom-board="PREVIEW-custom-three"]').click();
  await expect(page.locator("#board-name")).toHaveText("展示特別活動榜");
  await page.goto(scene({}, "lookup"));
  await ready(page);
  await expect(page.locator("#owned-cases button")).toHaveCount(5);
  await page.locator("#owned-cases button").nth(2).click();
  await expect(page.locator("#owned-case-fields")).toContainText("展示退件原因");
  await expect(page.locator("#lookup-key")).toHaveValue("");
  await page.goto(scene({}, "member"));
  await ready(page);
  await expect(page.locator("#member-points")).toHaveText("420");
  await expect(page.locator("#member-trusted-state")).toHaveText("1 個信任裝置");
  await expect(page.locator("#member-recovery-state")).toContainText("8");
  await expect(page.locator("#member-public-rank")).toHaveText("#4");
  await page.goto(scene({}, "security"));
  await ready(page);
  await expect(page.locator("#security-google")).toContainText("已連結");
  await expect(page.locator("#security-recovery-codes")).toBeEmpty();
  expect(errors).toEqual([]);
  expect(
    requests.some(
      (u) => ["http:","https:"].includes(new URL(u).protocol) && (new URL(u).hostname !== "127.0.0.1" || new URL(u).pathname.includes("/api/")),
    ),
  ).toBe(false);
});

test("preview controls change guest/member/admin, Gate, Empty/Error and theme", async ({
  page,
}) => {
  await page.goto(preview);
  await ready(page);
  await control(page, "identity", "guest");
  await expect(page.locator("#home-personal")).toBeHidden();
  await expect(page.locator("#admin-nav-group")).toBeHidden();
  await control(page, "gate", "off");
  await expect(page.locator("#home-submit-button")).toBeDisabled();
  await control(page, "gate", "on");
  await expect(page.locator("#home-submit-button")).toBeEnabled();
  await control(page, "identity", "admin");
  await expect(page.locator("#admin-content")).toBeVisible();
  await expect(page.locator(".admin-case-row")).toHaveCount(3);
  await control(page, "data", "empty");
  await expect(page.locator("#admin-panel")).toContainText("目前沒有符合條件的案件");
  await control(page, "data", "error");
  await expect(page.locator("#admin-status")).toContainText("暫時無法");
  await control(page, "data", "normal");
  await control(page, "theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("all Admin configuration and five exact-duplicate states use shared renderer", async ({
  page,
}) => {
  for (const analysis of ["pending", "processing", "clear", "exact_duplicate", "failed"]) {
    await page.goto(scene({ identity: "admin", analysis }, "admin"));
    await ready(page);
    await page
      .locator(".admin-case-row")
      .first()
      .getByRole("button", { name: "查看與審核", exact: true })
      .click();
    await expect(page.locator('[aria-label="檔案比對提示"]')).toContainText(
      {
        pending: "尚未分析",
        processing: "分析中",
        clear: "未發現相同檔案",
        exact_duplicate: "同會員同活動相同檔案",
        failed: "分析失敗",
      }[analysis],
    );
  }
  for (const label of ["活動管理", "排行榜管理", "會員等級", "投稿設定"]) {
    await page.locator("#admin-tabs").getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator("#admin-panel")).toContainText(label);
  }
  await page
    .locator("#admin-tabs")
    .getByRole("button", { name: "排行榜管理", exact: true })
    .click();
  await page
    .locator("#admin-panel .member-case")
    .nth(4)
    .getByRole("button", { name: "查看設定", exact: true })
    .click();
  await expect(page.locator("#admin-field-display_button")).toBeChecked();
  await expect(page.locator("#admin-field-name")).toHaveValue("展示生日應援榜");
});

test("mutation transport, proof URLs, auth and secrets remain impossible despite manipulated controls", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(scene({ identity: "admin" }, "admin"));
  await ready(page);
  const codes = await page.evaluate(async () => {
    const { api, putImage } = await import("./js/api.js"),
      { MemberSession } = await import("./js/member-api.js"),
      { Challenge } = await import("./js/turnstile.js");
    const session = new MemberSession();
    const operations = [
      () => api("/api/cases", { method: "POST", body: {} }),
      () => api("https://production.invalid/api/cases", { method: "POST" }),
      () => session.request("/api/auth/google/start", { method: "POST" }),
      () =>
        session.adminRequest("/api/admin/submissions/update", {
          method: "POST",
          body: { submissions_enabled: true },
        }),
      () => session.adminProof("https://proof.invalid/private"),
      () => putImage({ upload_url: "https://proof.invalid/private" }, new Blob(), () => {}),
      () => new Challenge(document.getElementById("challenge-widget")).waitForToken(),
    ];
    return Promise.all(
      operations.map(async (fn) => {
        try {
          await fn();
          return "UNEXPECTED_SUCCESS";
        } catch (e) {
          return e.code;
        }
      }),
    );
  });
  expect(codes).toEqual(Array(7).fill("UI_PREVIEW_ONLY"));
  await page.locator("#admin-tabs").getByRole("button", { name: "投稿設定", exact: true }).click();
  await page
    .locator("#admin-panel form")
    .evaluate((f) => f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await expect(page.locator("#preview-action-status")).toContainText("不會送出");
  expect(
    requests.some(
      (u) => ["http:","https:"].includes(new URL(u).protocol) && (new URL(u).hostname !== "127.0.0.1" || new URL(u).pathname.includes("/api/")),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => document.cookie)).toBe("");
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(["voteproof-theme"]);
  await expect(page.locator("#security-recovery-codes,#register-recovery-codes")).toBeEmpty();
});

for (const [submission, count] of [
  ["zero", 0],
  ["multi", 3],
  ["twenty", 20],
  ["uploading", 3],
  ["success", 0],
  ["failed", 3],
])
  test("submission fixture " + submission, async ({ page }) => {
    await page.goto(scene({ submission }, "submit"));
    await ready(page);
    await expect(page.locator("#image-list .image-item")).toHaveCount(count);
    if (submission === "twenty") {
      await page.goto(scene({ submission, gate: "off" }, "submit"));
      await ready(page);
      await expect(page.locator("#image-list .image-item")).toHaveCount(20);
      await expect(page.locator("#proof-images")).toBeDisabled();
    }
    if (submission === "uploading") {
      await expect(page.locator("#upload-progress")).toBeVisible();
      await expect(page.locator("#progress")).toHaveJSProperty("value", 47);
    }
    if (submission === "success") {
      await expect(page.locator("#submission-success")).toBeVisible();
      await expect(page.locator("#success-title")).toHaveText("3 個案件已送出");
      await expect(page.locator("#receipt-download")).toBeDisabled();
    }
    if (submission === "failed") {
      await expect(page.locator("#retry-note")).toBeVisible();
      await expect(page.locator("#submit-button")).toHaveText("重試本次投稿");
    }
  });

for (const width of [320, 390, 430, 1024, 1440])
  for (const theme of ["dark", "light"])
    test("preview responsive " + width + " " + theme, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      for (const view of [
        "home",
        "lookup",
        "leaderboards",
        "member",
        "security",
        "admin",
        "submit",
      ]) {
        await page.goto(scene({ identity: "admin", theme }, view));
        await ready(page);
        await expect(page.locator("#view-" + view)).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          view,
        ).toBe(true);
        if (view === "home") {
          await expect(page.locator(".hero-action-icon")).toHaveCount(3);
          await expect(page.locator(".hero-actions .btn-primary")).toHaveCSS(
            "color",
            "rgb(255, 255, 255)",
          );
        }
      }
      await page.locator("#preview-controls").evaluate((d) => (d.open = true));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    });
