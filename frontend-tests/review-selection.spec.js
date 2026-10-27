import { test, expect } from '@playwright/test';
import { adminFixture } from './admin-fixture.mjs';
const first=page=>page.getByRole('button',{name:'選取前20張初審案件',exact:true});
const all=page=>page.getByRole('button',{name:'選取全部未審案件',exact:true});
const approve=page=>page.locator('#admin-batch-approve');
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const caseId=i=>'VP-20261023-'+'A'.repeat(14)+alphabet[Math.floor(i/32)]+alphabet[i%32];
async function setup(page,n=25){
 const s=await adminFixture(page,{autoConfirm:false}),sample=s.cases[0];
 s.cases=Array.from({length:n},(_,i)=>({...sample,case_id:caseId(i),updated_at:sample.created_at,primary_file_id:sample.files[0].file_id}));
 s.reviewCalls=[];s.dialogs=[];s.confirm=false;s.planError=false;s.planTotal=null;
 page.on('dialog',async d=>{s.dialogs.push(d.message());await(s.confirm?d.accept():d.dismiss());});
 await page.route(/\/api\/admin\/cases(?:\?|\/|$)/,async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname,body=req.method()==='POST'?req.postDataJSON():null;
  const respond=data=>route.fulfill({json:{ok:true,data}}),error=(code,status=503)=>route.fulfill({status,json:{ok:false,error:{code}}});
  if(!['/api/admin/cases','/api/admin/cases/initial-review','/api/admin/cases/batch-approve'].includes(p)){if(p.includes('/files/'))s.reviewCalls.push({path:p,method:req.method()});return route.fallback();}
  s.reviewCalls.push({path:p,method:req.method(),search:u.search,body});
  if(p==='/api/admin/cases'){
   const rows=s.cases.filter(r=>(!u.searchParams.get('status')||r.status===u.searchParams.get('status'))&&(!u.searchParams.get('review_stage')||r.review_stage===u.searchParams.get('review_stage'))),offset=Number(u.searchParams.get('cursor')??0);
   return respond({cases:rows.slice(offset,offset+20),next_cursor:rows.length>offset+20?String(offset+20):null});
  }
  if(p.endsWith('initial-review')){
   if(s.planError)return error('ADMIN_SERVICE_UNAVAILABLE');
   const cutoff=u.searchParams.get('cutoff')??new Date().toISOString();
   const rows=s.cases.filter(r=>r.status==='pending'&&r.review_stage==='initial'&&!r.review_risk_reason&&r.created_at<=cutoff&&r.updated_at<=cutoff).sort((a,b)=>a.case_id<b.case_id?-1:a.case_id>b.case_id?1:0);
   if(!u.searchParams.has('cutoff'))return respond({total:s.planTotal??rows.length,cutoff,cases:[],next_cursor:null});
   const rowsAfter=rows.filter(r=>r.case_id>(u.searchParams.get('cursor')??''));
   return respond({cases:rowsAfter.slice(0,20).map(r=>({case_id:r.case_id,expected_version:r.version})),next_cursor:rowsAfter.length>20?rowsAfter[19].case_id:null});
  }
  expect(req.headers()['x-csrf-token']).toBe(s.csrf);expect(body.cases.length).toBeLessThanOrEqual(4);
  return respond({results:body.cases.map(item=>{const row=s.cases.find(r=>r.case_id===item.case_id);if(!row||row.status!=='pending'||row.version!==item.expected_version)return{ok:false,case_id:item.case_id,code:'CASE_STATUS_CONFLICT'};row.status='approved';row.version++;return{ok:true,case_id:item.case_id,status:row.status,version:row.version};})});
 });
 await page.goto('/#admin');await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
 return s;
}
const posts=s=>s.reviewCalls.filter(c=>c.method==='POST');
const plans=s=>s.reviewCalls.filter(c=>c.path.endsWith('initial-review')&&!c.search);

