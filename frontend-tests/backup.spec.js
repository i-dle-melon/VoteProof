import { test, expect } from '@playwright/test';
import { adminFixture } from './admin-fixture.mjs';
import { randomUUID } from 'node:crypto';
const tab = async (page, name) => {
  await page.locator('#admin-tabs').getByRole('button', {name, exact:true}).click();
  await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
};
const ready = async page => { await page.goto('/#admin'); await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false'); await tab(page,await page.locator('#admin-tabs').getByRole('button',{name:'Google Drive 備份',exact:true}).count()?'Google Drive 備份':'工作總覽'); };
const openReview = async page => {
  await tab(page,'案件審核');
  await page.locator('.review-album .case-preview').first().click({position:{x:12,y:12}});
  await expect(page.locator('.inline-review img')).toBeVisible();
};
test('backup statuses, safe readback links and retry use existing MFA/CSRF; no Google fetch from browser',async({page})=>{
  const state=await adminFixture(page), violations=[];
  page.on('request',request=>{if(/googleapis\.com/.test(request.url()))violations.push('external');});
  state.backups=['pending','processing','confirmed','failed'].map(status=>({id:randomUUID(),file_id:randomUUID(),status,drive_file_id:status==='confirmed'?'local_confirmed_id':null,
    completed_at:1770000000,last_error_code:status==='failed'?'OAUTH_REVOKED':null,version:1}));
  await ready(page);await expect(page.locator('#admin-panel')).toContainText('待備份：1');
  await openReview(page);
  for(const text of ['待備份','備份中','已備份','備份失敗','備份授權已失效'])await expect(page.locator('#admin-panel')).toContainText(text);
  await expect(page.getByRole('link',{name:'在 Google Drive 開啟'})).toHaveAttribute('href','https://drive.google.com/file/d/local_confirmed_id/view');
  await page.getByRole('button',{name:'重試備份',exact:true}).click();
  await expect.poll(()=>state.calls.some(c=>c.path.endsWith('/retry'))).toBe(true);
  const post=state.calls.find(c=>c.path.endsWith('/retry'));expect(post.body).toEqual({expected_version:1});expect(post.headers['x-csrf-token']).toBe(state.csrf);
  expect(violations).toEqual([]);
});
test('reviewer can read per-proof backup but cannot see enqueue/retry controls',async({page})=>{
  const state=await adminFixture(page,{role:'reviewer'});state.backups=[{id:randomUUID(),status:'failed',last_error_code:'NETWORK',version:1}];
  await ready(page);await openReview(page);
  await expect(page.locator('#admin-panel')).toContainText('備份失敗');await expect(page.getByRole('button',{name:'重試備份',exact:true})).toHaveCount(0);
  expect(state.calls.some(c=>c.path==='/api/admin/backups')).toBe(false);
});
test('backfill first performs dry run, then separate confirmed enqueue; missing schema preserves review UI',async({page})=>{
  const state=await adminFixture(page);state.backupMissing=1;await ready(page);await page.locator('summary').filter({hasText:'尚未排入備份'}).click();
  await page.getByRole('button',{name:'檢查未備份證明'}).click();await expect(page.locator('#admin-panel')).toContainText('可排入 1 張');
  expect(state.calls.filter(c=>c.path.endsWith('/backfill')).map(c=>c.body.dry_run)).toEqual([true]);
  await page.getByRole('button',{name:'排入本次備份'}).click();await expect.poll(()=>state.calls.filter(c=>c.path.endsWith('/backfill')).length).toBe(2);
  expect(state.calls.filter(c=>c.path.endsWith('/backfill')).map(c=>c.body.dry_run)).toEqual([true,false]);
  await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
  await page.route('**/api/admin/backups',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'ADMIN_SERVICE_UNAVAILABLE',message:'private upstream'}})}));
  await page.reload();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');await tab(page,'Google Drive 備份');
  await expect(page.locator('#admin-panel')).toContainText('案件審核仍可使用');await openReview(page);
});
test('backup admin layout stays bounded in dark/light at 320,390,430',async({page})=>{
  await adminFixture(page);for(const width of [320,390,430]){
    await page.setViewportSize({width,height:844});await ready(page);
    for(const theme of ['dark','light']){
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
    await openReview(page);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});

for(const enabled of [false,true])test(`backup ${enabled?'unconfigured':'disabled'} state is server driven; dry run exposes no mutation controls`,async({page})=>{
  const state=await adminFixture(page);state.backupReadiness={enabled,configured:false,ready:false};state.backupMissing=1;
  state.backups=[{id:randomUUID(),status:'failed',last_error_code:'NETWORK',version:1,next_attempt_at:1},{id:randomUUID(),status:'pending',version:0}];
  await ready(page);await expect(page.locator('#admin-panel')).toContainText(enabled?'尚未設定完成':'尚未啟用');
  await page.locator('summary').filter({hasText:'尚未排入備份'}).click();
  await page.getByRole('button',{name:'檢查未備份證明'}).click();await expect(page.locator('#admin-panel')).toContainText('可排入 1 張');
  await expect(page.getByRole('button',{name:'排入本次備份',exact:true})).toHaveCount(0);
  await openReview(page);
  await expect(page.getByRole('button',{name:'重試備份',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'手動執行備份',exact:true})).toHaveCount(0);
  expect(state.calls.filter(c=>c.method==='POST').map(c=>c.body)).toEqual([{dry_run:true,limit:25}]);
});
test('manual execution uses exactly one selected job, MFA and CSRF with no source override',async({page})=>{
  const state=await adminFixture(page,{backupTransport:'deprecated_worker_oauth'}),id=randomUUID();state.backups=[{id,status:'pending',version:0}];await ready(page);
  await openReview(page);await page.getByRole('button',{name:'手動執行備份',exact:true}).click();
  await expect.poll(()=>state.calls.some(c=>c.path.endsWith('/process'))).toBe(true);
  const post=state.calls.find(c=>c.path.endsWith('/process'));expect(post.path).toBe('/api/admin/backups/'+id+'/process');
  expect(post.body).toEqual({});expect(post.headers['x-csrf-token']).toBe(state.csrf);
  await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
});

test('Apps Script ready state allows retry/enqueue but hides Worker manual execution',async({page})=>{
  const state=await adminFixture(page),id=randomUUID();state.backupMissing=1;
  state.backups=[{id,status:'failed',last_error_code:'NETWORK',next_attempt_at:1,version:1}];await ready(page);
  await expect(page.locator('#admin-panel')).toContainText('備份服務設定就緒');
  await expect(page.locator('#admin-panel')).toContainText('由 Apps Script');
  await openReview(page);
  await expect(page.getByRole('button',{name:'手動執行備份',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'重試備份',exact:true}).click();
  await expect.poll(()=>state.calls.some(c=>c.path.endsWith('/retry'))).toBe(true);
  expect(state.calls.some(c=>c.path.endsWith('/process'))).toBe(false);
});

test('backup operations render only as a paginated on-demand dialog with no write side effects',async({page})=>{
  const state=await adminFixture(page);
  state.backupAudit=Array.from({length:23},(_,i)=>({action:i%4?'backfill':'retry',affected_count:i+1,created_at:1792000000-i, target_id:'private-internal-'+i}));
  await ready(page);
  const summary=page.locator('#admin-panel summary').filter({hasText:'備份操作紀錄'});
  await expect(summary).toHaveText('備份操作紀錄：23');
  await expect(page.locator('#admin-panel')).not.toContainText('影響張數：');
  expect(state.calls.some(c=>c.path==='/api/admin/backups/audit')).toBe(false);
  await summary.click();const opener=page.getByRole('button',{name:'查看備份操作紀錄'});
  await opener.click();const dialog=page.getByRole('dialog',{name:'備份操作紀錄'});
  await expect(dialog.locator('article')).toHaveCount(10);
  await expect(dialog).toContainText('第 1／3 頁');
  await expect(dialog).not.toContainText('private-internal-');
  await dialog.getByRole('button',{name:'下一頁'}).click();
  await expect(dialog).toContainText('第 2／3 頁');
  await dialog.getByLabel('頁碼',{exact:true}).fill('3');await dialog.getByLabel('頁碼',{exact:true}).press('Enter');
  await expect(dialog.locator('article')).toHaveCount(3);
  await expect(dialog.getByRole('button',{name:'下一頁'})).toBeDisabled();
  const reads=state.calls.filter(c=>c.path==='/api/admin/backups/audit').length;
  await dialog.getByLabel('頁碼',{exact:true}).fill('4');await dialog.getByRole('button',{name:'前往'}).click();
  expect(state.calls.filter(c=>c.path==='/api/admin/backups/audit').length).toBe(reads);
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(opener).toBeFocused();
  expect(state.calls.filter(c=>c.method==='POST')).toEqual([]);
});

test('backup operation dialog supports empty/error/retry and mobile viewport',async({page})=>{
  const state=await adminFixture(page);await ready(page);
  const summary=page.locator('#admin-panel summary').filter({hasText:'備份操作紀錄'});
  await expect(summary).toHaveText('備份操作紀錄：0');await summary.click();
  const opener=page.getByRole('button',{name:'查看備份操作紀錄'});await opener.click();
  const dlg=page.getByRole('dialog',{name:'備份操作紀錄'});
  await expect(dlg).toContainText('目前沒有備份操作紀錄。');await dlg.getByRole('button',{name:'關閉'}).click();
  state.backupAudit=Array.from({length:13},(_,i)=>({action:'backfill',affected_count:1,created_at:1792000000-i}));
  let fail=true;await page.route('**/api/admin/backups/audit?*',async route=>fail
    ?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'ADMIN_SERVICE_UNAVAILABLE',message:'private backend secret'}})})
    :route.fallback());
  await opener.click();const retryDlg=page.getByRole('dialog',{name:'備份操作紀錄'});
  await expect(retryDlg.getByRole('alert')).toContainText('暫時無法載入');
  await expect(retryDlg).not.toContainText('private backend secret');
  fail=false;await retryDlg.getByRole('button',{name:'重試載入清單'}).click();
  await expect(retryDlg.locator('article')).toHaveCount(10);
  await page.setViewportSize({width:320,height:740});
  expect(await retryDlg.evaluate(d=>{const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth;})).toBe(true);
  await page.mouse.click(1,1);await expect(retryDlg).toHaveCount(0);
  expect(state.calls.filter(c=>c.method==='POST')).toEqual([]);
});

