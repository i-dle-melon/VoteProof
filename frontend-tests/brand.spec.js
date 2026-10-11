import { test, expect } from "@playwright/test";
import { memberFixture } from "./member-fixture.mjs";

test("legacy brand stays intact on desktop and narrow phones in both themes", async ({ page }, testInfo) => {
  await memberFixture(page); await page.goto("/#login");
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.locator("#theme-toggle").click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const brand = page.locator(width > 980 ? ".sidebar .brand" : ".mobile-brand");
      await expect(brand).toBeVisible();
      await expect(brand.locator(".brand-copy strong")).toHaveText("VoteProof");
      await expect(brand.locator(".brand-copy span")).toHaveText("投票證明中心");
      expect(await brand.locator(".brand-mark").evaluate(node => {
        const mark = node.getBoundingClientRect(), range = document.createRange();
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        return mark.width === 40 && mark.height === 40 && range.getClientRects().length === 1
          && text.left >= mark.left && text.right <= mark.right && text.top >= mark.top && text.bottom <= mark.bottom;
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.wrangler/frontend-previews/legacy-brand-${testInfo.project.name}-${width}-${theme}.png` });
    }
  }
});

test("legacy navigation glyphs remain visible after member session refresh", async ({ page }) => {
  await memberFixture(page, { authenticated: true }); await page.goto("/#member");
  await expect(page.locator("#member-entry")).toBeVisible();
  await expect(page.locator("#member-entry span[aria-hidden]")).toHaveText("◎");
  for (const nav of [".sidebar nav", ".bottom-nav"]) {
    for (const [view, icon] of [["home", "⌂"], ["submit", "＋"], ["lookup", "▣"], ["leaderboards", "♛"]]) {
      await expect(page.locator(`${nav} [data-view="${view}"] span[aria-hidden]`)).toHaveText(icon);
    }
  }
  await page.reload();
  await expect(page.locator("#member-entry span[aria-hidden]")).toHaveText("◎");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator("#admin-nav-group")).toBeHidden();
});
