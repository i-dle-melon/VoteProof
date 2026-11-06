import {test,expect} from '@playwright/test';
import {adminFixture} from './admin-fixture.mjs';
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const caseId=i=>'VP-20261106-'+'A'.repeat(14)+alphabet[Math.floor(i/32)]+alphabet[i%32];
const boxes=page=>page.locator('.review-list-select input');
const approve=page=>page.locator('#admin-batch-approve');
const execute=page=>page.locator('#admin-batch-review');
async function setup(page,{count=6,role='admin',mode='detailed',statuses=[],stages=[]}={}){
 const s=await adminFixture(page,{autoConfirm:false,role}),sample=s.cases[0];
 s.cases=Array.from({length:count},(_,i)=>({...sample,case_id:caseId(i),status:statuses[i]??'pending',review_stage:stages[i]??'detailed',review_risk_reason:stages[i]==='initial'?null:'manual_flag',primary_file_id:sample.files[0].file_id}));
 s.posts=[];s.statusPosts=[];s.confirm=true;s.reason='共同審核原因';s.originalId=caseId(99);s.failures=new Map();s.audit=new Map();s.failAck=false;s.hold=false;
 page.on('dialog',async d=>{if(!s.confirm)return d.dismiss();return d.accept(d.type()==='prompt'?(d.message().startsWith('原案件')?s.originalId:s.reason):undefined);});
 await page.route(/\/api\/admin\/cases(?:\?|\/|$)/,async route=>{
  const req=route.request(),u=new URL(req.url()),body=req.method()==='POST'?req.postDataJSON():null;
  const reply=data=>route.fulfill({json:{ok:true,data}});
  if(u.pathname==='/api/admin/cases'){
   const rows=s.cases.filter(c=>(!u.searchParams.get('review_stage')||c.review_stage===u.searchParams.get('review_stage'))&&(!u.searchParams.get('status')||c.status===u.searchParams.get('status'))),offset=Number(u.searchParams.get('cursor')??0);
   return reply({cases:rows.slice(offset,offset+20),next_cursor:rows.length>offset+20?String(offset+20):null});
  }
  if(!['/api/admin/cases/batch-review','/api/admin/cases/batch-review/status'].includes(u.pathname))return route.fallback();
  expect(req.headers()['x-csrf-token']).toBe(s.csrf);expect(body.cases.length).toBeLessThanOrEqual(4);
  const key=c=>c.case_id+':'+c.expected_version+':'+body.action;
  if(u.pathname.endsWith('/status')){s.statusPosts.push(body);return reply({results:body.cases.map(c=>s.audit.get(key(c))??{ok:false,unknown:true,case_id:c.case_id,code:'REVIEW_RESULT_UNCONFIRMED'})});}
  s.posts.push(body);
  const results=body.cases.map(c=>{
   const row=s.cases.find(x=>x.case_id===c.case_id);
   if(s.failures.has(c.case_id))return {ok:false,case_id:c.case_id,code:s.failures.get(c.case_id),status:409};
   if(!row||row.version!==c.expected_version)return {ok:false,case_id:c.case_id,code:'CASE_STATUS_CONFLICT',status:409};
   row.version++;row.status={approve:'approved',reject:'rejected',mark_duplicate:'duplicate',complete:'completed',revoke:'revoked',flag_detailed:'pending'}[body.action];
   if(body.action==='flag_detailed'){row.review_stage='detailed';row.review_risk_reason=body.review_risk_reason;}
   const result={ok:true,case_id:row.case_id,status:row.status,version:row.version,review_stage:row.review_stage,outcome:'reviewed'};s.audit.set(key(c),result);return result;
  });
  if(s.hold){s.waiting=true;await new Promise(resolve=>{s.release=resolve;});}
  if(s.failAck){s.failAck=false;return route.abort('connectionreset');}
  return reply({results});
 });
 await page.goto('/#admin');await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
 await page.getByRole('button',{name:mode==='detailed'?'詳細審核':'全部案件',exact:true}).click();await expect(boxes(page)).toHaveCount(Math.min(count,20));
 return s;
}

