import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { adminFixture } from './admin-fixture.mjs';
import { embeddedCaseRuntime } from '../test/helpers/embedded-case-runtime.mjs';

test('the production stamp editor saves browser PNGs and the member view reads the published configuration', async ({ page }) => {
  const worker = await embeddedCaseRuntime();
  try {
    const state = await adminFixture(page, { autoConfirm: false });
    const actor = await worker.identity('admin');
    const migration = new URL('../migrations-activity-stamps/0001_activity_stamps.sql', import.meta.url);
    worker.sqlite.exec(await readFile(migration, 'utf8'));
    worker.sqlite.exec(`INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,
      vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at)
      VALUES('LOCAL','合成活動','團體','2001-01-01T00:00:00.000Z','2001-02-01T00:00:00.000Z','Asia/Taipei',
        '2001-01-01','2001-02-01',3,'closed','2001-01-01','2001-01-01')`);
    const useWorker = async route => {
      const request = route.request(), method = request.method();
      if (method === 'POST') {
        expect(request.headers()['x-csrf-token']).toBe(state.csrf);
        expect(request.headers()['x-voteproof-request']).toBe('1');
      }
      const response = await worker.fetch(new URL(request.url()).pathname, method,
        method === 'POST' ? request.postDataJSON() : undefined, actor.headers);
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    };
    await page.route(/\/api\/admin\/activity-stamps(?:\/.*)?$/, useWorker);
    await page.route('**/api/me/campaign-results', useWorker);

    await page.goto('/#admin');
    await page.locator('#admin-tabs').getByRole('button', { name: '會員管理', exact: true }).click();
    const panel = page.locator('#admin-panel');
    await panel.getByRole('button', { name: '活動集章', exact: true }).click();
    const editor = panel.locator('[data-activity-stamp-editor]');
    await editor.getByLabel('集章名稱').fill('正式模式合成集章');
    await editor.getByLabel('集章說明').fill('合成門檻說明');
    await editor.getByLabel('印章圖案').selectOption('custom');
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      canvas.getContext('2d').fillRect(8, 8, 16, 16);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await editor.locator('input[type=file]').setInputFiles({ name: 'transparent.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(editor.locator('.stamp-upload')).toContainText('圖案已載入');
    await editor.getByLabel('顯示狀態').selectOption('published');
    await editor.getByRole('button', { name: '儲存集章設定' }).click();
    await expect(panel).toContainText('已儲存集章設定');
    const icon = editor.locator('img.achievement-custom-icon');
    await expect.poll(() => icon.evaluate(image => image.naturalWidth)).toBe(32);

    await panel.getByRole('link', { name: '查看會員中心' }).click();
    await page.getByRole('tab', { name: '活動成果集章' }).click();
    await expect(page.getByRole('button', { name: /正式模式合成集章/ })).toHaveClass(/is-locked/);
    await expect(page.locator('#member-achievements-panel')).toContainText('合成門檻說明');
  } finally { worker.close(); }
});
