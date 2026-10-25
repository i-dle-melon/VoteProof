import {test,expect} from '@playwright/test';
import {adminFixture} from './admin-fixture.mjs';
test('archived thumbnail and detail remain readable case records, with no image retry or restore action',async({page})=>{
  const state=await adminFixture(page,{caseStatus:'completed'});
  state.backups=[{status:'confirmed',archive_state:'cold',completed_at:1790000000,drive_file_id:null}];
  let imageCalls=0;
  await page.route('**/api/admin/cases/*/files/*',route=>{imageCalls++;return route.fulfill({status:410,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'PROOF_ARCHIVED_IN_DRIVE'}})});});
  await page.goto('/#admin');
  const panel=page.locator('#admin-panel'),thumb=panel.locator('.case-preview');
  await thumb.scrollIntoViewIfNeeded(); // real viewport-triggered thumbnails, including mobile
  await expect(thumb).toHaveText('已封存至 Google Drive');
  await thumb.click({position:{x:12,y:12}});
  await expect(panel.locator('.admin-proof-grid')).toContainText('已封存至 Google Drive');
  await expect(panel.locator('.admin-proof-grid')).not.toContainText(/暫時無法|重試/);
  await expect(panel.getByRole('button',{name:'重試載入案件'})).toHaveCount(0);
  await expect(panel.locator('.inline-review')).toContainText(state.caseId);
  await expect(panel.locator('.inline-review')).toContainText('已完成');
  expect(imageCalls).toBe(2); // one thumbnail + one explicit detail, no polling/retry
  expect(state.calls.filter(c=>c.method==='POST')).toHaveLength(0);
});
test('cold ZIP range is an explicit scope refusal, not a generic system error',async({page})=>{
  await adminFixture(page);
  await page.route('**/api/admin/image-exports/query',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:{image_count:1,total_bytes:100,package_count:1}})}));
  await page.route('**/api/admin/image-exports/jobs',route=>route.request().method()==='POST'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'EXPORT_ARCHIVED_PROOF'}})}):route.fallback());
  await page.goto('/#admin');await page.locator('#admin-tabs').getByRole('button',{name:'圖片批次匯出',exact:true}).click();
  await page.locator('.image-export form').getByRole('button',{name:/查詢/}).click();
  await expect(page.locator('.image-export')).toContainText('選取範圍包含已封存至 Google Drive 的圖片，無法建立 ZIP；請調整匯出範圍。');
});