test('detailed rows select before thumbnails; more than20 explicit selections are reviewed in bounded chunks',async({page})=>{
 const s=await setup(page,{count:25});await expect(approve(page)).toBeDisabled();await expect(page.locator('#admin-approve-all')).toBeHidden();
 const input=await boxes(page).first().boundingBox(),image=await page.locator('.review-list-proof .case-preview').first().boundingBox();expect(input.x+input.width).toBeLessThan(image.x);
 await page.getByRole('button',{name:'選取前20筆可操作案件',exact:true}).click();await expect(boxes(page).filter({visible:true})).toHaveCount(20);await expect(page.locator('[data-review-select]:checked')).toHaveCount(20);
 await page.getByRole('button',{name:'載入更多',exact:true}).click();await expect(boxes(page)).toHaveCount(25);await boxes(page).last().check();await expect(page.locator('[data-review-select]:checked')).toHaveCount(21);
 await page.getByRole('button',{name:'選取目前已載入案件',exact:true}).click();await expect(page.locator('[data-review-select]:checked')).toHaveCount(25);expect(s.posts).toHaveLength(0);
 await approve(page).click();await expect(page.locator('.batch-review-results')).toContainText('成功 25');expect(s.posts.map(p=>p.cases.length)).toEqual([4,4,4,4,4,4,1]);expect(new Set(s.posts.flatMap(p=>p.cases.map(c=>c.case_id))).size).toBe(25);expect(s.posts.every(p=>p.action==='approve'&&p.cases.every(c=>c.expected_version===0))).toBe(true);
});

test('all-cases keeps immutable states disabled and permits only common role/status actions',async({page})=>{
 const s=await setup(page,{mode:'all',count:6,statuses:['pending','approved','completed','rejected','duplicate','revoked']});
 for(const i of [3,4,5])await expect(boxes(page).nth(i)).toBeDisabled();
 await boxes(page).nth(0).check();await boxes(page).nth(1).check();await expect(approve(page)).toBeDisabled();await expect(execute(page)).toBeDisabled();await expect(page.locator('.manual-review-options')).toContainText('沒有共同可執行');
 await page.locator('#admin-clear-selection').click();await boxes(page).nth(1).check();await boxes(page).nth(2).check();await page.locator('#admin-field-batch-action').selectOption('revoke');await execute(page).click();await expect(page.locator('.batch-review-results')).toContainText('成功 2');expect(s.posts).toHaveLength(1);expect(s.posts[0].reason).toBe(s.reason);expect(s.posts[0].cases.map(x=>x.case_id)).toEqual([caseId(1),caseId(2)]);
});

test('reviewer cannot select already-approved cases for privileged review',async({page})=>{
 const s=await setup(page,{mode:'all',role:'reviewer',count:2,statuses:['pending','approved']});await expect(boxes(page).nth(1)).toBeDisabled();await boxes(page).nth(0).check();await expect(approve(page)).toBeEnabled();expect(s.posts).toHaveLength(0);
});

test('selected approved cases can complete through the existing privileged action',async({page})=>{
 const s=await setup(page,{mode:'all',count:2,statuses:['approved','approved']});await page.getByRole('button',{name:'選取目前已載入案件',exact:true}).click();await page.locator('#admin-field-batch-action').selectOption('complete');await execute(page).click();await expect(page.locator('.batch-review-results')).toContainText('成功 2');expect(s.posts[0].action).toBe('complete');expect(s.cases.every(c=>c.status==='completed')).toBe(true);
});

test('selected initial cases can flag detailed with an explicit shared risk and required other reason',async({page})=>{
 const s=await setup(page,{mode:'all',count:2,stages:['initial','initial']});await page.getByRole('button',{name:'選取目前已載入案件',exact:true}).click();await page.locator('#admin-field-batch-action').selectOption('flag_detailed');await page.locator('#admin-field-batch-risk').selectOption('other');s.reason=' ';
 await execute(page).click();expect(s.posts).toHaveLength(0);s.reason='Needs detailed review';await execute(page).click();await expect(page.locator('.batch-review-results')).toContainText('成功 2');expect(s.posts[0].review_risk_reason).toBe('other');expect(s.posts[0].reason).toBe(s.reason);expect(s.cases.every(c=>c.status==='pending'&&c.review_stage==='detailed')).toBe(true);
});

