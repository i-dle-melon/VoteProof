import { test, expect } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import { readFile } from "node:fs/promises";
const base = "http://127.0.0.1:4174/VoteProof/?preview_identity=admin";
async function enter(page, scene = "normal", theme = "dark") {
  await page.goto(`${base}&preview_exports=${scene}&preview_theme=${theme}#admin`);
  await expect(page.locator("html")).toHaveAttribute("data-preview-ready", "true");
  await expect(page.locator("#admin-panel")).toHaveAttribute("aria-busy", "false");
  await page
    .locator("#admin-tabs")
    .getByRole("button", { name: "圖片批次匯出", exact: true })
    .click();
  await expect(page.locator(".image-export")).toBeVisible();
  await expect(page.locator("#admin-panel")).toHaveAttribute("aria-busy", "false");
}
test("Preview Normal/Small/Empty/Error and both themes at 320/390/430/1024/1440", async ({
  page,
}) => {
  test.setTimeout(90000);
  const failures = [],
    requests = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/api/")) requests.push(r.url());
  });
  for (const width of [320, 390, 430, 1024, 1440])
    for (const theme of ["dark", "light"]) {
      await page.setViewportSize({ width, height: 900 });
      await enter(page, "normal", theme);
      await expect(page.locator(".export-summary")).toContainText("4,386");
      await expect(page.locator(".export-package")).toHaveCount(14);
      for (const state of ["planned", "in_progress", "completed", "failed"])
        await expect(page.locator(`[data-export-state="${state}"]`).first()).toBeVisible();
      await page.locator("#export-campaign").selectOption("PREVIEW-CAMPAIGN");
      await page.locator('input[name="entire"]').check();
      await expect(page.locator("#export-from")).toBeDisabled();
      await expect(page.locator("#export-to")).toBeDisabled();
      await page.locator('input[name="entire"]').uncheck();
      await expect(page.locator("#export-from")).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  await enter(page, "small");
  await expect(page.locator(".export-summary")).toContainText("76");
  await expect(page.locator(".export-package")).toHaveCount(1);
  await enter(page, "empty");
  await expect(page.locator(".export-summary")).toContainText("0 張");
  await expect(page.locator(".export-package")).toHaveCount(0);
  await expect(page.locator(".image-export")).toContainText("目前沒有符合條件");
  await enter(page, "error");
  await page.getByRole("button", { name: "查詢並規劃下載包", exact: true }).click();
  await expect(page.locator('.image-export [role="status"]')).toContainText("暫時無法");
  expect(failures).toEqual([]);
  expect(requests).toEqual([]);
});
test("Preview ZIP download uses same worker and valid STORE archive; independent package states", async ({
  page,
}) => {
  await enter(page);
  const first = page.locator('[data-package="1"]');
  const downloadEvent = page.waitForEvent("download");
  await first.getByRole("button", { name: "下載", exact: true }).click();
  await expect(page.locator("#export-progress")).toContainText(/下載圖片|建立 ZIP|準備/);
  const download = await downloadEvent;
  const zip = unzipSync(new Uint8Array(await readFile(await download.path())));
  expect(Object.keys(zip)).toHaveLength(4);
  expect(strFromU8(zip["manifest.csv"])).toContain("PREVIEW-CAMPAIGN");
  await expect(first.locator("[data-export-state]")).toHaveAttribute(
    "data-export-state",
    "completed",
  );
  await expect(page.locator('[data-package="2"] [data-export-state]')).toHaveAttribute(
    "data-export-state",
    "completed",
  );
  await expect(page.locator('[data-package="3"] [data-export-state]')).toHaveAttribute(
    "data-export-state",
    "failed",
  );
  await page
    .locator('[data-package="3"]')
    .getByRole("button", { name: "重新下載", exact: true })
    .click();
  await expect(page.locator('[data-package="3"] [data-export-state]')).toHaveAttribute(
    "data-export-state",
    "completed",
  );
});
test("Preview cancel aborts package, leaves retry and query can create new snapshot", async ({
  page,
}) => {
  await enter(page, "small");
  await page
    .locator('[data-package="1"]')
    .getByRole("button", { name: "下載", exact: true })
    .click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  // Cancel may precede the start acknowledgement: planned is safe to retry, too.
  // Wait for the download attempt to settle; do not assert an unconfirmed server state.
  await expect(page.locator("#export-progress")).toHaveCount(0);
  const packageRow = page.locator('[data-package="1"]');
  const state = await packageRow.locator("[data-export-state]").getAttribute("data-export-state");
  expect(["planned", "failed"]).toContain(state);
  await expect(page.locator(".image-export")).toContainText("本包未完成");
  await packageRow
    .getByRole("button", { name: state === "failed" ? "重新下載" : "下載", exact: true })
    .click();
  await expect(page.locator('[data-package="1"] [data-export-state]')).toHaveAttribute(
    "data-export-state",
    "completed",
  );
  await page.getByRole("button", { name: "查詢並規劃下載包", exact: true }).click();
  await expect(page.locator('[data-package="1"] [data-export-state]')).toHaveAttribute(
    "data-export-state",
    "planned",
  );
});
test("Member/Guest cannot access export UI", async ({ page }) => {
  for (const identity of ["member", "guest"]) {
    await page.goto("http://127.0.0.1:4174/VoteProof/?preview_identity=" + identity + "#admin");
    await expect(page.locator("html")).toHaveAttribute("data-preview-ready", "true");
    await expect(page.locator(".image-export")).toHaveCount(0);
    await expect(page.locator("#admin-tabs button")).toHaveCount(0);
  }
});
