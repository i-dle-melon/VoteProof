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
  await expect(panel).toContainText("總額 15.00 GB · 已用 10.00 GB · 剩餘 33.3%");
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

test("Drive units follow quota bytes for different plans and preserve unknown values", async ({ page }) => {
  await backup(page);
  const texts = await page.evaluate(async () => {
    const { renderStorage } = await import('/VoteProof/js/admin-storage.js');
    const node = (tag, text = '') => { const el = document.createElement(tag); el.textContent = text; return el; };
    return [
      { total_bytes: 15 * 1024 ** 3, used_bytes: 0, remaining_percent: 100 },
      { total_bytes: 100 * 1024 ** 3, used_bytes: 25 * 1024 ** 3, remaining_percent: 75 },
      { total_bytes: null, used_bytes: null, remaining_percent: null },
    ].map(drive_quota => {
      const container = node('div');
      renderStorage(container, { budget: { budget: 10000000000 }, drive_quota }, { node, button: label => node('button', label) });
      return container.textContent;
    });
  });
  expect(texts[0]).toContain('總額 15.00 GB · 已用 0.00 GB · 剩餘 100.0%');
  expect(texts[1]).toContain('總額 100.00 GB · 已用 25.00 GB · 剩餘 75.0%');
  expect(texts[2]).toContain('總額 未知 · 已用 未知 · 剩餘 未知');
  for (const text of texts) expect(text).toContain('R2 管理預算 10.00 GB（十進位，非 R2 硬容量上限）');
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

test('Pages backup audit dialog uses fixture pagination without outbound API or writes',async({page})=>{
  const requests=[];page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
  await backup(page);
  const summary=page.locator('#admin-panel summary').filter({hasText:'備份操作紀錄'});
  await expect(summary).toHaveText('備份操作紀錄：23');await summary.click();
  await page.getByRole('button',{name:'查看備份操作紀錄'}).click();
  const dialog=page.getByRole('dialog',{name:'備份操作紀錄'});
  await expect(dialog.locator('article')).toHaveCount(10);
  await dialog.getByLabel('頁碼',{exact:true}).fill('3');
  await dialog.getByRole('button',{name:'前往'}).click();
  await expect(dialog.locator('article')).toHaveCount(3);await page.keyboard.press('Escape');
  await page.goto(origin+'/VoteProof/?preview_identity=admin&preview_data=empty#admin');
  await page.locator('#admin-tabs').getByRole('button',{name:'Google Drive 備份',exact:true}).click();
  await expect(summary).toHaveText('備份操作紀錄：0');
  await summary.click();await page.getByRole('button',{name:'查看備份操作紀錄'}).click();
  await expect(page.getByRole('dialog',{name:'備份操作紀錄'})).toContainText('目前沒有備份操作紀錄。');
  expect(requests.filter(r=>new URL(r.url).origin!==origin||new URL(r.url).pathname.includes('/api/')||r.method!=='GET')).toEqual([]);
});
test('Pages missing backup dialog uses the shared renderer and fixture pages without network mutations',async({page})=>{
  const requests=[];page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
  await backup(page);
  const summary=()=>page.locator('#admin-panel summary').filter({hasText:'尚未排入備份'});
  await expect(summary()).toHaveText('尚未排入備份：23');await summary().click();
  await page.getByRole('button',{name:'查看未排入備份清單'}).click();
  const dialog=page.getByRole('dialog',{name:'尚未排入備份',exact:true});
  await expect(dialog.locator('article')).toHaveCount(10);
  await dialog.getByLabel('頁碼',{exact:true}).fill('3');await dialog.getByRole('button',{name:'前往',exact:true}).click();
  await expect(dialog.locator('article')).toHaveCount(3);await expect(dialog).toContainText('第 3／3 頁');await page.keyboard.press('Escape');
  await page.goto(origin+'/VoteProof/?preview_identity=admin&preview_data=empty#admin');
  await page.locator('#admin-tabs').getByRole('button',{name:'Google Drive 備份',exact:true}).click();
  await expect(summary()).toHaveText('尚未排入備份：0');await summary().click();await page.getByRole('button',{name:'查看未排入備份清單'}).click();
  await expect(page.getByRole('dialog',{name:'尚未排入備份',exact:true})).toContainText('目前沒有尚未排入備份的圖片。');
  expect(requests.filter(r=>new URL(r.url).origin!==origin||new URL(r.url).pathname.includes('/api/')||r.method!=='GET')).toEqual([]);
});
