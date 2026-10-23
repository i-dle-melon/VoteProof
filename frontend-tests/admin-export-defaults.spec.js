import { test, expect } from "@playwright/test";
test.use({ timezoneId: "America/Los_Angeles" });
const base = "http://127.0.0.1:4174/VoteProof/?preview_identity=admin#admin";

test("export initial defaults use Taipei calendar in a non-Taipei browser", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-22T18:30:00Z"));
  await page.goto(base);
  await expect(page.locator("html")).toHaveAttribute("data-preview-ready", "true");
  await expect(page.locator("#admin-panel")).toHaveAttribute("aria-busy", "false");
  await page.locator("#admin-tabs").getByRole("button", { name: "圖片批次匯出", exact: true }).click();
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("America/Los_Angeles");
  expect(await page.evaluate(() => new Date().getDate())).toBe(22);
  await expect(page.locator("#export-from")).toHaveValue("2026-10-22T23:00");
  await expect(page.locator("#export-to")).toHaveValue("2026-10-23T23:00");
  await expect(page.locator("#export-to")).toHaveAttribute("type", "datetime-local");
});

test("export manual dates survive filter changes and time passing without extra requests", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-22T18:30:00Z") });
  await page.goto("http://127.0.0.1:4174/VoteProof/?preview_identity=guest");
  await expect(page.locator("html")).toHaveAttribute("data-preview-ready", "true");
  await page.evaluate(async () => {
    const { renderImageExports } = await import("/VoteProof/js/admin-export.js");
    const host = document.createElement("div"); host.id = "date-test-host"; document.body.append(host);
    window.dateTestRequests = [];
    await renderImageExports({ container: host, session: {}, signal: new AbortController().signal,
      request: async path => {
        window.dateTestRequests.push(path);
        if (path === "campaigns?limit=50") return { campaigns: [{ campaign_id: "LOCAL", name: "合成活動" }], next_cursor: null };
        if (path === "image-exports") return { jobs: [], has_more: false };
        throw Error("Unexpected request: " + path);
      } });
  });
  const host = page.locator("#date-test-host");
  await expect(host.locator("#export-from")).toHaveValue("2026-10-22T23:00");
  await host.locator("#export-from").fill("2026-09-30T12:34");
  await host.locator("#export-to").fill("2026-10-01T03:21");
  await host.locator("#export-campaign").selectOption("LOCAL");
  await host.locator('input[name="entire"]').check();
  await expect(host.locator("#export-from")).toBeDisabled();
  await host.locator('input[name="entire"]').uncheck();
  await host.locator('input[name="statuses"][value="rejected"]').check();
  await host.locator('input[name="sources"][value="guest"]').uncheck();
  await host.locator("#export-only-undownloaded").uncheck();
  await host.locator("#export-campaign").selectOption("");
  await page.clock.fastForward(300000);
  await expect(host.locator("#export-from")).toHaveValue("2026-09-30T12:34");
  await expect(host.locator("#export-to")).toHaveValue("2026-10-01T03:21");
  expect(await page.evaluate(() => window.dateTestRequests)).toEqual(["campaigns?limit=50", "image-exports"]);
});
