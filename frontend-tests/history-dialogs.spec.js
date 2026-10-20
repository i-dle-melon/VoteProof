import { test, expect } from '@playwright/test';
import { memberFixture } from './member-fixture.mjs';

const preview = 'http://127.0.0.1:4174/VoteProof/';
const openStorage = async page => {
  await page.goto(preview+'?preview_identity=admin#admin');
  await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
  await page.locator('#admin-tabs').getByRole('button',{name:'Google Drive 備份',exact:true}).click();
  await expect(page.getByRole('region',{name:'儲存容量保護'})).toBeVisible();
};

test('Pages capacity history stays collapsed and reads 10 per page in a closable modal', async ({page}) => {
  await openStorage(page);
  const summary=page.locator('.storage-panel summary').filter({hasText:'容量歷史統計'});
  const opener=page.getByRole('button',{name:'查看容量歷史清單'});
  await expect(opener).toBeHidden();
  await summary.click();await opener.click();
  const dialog=page.getByRole('dialog',{name:'容量歷史統計'});
  await expect(dialog.locator('article')).toHaveCount(10);
  await expect(dialog).toContainText('共 23 筆 · 第 1／3 頁');
  await dialog.getByRole('button',{name:'下一頁'}).click();
  await expect(dialog).toContainText('第 2／3 頁');
  await dialog.getByLabel('頁碼',{exact:true}).fill('3');
  await dialog.getByLabel('頁碼',{exact:true}).press('Enter');
  await expect(dialog.locator('article')).toHaveCount(3);
  await expect(dialog.getByRole('button',{name:'下一頁'})).toBeDisabled();
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('Pages history empty state, responsive bounds and outside-click close',async({page})=>{
  await page.goto(preview+'?preview_identity=admin&preview_data=empty#admin');
  await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
  await page.locator('#admin-tabs').getByRole('button',{name:'Google Drive 備份',exact:true}).click();
  await page.locator('.storage-panel summary').filter({hasText:'容量歷史統計'}).click();
  await page.getByRole('button',{name:'查看容量歷史清單'}).click();
  const dialog=page.getByRole('dialog',{name:'容量歷史統計'});
  await expect(dialog).toContainText('目前沒有容量歷史紀錄。');
  await expect(dialog.getByRole('button',{name:'下一頁'})).toBeDisabled();
  await page.setViewportSize({width:320,height:720});
  expect(await dialog.evaluate(d=>{const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
  await page.mouse.click(1,1);await expect(dialog).toHaveCount(0);
});

test('member point changes load only on demand, support direct page jump, and close with focus restored',async({page})=>{
  const state=await memberFixture(page,{authenticated:true});
  await page.goto('/#member');
  const summary=page.locator('#point-record-details summary'),opener=page.getByRole('button',{name:'查看點數異動清單'});
  await expect(summary).toBeVisible();await expect(opener).toBeHidden();
  await summary.click();await opener.click();
  const dialog=page.getByRole('dialog',{name:'點數異動明細'});
  await expect(dialog.locator('article')).toHaveCount(10);
  await expect(dialog).toContainText('共 23 筆');
  await dialog.getByLabel('頁碼',{exact:true}).fill('3');
  await dialog.getByRole('button',{name:'前往',exact:true}).click();
  await expect(dialog.locator('article')).toHaveCount(3);
  await expect(dialog).toContainText('第 3／3 頁');
  await dialog.getByRole('button',{name:'上一頁'}).click();
  await expect(dialog).toContainText('第 2／3 頁');
  await dialog.getByRole('button',{name:'關閉',exact:true}).click();
  await expect(opener).toBeFocused();
  expect(state.calls.filter(c=>c.path==='/api/me/point-transactions').every(c=>c.method==='GET')).toBe(true);
});

test('member point dialog supports failed read retry and empty list without mutations',async({page})=>{
  const state=await memberFixture(page,{authenticated:true});state.pointFailures=1;
  await page.goto('/#member');
  await page.locator('#point-record-details summary').click();
  await page.getByRole('button',{name:'查看點數異動清單'}).click();
  const dialog=page.getByRole('dialog',{name:'點數異動明細'});
  await expect(dialog.getByRole('button',{name:'重試載入清單'})).toBeVisible();
  await dialog.getByRole('button',{name:'重試載入清單'}).click();
  await expect(dialog.locator('article')).toHaveCount(10);
  await dialog.getByRole('button',{name:'關閉',exact:true}).click();
  state.pointRecords=[];
  await page.getByRole('button',{name:'查看點數異動清單'}).click();
  await expect(dialog).toContainText('目前沒有點數異動紀錄。');
  await expect(dialog.getByRole('button',{name:'上一頁'})).toBeDisabled();
});
