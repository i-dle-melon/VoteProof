import { test, expect } from "@playwright/test";
const origin = "http://127.0.0.1:4174";
async function backup(page, scenario = "normal", role = "admin") {
  await page.goto(
    origin + "/VoteProof/?preview_identity=" + role + "&preview_storage=" + scenario + "#admin",
  );
  await expect(page.locator("html")).toHaveAttribute("data-preview-ready", "true");
  await page
    .locator("#admin-tabs")
    .getByRole("button", { name: "Google Drive 備份", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "儲存容量保護" })).toBeVisible();
}
test("storage shared Admin renderer has decimal budget, Drive quota, dry-run and no real transport", async ({
  page,
}) => {
  const requests = [],
    errors = [];
  page.on("request", (r) => requests.push(r));
  page.on("pageerror", (e) => errors.push(e.message));
  await backup(page);
  const panel = page.getByRole("region", { name: "儲存容量保護" });
  await expect(panel).toContainText("10.00 GB");
  await expect(panel).toContainText("33.3%");
  await panel.getByRole("button", { name: "檢查歷史圖片（dry-run）" }).click();
  await expect(panel).toContainText("實際刪除 0 張");
  await page.locator("#preview-controls > summary").click();
  await expect(page.locator("#preview-storage")).toBeVisible();
  expect(
    requests.filter(
      (r) =>
        new URL(r.url()).origin !== origin ||
        new URL(r.url()).pathname.includes("/api/") ||
        r.method() !== "GET",
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
});
test("storage high/stop/recovery/unknown/Drive error/failed cleanup scenarios are available", async ({
  page,
}) => {
  for (const scenario of [
    "high",
    "stopped",
    "recovered",
    "unknown",
    "drive_error",
    "cleanup_failed",
  ]) {
    await backup(page, scenario);
    const p = page.getByRole("region", { name: "儲存容量保護" });
    if (["stopped", "unknown"].includes(scenario))
      await expect(p).toContainText("目前儲存空間不足");
    if (scenario === "high") await expect(p).toContainText("9.10 GB");
    if (scenario === "drive_error") await expect(p).toContainText("讀取失敗");
    if (scenario === "cleanup_failed") await expect(p).toContainText("CLEANUP_VERIFICATION_FAILED");
  }
});
test("storage card and dialogs fit 320/390/430/1024/1440 in dark and light", async ({ page }) => {
  await backup(page);
  for (const width of [320, 390, 430, 1024, 1440])
    for (const theme of ["dark", "light"]) {
      await page.setViewportSize({ width, height: 900 });
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page.locator("#theme-toggle").click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
});
test("reviewer cannot access storage management tab", async ({ page }) => {
  await page.goto(origin + "/VoteProof/?preview_identity=reviewer#admin");
  await expect(page.locator("#admin-panel")).toHaveAttribute("aria-busy", "false");
  await expect(
    page.locator("#admin-tabs").getByRole("button", { name: "Google Drive 備份", exact: true }),
  ).toHaveCount(0);
});