test('reason is mandatory, cancel is read only, reject targets only selected IDs',async({page})=>{
 const s=await setup(page,{count:3});await boxes(page).nth(0).check();await boxes(page).nth(2).check();s.reason=' ';
 await page.locator('#admin-batch-reject').click();await expect(page.locator('.batch-review-results')).toContainText('有效的審核原因');expect(s.posts).toHaveLength(0);
 s.reason='same reason';s.confirm=false;await approve(page).click();expect(s.posts).toHaveLength(0);s.confirm=true;
 await page.locator('#admin-batch-reject').click();await expect(page.locator('.batch-review-results')).toContainText('成功 2');expect(s.posts[0].cases.map(c=>c.case_id)).toEqual([caseId(0),caseId(2)]);expect(s.posts[0].reason).toBe('same reason');expect(s.cases[1].status).toBe('pending');
});

test('manual duplicate uses shared original and reason; partial CAS failure remains visible',async({page})=>{
 const s=await setup(page,{count:3});await page.getByRole('button',{name:'選取目前已載入案件',exact:true}).click();await page.locator('#admin-field-batch-action').selectOption('mark_duplicate');s.failures.set(caseId(1),'CASE_STATUS_CONFLICT');
 await execute(page).click();await expect(page.locator('.batch-review-results')).toContainText('重複投稿 2');await expect(page.locator('.batch-review-results')).toContainText('失敗 1');expect(s.posts[0].duplicate_of_case_id).toBe(s.originalId);expect(s.posts[0].reason).toBe(s.reason);expect(s.cases[1].status).toBe('pending');
});

test('lost ACK performs one audit-status query and never submits the next chunk',async({page})=>{
 const s=await setup(page,{count:8});s.failAck=true;await page.getByRole('button',{name:'選取目前已載入案件',exact:true}).click();await approve(page).click();await expect(page.locator('.batch-review-results')).toContainText('已停止');await expect(page.locator('.batch-review-results')).toContainText('成功 4');expect(s.posts).toHaveLength(1);expect(s.statusPosts).toHaveLength(1);expect(s.statusPosts[0]).toEqual(s.posts[0]);expect(s.cases.slice(4).every(c=>c.status==='pending')).toBe(true);
});

test('stop finishes current chunk and prevents cross-action or repeated submissions',async({page})=>{
 const s=await setup(page,{count:8});s.hold=true;await page.getByRole('button',{name:'選取目前已載入案件',exact:true}).click();await approve(page).click();await expect.poll(()=>s.waiting).toBe(true);await expect(page.locator('#admin-batch-reject')).toBeDisabled();await expect(execute(page)).toBeDisabled();
 await page.getByRole('button',{name:'停止後續批次',exact:true}).click();s.release();await expect(page.locator('.batch-review-results')).toContainText('已停止');expect(s.posts).toHaveLength(1);expect(s.cases.slice(4).every(c=>c.status==='pending')).toBe(true);
});

test('selection clears across modes and filters; light/dark mobile layout has no overflow',async({page},info)=>{
 const s=await setup(page,{count:3});await boxes(page).first().check();
 for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await expect(approve(page)).toBeEnabled();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator('.review-list-proof').first().scrollIntoViewIfNeeded();await page.screenshot({path:'.wrangler/review-list-'+info.project.name+'-'+theme+'.png'});}
 await page.getByRole('button',{name:'全部案件',exact:true}).click();await expect(approve(page)).toBeDisabled();await expect(page.locator('[data-review-select]:checked')).toHaveCount(0);await boxes(page).first().check();await page.locator('#admin-field-filter-search').fill('fixture');await expect(approve(page)).toBeDisabled();expect(s.posts).toHaveLength(0);
});

test('MFA expiry before execution stops without a review mutation',async({page})=>{
 const s=await setup(page);await boxes(page).first().check();s.elevationUntil=0;
 // A thumbnail auth check may close the UI first. Dispatch the normal click
 // synchronously if it still exists, without locator retries after teardown.
 await page.evaluate(()=>document.getElementById('admin-batch-approve')?.click());await expect(page.locator('#admin-content')).toBeHidden();expect(s.posts).toHaveLength(0);
});

test('isolated Preview supports selected detailed review with no real API transport',async({page})=>{
 const requests=[];page.on('request',r=>requests.push(r.url()));page.on('dialog',d=>d.accept());
 await page.goto('http://127.0.0.1:4174/VoteProof/?preview_identity=admin#admin');await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
 await page.getByRole('button',{name:'詳細審核',exact:true}).click();await expect(boxes(page).first()).toBeVisible();await boxes(page).first().check();await approve(page).click();await expect(page.locator('.batch-review-results')).toContainText('成功 1');expect(requests.some(u=>u.includes('/api/'))).toBe(false);
});