test('selection starts neutral; first20 is bounded, reversible, mutually exclusive and never posts',async({page})=>{
 const s=await setup(page);await expect(first(page)).toHaveClass(/btn-white/);await expect(all(page)).toHaveClass(/btn-white/);await expect(approve(page)).toHaveClass(/btn-primary/);await expect(approve(page)).toBeDisabled();
 await page.getByRole('button',{name:'載入更多',exact:true}).click();await expect(page.locator('.admin-case-row')).toHaveCount(25);await page.locator('[data-review-select]').last().check();
 await first(page).click();await expect(first(page)).toHaveAttribute('aria-pressed','true');await expect(first(page)).toHaveClass(/btn-primary/);await expect(page.locator('[data-review-select]:checked')).toHaveCount(20);await expect(approve(page)).toBeEnabled();expect(plans(s)).toHaveLength(0);
 await expect(page.locator('[data-review-select]').last()).not.toBeChecked();
 await first(page).click();await expect(approve(page)).toBeDisabled();await expect(page.locator('[data-review-select]:checked')).toHaveCount(0);
 await first(page).click();await all(page).click();await expect(all(page)).toHaveAttribute('aria-pressed','true');await expect(first(page)).toHaveAttribute('aria-pressed','false');await expect(page.locator('.batch-review-controls')).toContainText('全站 25');
 await all(page).click();await expect(all(page)).toHaveAttribute('aria-pressed','false');await expect(approve(page)).toBeDisabled();
 await all(page).click();await expect(all(page)).toHaveAttribute('aria-pressed','true');await first(page).click();await expect(all(page)).toHaveAttribute('aria-pressed','false');await expect(page.locator('[data-review-select]:checked')).toHaveCount(20);
 expect(posts(s)).toHaveLength(0);expect(s.dialogs).toHaveLength(0);
});

test('fewer than20 and manual edits clear all; filter refresh and leaving clear selection',async({page})=>{
 const s=await setup(page,3);await first(page).click();await expect(page.locator('[data-review-select]:checked')).toHaveCount(3);
 await all(page).click();await expect(page.locator('[data-review-select]:checked')).toHaveCount(3);await page.locator('[data-review-select]').first().uncheck();await expect(all(page)).toHaveAttribute('aria-pressed','false');await expect(page.locator('[data-review-select]:checked')).toHaveCount(0);await expect(approve(page)).toBeDisabled();
 await page.locator('[data-review-select]').first().check();await expect(page.locator('[data-review-select]:checked')).toHaveCount(1);
 await page.getByText('篩選案件：活動 / 類型 / 搜尋',{exact:true}).click();await page.locator('.admin-filter button[type=submit]').click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');await expect(approve(page)).toBeDisabled();
 await all(page).click();await expect(all(page)).toHaveAttribute('aria-pressed','true');await page.locator('#admin-field-filter-search').fill('VP');await expect(approve(page)).toBeDisabled();
 await first(page).click();await page.locator('#admin-tabs').getByRole('button',{name:'工作總覽',exact:true}).click();await page.locator('#admin-tabs').getByRole('button',{name:'案件審核',exact:true}).click();await expect(approve(page)).toBeDisabled();expect(posts(s)).toHaveLength(0);
});

test('all selection counts once, never loads private unloaded images; only final confirmation posts',async({page})=>{
 const s=await setup(page);await all(page).click();await expect(approve(page)).toBeEnabled();expect(s.dialogs).toHaveLength(0);expect(plans(s)).toHaveLength(1);expect(s.reviewCalls.filter(c=>c.path.endsWith('initial-review')&&c.search)).toHaveLength(0);await expect(page.locator('.admin-case-row')).toHaveCount(20);await expect(page.locator('[data-review-select]:checked')).toHaveCount(20);
 expect(s.reviewCalls.some(c=>s.cases.slice(20).some(row=>c.path.includes(row.case_id+'/files/')))).toBe(false);
 await approve(page).click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');expect(s.dialogs).toHaveLength(1);expect(posts(s)).toHaveLength(0);expect(s.cases.every(r=>r.status==='pending')).toBe(true);await expect(all(page)).toHaveAttribute('aria-pressed','true');
 s.confirm=true;await approve(page).click();await expect(page.locator('.batch-review-results')).toContainText('已處理 25／25');await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');expect(posts(s).map(c=>c.body.cases.length)).toEqual([4,4,4,4,4,4,1]);expect(plans(s)).toHaveLength(1);expect(new Set(posts(s).flatMap(c=>c.body.cases.map(r=>r.case_id))).size).toBe(25);
});

