import { test, expect } from '@playwright/test';
import { adminFixture } from './admin-fixture.mjs';
import { randomUUID } from 'node:crypto';
const ready = async page => { await page.goto('/#admin'); await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false'); };
test('backup statuses, safe readback links and retry use existing MFA/CSRF; no Google fetch from browser',async({page})=>{
  const state=await adminFixture(page), violations=[];
  page.on('request',request=>{if(/googleapis\.com/.test(request.url()))violations.push('external');});
  state.backups=['pending','processing','confirmed','failed'].map(status=>({id:randomUUID(),file_id:randomUUID(),status,drive_file_id:status==='confirmed'?'local_confirmed_id':null,
    completed_at:1770000000,last_error_code:status==='failed'?'OAUTH_REVOKED':null,version:1}));
  await ready(page);await expect(page.locator('#admin-panel')).toContainText('待備份：1');
  await page.getByRole('button',{name:'查看與審核',exact:true}).click();
  for(const text of ['待備份','備份中','已備份','備份失敗','備份授權已失效'])await expect(page.locator('#admin-panel')).toContainText(text);
  await expect(page.getByRole('link',{name:'在 Google Drive 開啟'})).toHaveAttribute('href','https://drive.google.com/file/d/local_confirmed_id/view');
  await page.getByRole('button',{name:'重試備份',exact:true}).click();
  await expect.poll(()=>state.calls.some(c=>c.path.endsWith('/retry'))).toBe(true);
  const post=state.calls.find(c=>c.path.endsWith('/retry'));expect(post.body).toEqual({expected_version:1});expect(post.headers['x-csrf-token']).toBe(state.csrf);
  expect(violations).toEqual([]);
});
test('reviewer can read per-proof backup but cannot see enqueue/retry controls',async({page})=>{
  const state=await adminFixture(page,{role:'reviewer'});state.backups=[{id:randomUUID(),status:'failed',last_error_code:'NETWORK',version:1}];
  await ready(page);await page.getByRole('button',{name:'查看與審核',exact:true}).click();
  await expect(page.locator('#admin-panel')).toContainText('備份失敗');await expect(page.getByRole('button',{name:'重試備份',exact:true})).toHaveCount(0);
  expect(state.calls.some(c=>c.path==='/api/admin/backups')).toBe(false);
});
test('backfill first performs dry run, then separate confirmed enqueue; missing schema preserves review UI',async({page})=>{
  const state=await adminFixture(page);state.backupMissing=1;await ready(page);
  await page.getByRole('button',{name:'檢查未備份證明'}).click();await expect(page.locator('#admin-panel')).toContainText('可排入 1 張');
  expect(state.calls.filter(c=>c.path.endsWith('/backfill')).map(c=>c.body.dry_run)).toEqual([true]);
  await page.getByRole('button',{name:'排入本次備份'}).click();await expect.poll(()=>state.calls.filter(c=>c.path.endsWith('/backfill')).length).toBe(2);
  expect(state.calls.filter(c=>c.path.endsWith('/backfill')).map(c=>c.body.dry_run)).toEqual([true,false]);
  await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
  await page.route('**/api/admin/backups',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'ADMIN_SERVICE_UNAVAILABLE',message:'private upstream'}})}));
  await page.reload();await expect(page.locator('#admin-panel')).toContainText('案件審核仍可使用');await expect(page.getByRole('button',{name:'查看與審核',exact:true})).toBeVisible();
});
test('backup admin layout stays bounded in dark/light at 320,390,430',async({page})=>{
  await adminFixture(page);for(const width of [320,390,430]){
    await page.setViewportSize({width,height:844});await ready(page);
    for(const theme of ['dark','light']){
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }
});

for(const enabled of [false,true])test(`backup ${enabled?'unconfigured':'disabled'} state is server driven; dry run exposes no mutation controls`,async({page})=>{
  const state=await adminFixture(page);state.backupReadiness={enabled,configured:false,ready:false};state.backupMissing=1;
  state.backups=[{id:randomUUID(),status:'failed',last_error_code:'NETWORK',version:1,next_attempt_at:1},{id:randomUUID(),status:'pending',version:0}];
  await ready(page);await expect(page.locator('#admin-panel')).toContainText(enabled?'尚未設定完成':'尚未啟用');
  await page.getByRole('button',{name:'檢查未備份證明'}).click();await expect(page.locator('#admin-panel')).toContainText('可排入 1 張');
  await expect(page.getByRole('button',{name:'排入本次備份',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'查看與審核',exact:true}).click();
  await expect(page.getByRole('button',{name:'重試備份',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'手動執行備份',exact:true})).toHaveCount(0);
  expect(state.calls.filter(c=>c.method==='POST').map(c=>c.body)).toEqual([{dry_run:true,limit:25}]);
});
test('manual execution uses exactly one selected job, MFA and CSRF with no source override',async({page})=>{
  const state=await adminFixture(page),id=randomUUID();state.backups=[{id,status:'pending',version:0}];await ready(page);
  await page.getByRole('button',{name:'查看與審核',exact:true}).click();await page.getByRole('button',{name:'手動執行備份',exact:true}).click();
  await expect.poll(()=>state.calls.some(c=>c.path.endsWith('/process'))).toBe(true);
  const post=state.calls.find(c=>c.path.endsWith('/process'));expect(post.path).toBe('/api/admin/backups/'+id+'/process');
  expect(post.body).toEqual({});expect(post.headers['x-csrf-token']).toBe(state.csrf);
  await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
});