const missingSummary = page => page.locator('#admin-panel summary').filter({hasText:'尚未排入備份'});
const openMissing = async page => {await missingSummary(page).click();await page.getByRole('button',{name:'查看未排入備份清單'}).click();return page.getByRole('dialog',{name:'尚未排入備份',exact:true});};

test('missing backups are initially collapsed, including zero; dialog is empty and Escape restores focus',async({page})=>{
  const state=await adminFixture(page);await ready(page);
  await expect(missingSummary(page)).toHaveText('尚未排入備份：0');
  await expect(page.getByRole('button',{name:'查看未排入備份清單'})).toBeHidden();
  expect(state.calls.some(c=>c.path.endsWith('/missing'))).toBe(false);
  const dialog=await openMissing(page);await expect(dialog).toContainText('目前沒有尚未排入備份的圖片。');
  await expect(dialog.getByRole('button',{name:'上一頁'})).toBeDisabled();await expect(dialog.getByRole('button',{name:'下一頁'})).toBeDisabled();
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'查看未排入備份清單'})).toBeFocused();
  expect(state.calls.filter(c=>c.method==='POST')).toEqual([]);
});

test('missing backups paginate by ten with previous/next, direct page entry and bounds validation',async({page})=>{
  const state=await adminFixture(page);state.backupMissing=23;await ready(page);const dialog=await openMissing(page);
  await expect(dialog.locator('article')).toHaveCount(10);await expect(dialog).toContainText('第 1／3 頁');
  await dialog.getByRole('button',{name:'下一頁'}).click();await expect(dialog).toContainText('第 2／3 頁');await expect(dialog.locator('article').first()).toContainText('local-proof-11');
  await dialog.getByLabel('頁碼',{exact:true}).fill('3');await dialog.getByRole('button',{name:'前往',exact:true}).click();
  await expect(dialog.locator('article')).toHaveCount(3);await expect(dialog).toContainText('第 3／3 頁');await expect(dialog.getByRole('button',{name:'下一頁'})).toBeDisabled();
  const requests=state.calls.filter(c=>c.path.endsWith('/missing')).length;
  await dialog.getByLabel('頁碼',{exact:true}).fill('4');await dialog.getByRole('button',{name:'前往',exact:true}).click();
  expect(state.calls.filter(c=>c.path.endsWith('/missing')).length).toBe(requests);
  await dialog.getByLabel('頁碼',{exact:true}).fill('1');await dialog.getByLabel('頁碼',{exact:true}).press('Enter');
  await expect(dialog).toContainText('第 1／3 頁');await dialog.getByRole('button',{name:'下一頁'}).click();await expect(dialog).toContainText('第 2／3 頁');
  await dialog.getByRole('button',{name:'上一頁'}).click();await expect(dialog).toContainText('第 1／3 頁');
  await dialog.getByRole('button',{name:'關閉',exact:true}).click();await expect(dialog).toHaveCount(0);
  expect(state.calls.filter(c=>c.method==='POST')).toEqual([]);
});

