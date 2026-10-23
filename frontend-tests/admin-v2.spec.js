import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {adminFixture} from './admin-fixture.mjs';
const ready=async page=>{await page.goto('/#admin');await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');};
const tab=async(page,name)=>{await page.locator('#admin-tabs').getByRole('button',{name,exact:true}).click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');};
const reply=(route,data)=>route.fulfill({json:{ok:true,data}});
test('pending jobs and collapsed missing/history stay distinct, including zero and direct pagination',async({page})=>{
 const state=await adminFixture(page);state.backups=Array.from({length:43},(_,i)=>({file_id:randomUUID(),case_id:state.caseId,status:'pending',created_at:1790000000+i,attempts:0}));
 await ready(page);await tab(page,'Google Drive 備份');
 await expect(page.locator('#admin-panel')).toContainText('未建立備份工作：0 · 已排入等待執行：43');
 const missing=page.locator('details').filter({has:page.locator('summary',{hasText:'尚未排入備份：0'})});
 await expect(missing).not.toHaveAttribute('open');await missing.locator('summary').first().click();
 await expect(missing.getByText('排入／重試操作歷史（不代表目前待執行）')).toBeVisible();
 await missing.getByRole('button',{name:'查看未排入備份清單'}).click();await expect(page.getByRole('dialog')).toContainText('目前沒有尚未排入備份');await page.getByRole('dialog').getByRole('button',{name:'關閉',exact:true}).click();
 await page.getByText('備份工作清單（已排入）',{exact:true}).click();await page.getByRole('button',{name:'待備份：43',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toContainText('共 43 筆');await expect(dialog.locator('.backup-missing-list article')).toHaveCount(10);
 await dialog.locator('input[type=number]').fill('5');await dialog.getByRole('button',{name:'前往',exact:true}).click();await expect(dialog).toContainText('第 5／5 頁');await expect(dialog.locator('article')).toHaveCount(3);
 expect(state.calls.filter(c=>c.method==='POST'&&c.path.includes('/backups'))).toHaveLength(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('overview displays global status groups and never fetches a page of cases for totals',async({page})=>{
 const state=await adminFixture(page);await ready(page);const prior=state.calls.filter(c=>c.path==='/api/admin/cases').length;
 await tab(page,'工作總覽');for(const value of ['1,284','134','8','2']){if(value==='1,284')await expect(page.locator('[data-member-total]')).toContainText('1284');else await expect(page.locator('#admin-panel')).toContainText(value);}
 expect(state.calls.filter(c=>c.path==='/api/admin/cases')).toHaveLength(prior);await expect(page.locator('#admin-panel')).toContainText('已撤銷');
});
test('approve all pages across unloaded cases, four per POST and exactly one final reload',async({page})=>{
 const state=await adminFixture(page);const items=Array.from({length:25},(_,i)=>({case_id:'VP-GLOBAL-'+i,expected_version:0}));const posts=[];let pageReads=0;
 await page.route('**/api/admin/cases/initial-review*',route=>{const u=new URL(route.request().url());if(!u.searchParams.has('cutoff'))return reply(route,{total:25,cutoff:new Date().toISOString()});pageReads++;const offset=Number(u.searchParams.get('cursor')??0);return reply(route,{cases:items.slice(offset,offset+20),next_cursor:offset===0?'20':null});});
 await page.route('**/api/admin/cases/batch-approve',route=>{const body=route.request().postDataJSON();posts.push(body.cases);return reply(route,{results:body.cases.map(r=>({ok:true,case_id:r.case_id,status:'approved',version:1}))});});
 await ready(page);const before=state.calls.filter(c=>c.path==='/api/admin/cases').length;await page.locator('#admin-approve-all').click();
 await expect(page.locator('.batch-review-results')).toContainText('已處理 25／25');await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
 expect(posts.map(p=>p.length)).toEqual([4,4,4,4,4,4,1]);expect(new Set(posts.flat().map(r=>r.case_id)).size).toBe(25);expect(pageReads).toBe(2);
 expect(state.calls.filter(c=>c.path==='/api/admin/cases')).toHaveLength(before+1);expect(state.calls.some(c=>c.path==='/api/admin/overview')).toBe(true);
});
test('safe stop waits for the in-flight batch, preserves actual success and unlocks navigation',async({page})=>{
 await adminFixture(page);let release,posts=0;const pending=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/admin/cases/initial-review*',route=>reply(route,new URL(route.request().url()).searchParams.has('cutoff')?{cases:Array.from({length:20},(_,i)=>({case_id:'VP-STOP-'+i,expected_version:0})),next_cursor:'20'}:{total:100,cutoff:new Date().toISOString()}));
 await page.route('**/api/admin/cases/batch-approve',async route=>{posts++;const cases=route.request().postDataJSON().cases;await pending;await reply(route,{results:cases.map(r=>({...r,ok:true,status:'approved'}))});});
 await ready(page);await page.locator('#admin-approve-all').click();await expect.poll(()=>posts).toBe(1);
 await expect(page.locator('#admin-tabs')).toHaveAttribute('inert','');await expect(page.getByRole('progressbar',{name:'審核進度',exact:true})).toHaveAttribute('value','0');
 await page.getByRole('button',{name:'停止後續批次'}).click();release();
 await expect(page.locator('.batch-review-results')).toContainText('已處理 4／100');await expect(page.locator('.batch-review-results')).toContainText('已停止');expect(posts).toBe(1);await expect(page.locator('#admin-tabs')).not.toHaveAttribute('inert');
});
test('uncertain batch reconciles via read-only audit status, never blindly retries or loses failure IDs',async({page})=>{
 const state=await adminFixture(page);let posts=0,statusReads=0;
 await page.route('**/api/admin/cases/batch-approve',route=>{posts++;return route.abort();});
 await page.route('**/api/admin/cases/batch-status*',route=>{statusReads++;return reply(route,{results:[{ok:false,case_id:state.caseId,code:'REVIEW_RESULT_UNCONFIRMED'}]});});
 await ready(page);await page.getByRole('button',{name:'選取已載入初審案件'}).click();await page.locator('#admin-batch-approve').click();
 await expect(page.locator('.batch-review-results')).toContainText(state.caseId);await expect(page.locator('.batch-review-results')).toContainText('結果尚未確認');expect(posts).toBe(1);expect(statusReads).toBe(1);
});
test('the final reload preserves the current review filters and retained summary',async({page})=>{
 const state=await adminFixture(page);const reads=[];page.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/admin/cases')reads.push(u);});
 await page.route('**/api/admin/cases/batch-approve',route=>{const cases=route.request().postDataJSON().cases;state.cases[0].status='approved';return reply(route,{results:cases.map(c=>({...c,ok:true,status:'approved'}))});});
 await ready(page);await page.getByText('篩選案件：活動 / 類型 / 搜尋',{exact:true}).click();
 await page.locator('#admin-field-filter-campaign').fill('LOCAL');await page.locator('#admin-field-filter-vote').selectOption('Solo');await page.locator('.admin-filter button[type=submit]').click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
 await page.getByRole('button',{name:'選取已載入初審案件',exact:true}).click();await page.locator('#admin-batch-approve').click();await expect(page.locator('.batch-review-results')).toContainText('成功 1');
 await expect(page.locator('#admin-field-filter-campaign')).toHaveValue('LOCAL');await expect(page.locator('#admin-field-filter-vote')).toHaveValue('Solo');expect(reads.at(-1).searchParams.get('campaign_id')).toBe('LOCAL');expect(reads.at(-1).searchParams.get('vote_type')).toBe('Solo');
});
test('export defaults use inclusive Taipei minute and only-undownloaded, shared history remains available',async({page})=>{
 // The test oracle is independent of the UI helper and spans a possible Taipei midnight.
 const rangeAt=instant=>{
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(instant);
  const yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  return {from:yesterday+'T23:00',to:today+'T23:00'};
 };
 const before=rangeAt(new Date());
 await page.goto('http://127.0.0.1:4174/VoteProof/?preview_identity=admin#admin');await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');await tab(page,'圖片批次匯出');
 const after=rangeAt(new Date());
 const observed={from:await page.locator('#export-from').inputValue(),to:await page.locator('#export-to').inputValue()};
 expect([before,after]).toContainEqual(observed);
 await expect(page.locator('#export-only-undownloaded')).toBeChecked();
 await expect(page.locator('.image-export')).toContainText('不保證檔案永久保存');await expect(page.locator('.export-summary')).toContainText('建立者');
 await page.locator('#export-only-undownloaded').uncheck();await expect(page.locator('.export-summary')).toHaveCount(0);await expect(page.locator('.export-history')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('ZIP generation alone does not mark complete; explicit confirmation records completed',async({page})=>{
 await page.goto('http://127.0.0.1:4174/VoteProof/?preview_identity=admin&preview_exports=small#admin');await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');await tab(page,'圖片批次匯出');
 const dialog=async d=>d.dismiss();page.on('dialog',dialog);await page.locator('.export-package').first().getByRole('button',{name:'下載',exact:true}).click();
 await expect(page.locator('[data-export-state=failed]')).toBeVisible();await expect(page.locator('.image-export [role=status]')).toContainText('尚未確認完成');
 page.off('dialog',dialog);page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'重新下載',exact:true}).click();await expect(page.locator('[data-export-state=completed]')).toBeVisible();
});