test('first20 confirm cancellation is read only and exact IDs remain version bound',async({page})=>{
 const s=await setup(page,3);await first(page).click();await approve(page).click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');expect(posts(s)).toHaveLength(0);await expect(page.locator('[data-review-select]:checked')).toHaveCount(3);
 s.confirm=true;await approve(page).click();await expect(page.locator('.batch-review-results')).toContainText('成功 3');expect(posts(s)[0].body.cases).toEqual(s.cases.map(r=>({case_id:r.case_id,expected_version:0})));
});

test('cutoff excludes arrivals and changed rows between selection and confirmation',async({page})=>{
 const s=await setup(page,3);await all(page).click();await expect(all(page)).toHaveAttribute('aria-pressed','true');
 const future=new Date(Date.now()+60000).toISOString();s.cases[1].updated_at=future;s.cases[1].version++;s.cases.push({...s.cases[0],case_id:caseId(99),created_at:future,updated_at:future});s.confirm=true;
 await approve(page).click();await expect(page.locator('.batch-review-results')).toContainText('已處理 2／3');expect(posts(s).flatMap(c=>c.body.cases.map(r=>r.case_id))).toEqual([caseId(0),caseId(2)]);expect(s.cases[1].status).toBe('pending');expect(s.cases.at(-1).status).toBe('pending');
});

test('empty, malformed and failed all plans cannot authorize a selection',async({page})=>{
 const s=await setup(page,0);await first(page).click();await expect(approve(page)).toBeDisabled();await all(page).click();await expect(page.locator('.batch-review-results')).toContainText('目前沒有符合條件');await expect(approve(page)).toBeDisabled();
 s.planTotal=-1;await all(page).click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');await expect(all(page)).toHaveAttribute('aria-pressed','false');await expect(approve(page)).toBeDisabled();
 s.planError=true;await all(page).click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');await expect(approve(page)).toBeDisabled();expect(posts(s)).toHaveLength(0);expect(s.dialogs).toHaveLength(0);
});

for(const kind of ['MFA','role'])test(kind+' loss clears a selected scope before confirmation or review POST',async({page})=>{
 const s=await setup(page,3);await all(page).click();await expect(all(page)).toHaveAttribute('aria-pressed','true');if(kind==='MFA')s.elevationUntil=0;else s.role=null;s.confirm=true;await approve(page).click();await expect(page.locator('#admin-content')).toBeHidden();expect(posts(s)).toHaveLength(0);expect(s.dialogs).toHaveLength(0);
});

test('selection colors and controls fit dark/light mobile and desktop without polling',async({page},info)=>{
 const s=await setup(page,3);await page.locator('.case-preview').first().scrollIntoViewIfNeeded();await expect(page.locator('.case-preview img').first()).toBeVisible();for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await first(page).click();await expect(first(page)).toHaveClass(/btn-primary/);await expect(all(page)).toHaveClass(/btn-white/);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator('.batch-review-controls').scrollIntoViewIfNeeded();await page.screenshot({path:'.wrangler/selection-'+info.project.name+'-'+theme+'.png'});await first(page).click();}
 await page.clock.install();const before=s.reviewCalls.length;await page.clock.fastForward(120000);expect(s.reviewCalls.length).toBe(before);expect(posts(s)).toHaveLength(0);
});