test('missing backup dialog handles load failure, explicit retry and a shrinking final page',async({page})=>{
  const state=await adminFixture(page);state.backupMissing=23;let fail=true;
  await page.route('**/api/admin/backups/missing?*',async route=>{if(fail)return route.fulfill({status:503,json:{ok:false,error:{code:'ADMIN_SERVICE_UNAVAILABLE',message:'private upstream detail'}}});return route.fallback();});
  await ready(page);const dialog=await openMissing(page);await expect(dialog.getByRole('alert')).toContainText('暫時無法載入');
  await expect(dialog).not.toContainText('private upstream detail');fail=false;await dialog.getByRole('button',{name:'重試載入清單'}).click();await expect(dialog).toContainText('第 1／3 頁');
  state.backupMissing=5;await dialog.getByLabel('頁碼',{exact:true}).fill('3');await dialog.getByRole('button',{name:'前往',exact:true}).click();
  await expect(dialog).toContainText('第 1／1 頁');await expect(dialog.locator('article')).toHaveCount(5);
  await page.evaluate(()=>{location.hash='home';});await expect(dialog).toHaveCount(0);
});

test('missing backup dialog fits mobile themes, traps focus and closes on its backdrop',async({page})=>{
  const state=await adminFixture(page);state.backupMissing=23;await ready(page);
  for(const width of [320,390,430])for(const theme of ['dark','light']){
    await page.setViewportSize({width,height:844});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    if(await page.getByRole('button',{name:'查看未排入備份清單'}).isHidden())await missingSummary(page).click();
    await page.getByRole('button',{name:'查看未排入備份清單'}).click();const dialog=page.getByRole('dialog',{name:'尚未排入備份',exact:true});
    await expect(dialog.locator('article')).toHaveCount(10);
    expect(await dialog.evaluate(d=>{const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth;})).toBe(true);
    await dialog.getByRole('button',{name:'關閉',exact:true}).focus();await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate(d=>d.contains(document.activeElement))).toBe(true);
    await page.mouse.click(1,1);await expect(dialog).toHaveCount(0);
  }
});
