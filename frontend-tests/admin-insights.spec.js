import {test,expect} from '@playwright/test';
import {adminFixture} from './admin-fixture.mjs';
const root=p=>p.locator('#admin-panel');
const tab=async(p,name)=>p.locator('#admin-tabs').getByRole('button',{name,exact:true}).click();
async function setup(page,options={}){
 const state=await adminFixture(page,{autoConfirm:false,...options});state.insights=[];state.writes=[];
 const members=Array.from({length:21},(_,i)=>({member_id:'M-00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),nickname:'合成會員 '+i,fan_id:'fan_'+i,status:'active',created_at:'2026-10-01T00:00:00.000Z',tier:{name:'普通'},total_points:10,proof_counts:{total:3,pending:1,approved:2,rejected:0},login_methods:['Google']}));state.members=members;
 await page.route('**/api/admin/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(!/\/members-overview|\/health-monitor|\/points\/adjustments/.test(path))return route.fallback();
  state.insights.push(path+url.search);
  const reply=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
  if(path.endsWith('/points/adjustments')){state.writes.push({body:req.postDataJSON(),headers:req.headers()});if(state.holdWrite)await state.holdWrite;if(state.lostAck)return route.abort();members[0].total_points+=req.postDataJSON().points;return reply({transaction_id:'synthetic-adjustment',points:req.postDataJSON().points});}
  if(path.endsWith('/summary')){if(state.holdSummary)await state.holdSummary;return reply({upload_failures:{count:null},backup_failures:{count:2},cleanup_failures:{count:0},pending_operations:{count:1,legacy_ack_unverified:true},storage:{used_bytes:1000,budget_bytes:10000000000,observed_at:1,trusted_until:1,blocked:true,cleanup_mode:'dry-run'}});}
  if(path.endsWith('/events'))return reply({events:[{id:'operation:1',created_at:1790812800,type:'operation',code:'unknown_ack',status:'manual'}],next_cursor:null});
  if(path.endsWith('/transactions'))return reply({transactions:[{created_at:'2026-10-01T00:00:00.000Z',category:'manual_adjustment',points:10,reason:'測試紀錄'}],next_cursor:null});
  if(path.endsWith('/cases'))return reply({cases:[],next_cursor:null});
  const id=path.split('/')[4];if(id)return reply({member:members.find(m=>m.member_id===id)});
  return reply({members:url.searchParams.has('cursor')?members.slice(20):members.slice(0,20),next_cursor:url.searchParams.has('cursor')?null:'page2',page_size:20,search_mode:'all'});
 });
 await page.goto('/#admin');return state;
}
const prompts=page=>page.on('dialog',async d=>d.accept(d.type()==='prompt'?(d.message().includes('整數')?'5':'本機測試'):undefined));
test('member pages are bounded, keep applied filters and open history on demand',async({page})=>{
 const s=await setup(page);await tab(page,'會員管理');await expect(root(page).getByRole('button',{name:'詳細資料',exact:true})).toHaveCount(20);
 await root(page).getByLabel('會員搜尋',{exact:true}).fill('not-applied');await root(page).getByRole('button',{name:'下一頁',exact:true}).click();
 await expect(root(page).getByRole('button',{name:'詳細資料',exact:true})).toHaveCount(1);expect(s.insights.at(-1)).toBe('/api/admin/members-overview?status=all&cursor=page2');
 await root(page).getByRole('button',{name:'上一頁',exact:true}).click();await expect(root(page).getByRole('button',{name:'詳細資料',exact:true})).toHaveCount(20);
 expect(s.insights.every(p=>!p.includes('/transactions')&&!p.includes('/cases'))).toBe(true);
 await root(page).getByRole('button',{name:'詳細資料',exact:true}).first().click();await expect(root(page)).toContainText('詳細資料已載入');
 await root(page).getByRole('button',{name:'積分紀錄',exact:true}).click();await expect(root(page)).toContainText('測試紀錄');
 await root(page).getByRole('button',{name:'返回會員列表',exact:true}).click();await expect(root(page).getByRole('button',{name:'詳細資料',exact:true})).toHaveCount(20);
});
test('point adjustment confirms once, retains CSRF/idempotency and blocks overlapping clicks',async({page})=>{
 const s=await setup(page);prompts(page);await tab(page,'會員管理');await root(page).getByRole('button',{name:'詳細資料',exact:true}).first().click();
 let release;s.holdWrite=new Promise(r=>release=r);
 await root(page).getByRole('button',{name:'調整積分',exact:true}).evaluate(b=>{b.click();b.click();});
 await expect.poll(()=>s.writes.length).toBe(1);await expect(root(page).getByRole('button',{name:'調整積分',exact:true})).toBeDisabled();
 expect(s.writes[0].headers['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);expect(s.writes[0].headers['x-csrf-token']).toBe(s.csrf);
 release();await expect(root(page)).toContainText('積分：15');expect(s.writes).toHaveLength(1);
});
test('lost ACK never resends and retains its lock after leaving/reopening member view',async({page})=>{
 const s=await setup(page);s.lostAck=true;prompts(page);await tab(page,'會員管理');await root(page).getByRole('button',{name:'詳細資料',exact:true}).first().click();await root(page).getByRole('button',{name:'調整積分',exact:true}).click();
 await expect(root(page)).toContainText('操作結果尚待確認');await tab(page,'工作總覽');await tab(page,'會員管理');await root(page).getByRole('button',{name:'詳細資料',exact:true}).first().click();
 await expect(root(page).getByRole('button',{name:'調整積分',exact:true})).toBeDisabled();await expect(root(page).getByRole('button',{name:'封鎖會員',exact:true})).toBeDisabled();
 await root(page).getByRole('button',{name:'積分紀錄',exact:true}).click();await expect(root(page)).toContainText('測試紀錄');expect(s.writes).toHaveLength(1);
});
test('cancelled confirmation sends no member mutation',async({page})=>{
 const s=await setup(page);page.on('dialog',d=>d.type()==='confirm'?d.dismiss():d.accept(d.message().includes('整數')?'5':'測試'));
 await tab(page,'會員管理');await root(page).getByRole('button',{name:'詳細資料',exact:true}).first().click();await root(page).getByRole('button',{name:'調整積分',exact:true}).click();await root(page).getByRole('button',{name:'封鎖會員',exact:true}).click();
 expect(s.writes).toEqual([]);expect(s.calls.filter(c=>c.path==='/api/admin/member-blocks'&&c.method==='POST')).toEqual([]);
});
test('health refresh is serialized and polling stops while hidden, after navigation and MFA expiry',async({page})=>{
 await page.clock.install();const s=await setup(page);await tab(page,'系統健康監控');await expect(root(page)).toContainText('unknown_ack');await expect(root(page)).toContainText('快照已過期');await expect(root(page)).toContainText('資料不完整');
 const summaries=()=>s.insights.filter(x=>x.endsWith('/summary')).length;
 let release;s.holdSummary=new Promise(r=>release=r);await root(page).getByRole('button',{name:'立即更新',exact:true}).evaluate(b=>{b.click();b.click();});await expect.poll(summaries).toBe(2);
 await root(page).getByLabel('每 60 秒更新').check();await page.clock.runFor(5000);expect(summaries()).toBe(2);release();s.holdSummary=null;await expect(root(page).getByRole('button',{name:'立即更新',exact:true})).toBeEnabled();
 await page.evaluate(()=>{Object.defineProperties(document,{hidden:{configurable:true,value:true},visibilityState:{configurable:true,value:'hidden'}});document.dispatchEvent(new Event('visibilitychange'));});await page.clock.runFor(120000);expect(summaries()).toBe(2);
 await Promise.all([page.waitForResponse('**/api/admin/me'),page.evaluate(()=>{Object.defineProperties(document,{hidden:{configurable:true,value:false},visibilityState:{configurable:true,value:'visible'}});document.dispatchEvent(new Event('visibilitychange'));})]);await page.clock.runFor(60000);await expect.poll(summaries).toBe(3);
 await tab(page,'工作總覽');const before=s.insights.length;await page.clock.runFor(60000);expect(s.insights.length).toBe(before);
 await tab(page,'系統健康監控');await expect(root(page)).toContainText('unknown_ack');await root(page).getByLabel('每 60 秒更新').check();s.elevationUntil=0;await page.clock.runFor(60000);await expect(page.locator('#admin-gate')).toBeVisible();const stopped=s.insights.length;await page.clock.runFor(60000);expect(s.insights.length).toBe(stopped);
});
test('reviewer cannot access either P1 tab',async({page})=>{
 await setup(page,{role:'reviewer'});for(const name of ['會員管理','系統健康監控'])await expect(page.locator('#admin-tabs').getByRole('button',{name,exact:true})).toHaveCount(0);
});
test('Preview new modules load without errors/404 and both themes remain responsive',async({page,browserName},testInfo)=>{
 await page.addInitScript(()=>{window.cspEvents=[];document.addEventListener('securitypolicyviolation',e=>window.cspEvents.push({directive:e.effectiveDirective,source:e.sourceFile,line:e.lineNumber,column:e.columnNumber,sample:e.sample,tag:e.target?.tagName,hasStyle:e.target?.hasAttribute?.('style')??false,target:e.target?.outerHTML?.slice(0,250)}));});
 const errors=[],bad=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text()+' '+m.location().url);});page.on('response',r=>{if(r.status()>=400)bad.push(r.url());});page.on('request',r=>requests.push(r.url()));
 await page.goto('http://127.0.0.1:4174/VoteProof/?preview_identity=admin#admin');await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
 for(const width of [390,1440])for(const theme of ['dark','light']){
 await page.setViewportSize({width,height:900});if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('#theme-toggle').click();
 await tab(page,'會員管理');await expect(root(page)).toContainText('展示會員・假資料');await root(page).getByRole('button',{name:'詳細資料',exact:true}).click();await expect(root(page)).toContainText('詳細資料已載入');
 await tab(page,'系統健康監控');await expect(root(page)).toContainText('preview_unknown_ack');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
 const csp=await page.evaluate(()=>window.cspEvents);
 await testInfo.attach('csp-events',{body:JSON.stringify(csp),contentType:'application/json'});
 // Windows WebKit reports style-src-attr on native SELECT internals even though
 // the document contains no authored style attribute. Keep CSP intact and
 // assert only native SELECT creation sites without authored style attributes; all other console errors still fail.
 if(browserName==='webkit'&&csp.length){
  expect(csp.every(e=>e.directive==='style-src-attr'&&(!e.source||/\/js\/(admin|admin-members-overview|admin-health-monitor)\.js$/.test(e.source))&&e.tag==='SELECT'&&!e.hasStyle)).toBe(true);
  expect(errors).toHaveLength(csp.length);
  expect(errors.every(e=>e.startsWith('Refused to apply a stylesheet because its hash'))).toBe(true);
 }else expect(errors).toEqual([]);
 expect(bad).toEqual([]);expect(requests.filter(u=>new URL(u).pathname.startsWith('/api/'))).toEqual([]);
});
