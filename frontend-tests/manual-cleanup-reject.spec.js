import{test,expect}from'@playwright/test';import{randomUUID}from'node:crypto';import{adminFixture}from'./admin-fixture.mjs';
const ok=(route,data)=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
const caseId=n=>'VP-20261101-'+'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n].repeat(16);
async function reviewFixture(page,{count=25,unknown=false,wait=null}={}){
 const state=await adminFixture(page,{autoConfirm:false});const posts=[],statusReads=[];const at='2026-10-01T00:00:00.000Z';
 state.cases=Array.from({length:count},(_,i)=>({...state.cases[0],case_id:caseId(i),created_at:at,updated_at:at,files:[{...state.cases[0].files[0],file_id:randomUUID()}]}));
 await page.route('**/api/admin/cases**',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname,b=req.postData()?req.postDataJSON():null;
  if(p==='/api/admin/cases/initial-review'){
   if(!url.searchParams.has('cutoff'))return ok(route,{total:state.cases.filter(c=>c.status==='pending').length,cutoff:new Date().toISOString()});
   const after=Number(url.searchParams.get('cursor')??-1),rows=state.cases.map((r,i)=>({...r,ordinal:i})).filter(r=>r.status==='pending'&&r.ordinal>after),chosen=rows.slice(0,20);
   return ok(route,{cases:chosen.map(r=>({case_id:r.case_id,expected_version:r.version})),next_cursor:rows.length>20?String(chosen.at(-1).ordinal):null});
  }
  if(p==='/api/admin/cases/batch-reject/status'){
   statusReads.push(b);return ok(route,{results:b.cases.map(i=>{const c=state.cases.find(c=>c.case_id===i.case_id);return c.status==='rejected'?{ok:true,...c}:{ok:false,unknown:true,case_id:i.case_id,code:'REVIEW_RESULT_UNCONFIRMED'};})});
  }
  if(['/api/admin/cases/batch-reject','/api/admin/cases/batch-approve'].includes(p)){
   const reject=p.endsWith('reject');posts.push({p,b,headers:req.headers()});if(wait)await wait;
   const subset=unknown?b.cases.slice(0,1):b.cases;for(const i of subset){const c=state.cases.find(c=>c.case_id===i.case_id);expect(c.version).toBe(i.expected_version);expect(c.status).toBe('pending');c.status=reject?'rejected':'approved';c.version++;c.status_reason=reject?b.reason:null;}
   if(unknown)return route.abort();return ok(route,{results:b.cases.map(i=>({ok:true,...state.cases.find(c=>c.case_id===i.case_id)}))});
  }
  if(p==='/api/admin/cases')return ok(route,{cases:state.cases.filter(c=>c.status==='pending').slice(0,20),next_cursor:null});
  return route.fallback();
 });
 return{state,posts,statusReads};
}
async function enter(page){await page.goto('/#admin');await expect(page.locator('#admin-panel')).toContainText('相簿快速初審');}
test('reject shares selection, requires reason and confirmation; buttons remain exclusive',async({page})=>{
 const f=await reviewFixture(page,{count:3});let reason='',confirms=0;page.on('dialog',async d=>{if(d.type()==='prompt')await d.accept(reason);else{confirms++;await d.accept();}});await enter(page);
 await expect(page.locator('#admin-batch-approve')).toBeDisabled();await expect(page.locator('#admin-batch-reject')).toBeDisabled();
 await page.locator('[data-review-select]').first().check();await expect(page.locator('#admin-batch-approve')).toBeEnabled();await expect(page.locator('#admin-batch-reject')).toBeEnabled();
 await page.locator('#admin-batch-reject').click();await expect(page.locator('.batch-review-results')).toContainText('請填寫');expect(f.posts).toHaveLength(0);expect(confirms).toBe(0);
 reason='Synthetic shared reason';await page.locator('#admin-batch-reject').click();await expect(page.locator('.batch-review-results')).toContainText('成功 1 · 失敗 0');expect(confirms).toBe(1);
 expect(f.posts).toHaveLength(1);expect(f.posts[0].b.reason).toBe(reason);expect(f.posts[0].b.cases).toHaveLength(1);expect(f.posts[0].headers['x-csrf-token']).toBe(f.state.csrf);
 expect(f.state.cases.filter(c=>c.status==='rejected')).toHaveLength(1);expect(f.state.cases.every(c=>c.points_awarded===0)).toBe(true);
 await expect(page.locator('#admin-batch-reject')).toBeDisabled();
});
test('reject all spans metadata pages, four cases per request; first20 and clear selection remain intact',async({page},info)=>{
 const f=await reviewFixture(page);page.on('dialog',d=>d.accept(d.type()==='prompt'?'Synthetic batch rejection':undefined));await enter(page);
 await page.getByRole('button',{name:'選取前20張初審案件',exact:true}).click();await expect(page.locator('[data-review-select]:checked')).toHaveCount(20);
 await page.getByRole('button',{name:'清除目前選取',exact:true}).click();await expect(page.locator('[data-review-select]:checked')).toHaveCount(0);
 await page.getByRole('button',{name:'選取全部未審案件',exact:true}).click();await expect(page.locator('.batch-review-controls')).toContainText('已選全站 25');
 await page.locator('#admin-batch-reject').scrollIntoViewIfNeeded();await page.screenshot({path:'.wrangler/frontend-previews/manual-reject-'+info.project.name+'.png'});
 await page.locator('#admin-batch-reject').click();await expect(page.locator('.batch-review-results')).toContainText('成功 25 · 失敗 0');
 expect(f.posts).toHaveLength(7);expect(f.posts.every(p=>p.b.cases.length<=4&&p.b.reason==='Synthetic batch rejection')).toBe(true);
 expect(new Set(f.posts.flatMap(p=>p.b.cases.map(c=>c.case_id))).size).toBe(25);expect(f.state.cases.every(c=>c.status==='rejected'&&c.version===1&&c.points_awarded===0)).toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('reject lost ACK only queries status, retains successes and stops subsequent chunks',async({page})=>{
 const f=await reviewFixture(page,{unknown:true});page.on('dialog',d=>d.accept(d.type()==='prompt'?'Reason':undefined));await enter(page);await page.getByRole('button',{name:'選取全部未審案件',exact:true}).click();await page.locator('#admin-batch-reject').click();
 await expect(page.locator('.batch-review-results')).toContainText('未確認 3');expect(f.posts).toHaveLength(1);expect(f.statusReads).toHaveLength(1);expect(f.state.cases.filter(c=>c.status==='rejected')).toHaveLength(1);expect(f.state.cases.every(c=>c.points_awarded===0)).toBe(true);
});
test('reject stop finishes only current chunk, and never runs approve concurrently',async({page})=>{
 let release;const wait=new Promise(r=>release=r),f=await reviewFixture(page,{wait});page.on('dialog',d=>d.accept(d.type()==='prompt'?'Reason':undefined));await enter(page);await page.getByRole('button',{name:'選取全部未審案件',exact:true}).click();
 try{await page.locator('#admin-batch-reject').click();await expect.poll(()=>f.posts.length).toBe(1);await expect(page.locator('#admin-batch-approve')).toBeDisabled();await page.getByRole('button',{name:'停止後續批次'}).click();release();await expect(page.locator('.batch-review-results')).toContainText('已停止');expect(f.posts).toHaveLength(1);expect(f.state.cases.filter(c=>c.status==='rejected')).toHaveLength(4);}finally{release();}
});
async function cleanupFixture(page,{unknown=false,wait=null,enabled=true}={}){
 const state=await adminFixture(page,{autoConfirm:false}),at='2026-10-01T00:00:00.000Z',cutoff=new Date().toISOString(),calls=[];
 const rows=Array.from({length:25},(_,i)=>({file_id:randomUUID(),case_id:caseId(i),case_version:2,backup_version:1,size:3,status:'completed',eligible:true,cleanup_state:null,reason:'執行前將即時驗證Drive',ordinal:i}));
 await page.route('**/api/admin/storage/manual**',async route=>{
  const r=route.request(),u=new URL(r.url()),p=u.pathname,body=r.postData()?r.postDataJSON():null;calls.push({p,method:r.method(),body});
  if(p==='/api/admin/storage/manual'){
   const all=rows.filter(r=>r.cleanup_state===null),after=Number(u.searchParams.get('cursor')??-1),chosen=all.filter(r=>r.ordinal>after).slice(0,20);
   return ok(route,{enabled,cutoff,total:all.length,eligible_count:all.length,eligible_bytes:all.length*3,items:chosen,next_cursor:all.filter(r=>r.ordinal>after).length>20?String(chosen.at(-1).ordinal):null});
  }
  const row=rows.find(x=>p.includes(x.file_id));if(p.endsWith('/verify'))return ok(route,{file_id:row.file_id,state:'verified',attempt_id:body.attempt_id});
  if((p.endsWith('/delete')||p.endsWith('/clean'))){if(wait)await wait;row.cleanup_state=unknown?'deleting':'cold';return ok(route,{file_id:row.file_id,state:unknown?'unknown':'deleted'});}
  if(p.endsWith('/status'))return ok(route,{state:row.cleanup_state==='cold'?'deleted':'unknown'});
 });
 await page.goto('/#admin');await page.getByRole('button',{name:'R2 手動清理',exact:true}).click();await expect(page.locator('#admin-panel')).toContainText('已選 0 張');return{state,rows,calls,initialImageReads:state.calls.filter(c=>c.path.includes('/files/')).length};
}
test('manual cleanup all covers 25 files over pages, first20 is stable and each file has independent verified cleanup',async({page},info)=>{
 const f=await cleanupFixture(page);page.on('dialog',d=>d.accept());
 await page.getByRole('button',{name:'選取前20張可清理圖片',exact:true}).click();await expect(page.locator('#admin-panel')).toContainText('已選 20 張');
 const chosen=await page.locator('#admin-panel input[type=checkbox]:checked').evaluateAll(a=>a.map(x=>x.getAttribute('aria-label')));expect(chosen).toHaveLength(20);
 await page.getByRole('button',{name:'清除目前選取',exact:true}).click();await page.getByRole('button',{name:'選取前20張可清理圖片',exact:true}).click();await expect(page.locator('#admin-panel input[type=checkbox]:checked')).toHaveCount(20);expect(await page.locator('#admin-panel input[type=checkbox]:checked').evaluateAll(a=>a.map(x=>x.getAttribute('aria-label')))).toEqual(chosen);
 await page.getByRole('button',{name:'選取全部可清理圖片',exact:true}).click();await expect(page.locator('#admin-panel')).toContainText('已選 25 張 · 預計釋放 75 bytes');
 await page.screenshot({path:'.wrangler/frontend-previews/manual-cleanup-'+info.project.name+'.png'});await page.getByRole('button',{name:'確認清理已選圖片',exact:true}).click();
 await expect(page.locator('#admin-panel')).toContainText('已處理 25/25 · 已清理 25');expect(f.calls.filter(c=>c.p.endsWith('/clean'))).toHaveLength(25);
 for(const row of f.rows){const operations=f.calls.filter(c=>c.p.includes(row.file_id)&&c.method==='POST');expect(operations.map(c=>c.p.split('/').at(-1))).toEqual(['clean']);expect(operations[0].body.file_id).toBe(row.file_id);}
 await expect(page.getByRole('button',{name:'確認清理已選圖片',exact:true})).toBeDisabled();expect(f.state.calls.filter(c=>c.path.includes('/files/'))).toHaveLength(f.initialImageReads);
});
test('manual cleanup unknown stops without re-delete',async({page})=>{
 const f=await cleanupFixture(page,{unknown:true});page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'選取全部可清理圖片',exact:true}).click();await page.getByRole('button',{name:'確認清理已選圖片',exact:true}).click();await expect(page.locator('#admin-panel')).toContainText('未確認 1');
 expect(f.calls.filter(c=>c.p.endsWith('/clean'))).toHaveLength(1);await expect(page.locator('#admin-panel input[type=checkbox]').first()).toBeDisabled();
});
test('manual all-page selection retains individual exclusions across pagination',async({page})=>{
 const f=await cleanupFixture(page);page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'選取全部可清理圖片',exact:true}).click();await expect(page.locator('#admin-panel')).toContainText('已選 25 張');
 const omitted=f.rows[0].file_id;await page.getByRole('checkbox',{name:'選取圖片 '+omitted,exact:true}).uncheck();await expect(page.locator('#admin-panel')).toContainText('已選 24 張 · 預計釋放 72 bytes');
 await page.getByRole('button',{name:'載入更多',exact:true}).click();await expect(page.locator('#admin-panel input[type=checkbox]:checked')).toHaveCount(24);
 await page.getByRole('button',{name:'確認清理已選圖片',exact:true}).click();await expect(page.locator('#admin-panel')).toContainText('已處理 24/24 · 已清理 24');expect(f.calls.filter(c=>c.p.endsWith('/clean'))).toHaveLength(24);expect(f.calls.some(c=>c.method==='POST'&&c.p.includes(omitted))).toBe(false);expect(f.rows[0].cleanup_state).toBeNull();
});
test('disabled manual policy permits only metadata reads',async({page})=>{
 const f=await cleanupFixture(page,{enabled:false});await page.getByRole('button',{name:'選取前20張可清理圖片',exact:true}).click();await expect(page.locator('#admin-panel')).toContainText('已選 20 張');await expect(page.getByRole('button',{name:'確認清理已選圖片',exact:true})).toBeDisabled();expect(f.calls.every(c=>c.method==='GET')).toBe(true);
});
test('admin navigation nests membership tools and date counts are GET only',async({page},info)=>{
 await adminFixture(page);await page.route('**/api/admin/members-overview**',r=>ok(r,{members:[],page_size:20,next_cursor:null}));const reads=[];
 await page.route('**/api/admin/overview**',route=>{reads.push(route.request().method());return ok(route,{member_count:98,case_totals:{pending:7,approved:8,rejected:3,revoked:0}});});
 await page.goto('/#admin');const tabs=page.locator('#admin-tabs');await expect(tabs.getByRole('button',{name:'會員等級',exact:true})).toHaveCount(0);await expect(tabs.getByRole('button',{name:'會員封鎖',exact:true})).toHaveCount(0);
 const names=await tabs.locator('button').allTextContents();expect(names.indexOf('彈窗公告')).toBeLessThan(names.indexOf('會員管理'));expect(names.indexOf('系統健康監控')+1).toBe(names.indexOf('操作紀錄'));
 await tabs.getByRole('button',{name:'會員管理',exact:true}).click();const bar=page.locator('.admin-panel-toolbar');await expect(bar.getByRole('button',{name:'會員等級',exact:true})).toBeVisible();await expect(bar.getByRole('button',{name:'會員封鎖',exact:true})).toBeVisible();
 const reload=await bar.getByRole('button',{name:'重新載入',exact:true}).boundingBox(),tools=await bar.locator('nav').boundingBox();expect(reload.x).toBeGreaterThan(tools.x);
 await tabs.getByRole('button',{name:'工作總覽',exact:true}).click();await expect(page.getByRole('button',{name:'日期區間',exact:true})).toHaveCount(3);await page.getByRole('button',{name:'日期區間',exact:true}).first().click();
 const dialog=page.locator('.admin-range-dialog');await dialog.locator('input[type=date]').first().fill('2026-10-01');await dialog.locator('input[type=date]').last().fill('2026-10-31');await dialog.getByRole('button',{name:'查詢數量',exact:true}).click();await expect(dialog).toContainText('待審核：7 件');expect(reads.every(m=>m==='GET')).toBe(true);
 await page.screenshot({path:'.wrangler/frontend-previews/admin-date-range-'+info.project.name+'.png'});
});
test('a visible current-comeback campaign also gets its own named ranking button',async({page})=>{
 await adminFixture(page);const defs=[{leaderboard_id:'system-history',name:'歷史累計',type:'all_time',vote_type:null,system_fixed:true,top_n:100},{leaderboard_id:'mama-one',name:'2026 MAMA 第一輪',type:'campaign',is_current_comeback:false},{leaderboard_id:'mama-two',name:'2026 MAMA 第二輪',type:'campaign',is_current_comeback:true}];
 await page.route('**/api/leaderboards**',route=>{const id=new URL(route.request().url()).searchParams.get('id');return ok(route,{leaderboards:(id?defs.filter(b=>b.leaderboard_id===id):defs).map(b=>({...b,version:1,rankings:[],generated_at:null})),generated_at:null});});
 await page.goto('/#leaderboards');await expect(page.locator('[data-custom-board="mama-two"]')).toBeVisible();await page.locator('[data-custom-board="mama-two"]').click();await expect(page.locator('#board-select')).toHaveValue('mama-two');await expect(page.locator('[data-custom-board="mama-two"]')).toHaveAttribute('aria-pressed','true');
});
test('isolated Preview mocks reject and keeps manual cleanup read-only without API transport',async({page})=>{
 const realApi=[],errors=[];page.on('request',r=>{const u=new URL(r.url());if(u.pathname.includes('/api/'))realApi.push(u.origin+u.pathname);});page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept(d.type()==='prompt'?'Preview reason':undefined));
 await page.goto('http://127.0.0.1:4174/VoteProof/?preview_identity=admin#admin');await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');await page.locator('#admin-tabs').getByRole('button',{name:'案件審核',exact:true}).click();await page.locator('[data-review-select]').first().check();await page.locator('#admin-batch-reject').click();await expect(page.locator('.batch-review-results')).toContainText('成功 1');
 await page.locator('#admin-tabs').getByRole('button',{name:'R2 手動清理',exact:true}).click();await expect(page.locator('#admin-panel')).toContainText('目前只提供唯讀候選清單');await expect(page.getByRole('button',{name:'確認清理已選圖片',exact:true})).toBeDisabled();expect(realApi).toEqual([]);expect(errors).toEqual([]);
});
