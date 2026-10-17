import {test,expect} from './isolated-ui-fixture.mjs';
import {adminFixture} from './admin-fixture.mjs';
import {memberFixture} from './member-fixture.mjs';
test.use({timezoneId:'America/Los_Angeles'});
const preview='http://127.0.0.1:4174/VoteProof/';
const tab=async(page,name)=>{await page.locator('#admin-tabs').getByRole('button',{name,exact:true}).click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');};
test('member best public rank ignores API ordering and empty ranks remain honest',async({page})=>{
 const state=await memberFixture(page,{authenticated:true});
 const boards=[8,2,5].map((rank,i)=>({leaderboard_id:'B'+i,name:'Board '+i,type:i===1?'campaign':'all_time',is_current_comeback:i===1,vote_type:i===2?'Solo':null,rankings:[{rank,member_id:state.member.member_id,nickname:'Member',points:60,proof_count:3}]}));
 await page.route('**/api/leaderboards*',r=>r.fulfill({json:{ok:true,data:{leaderboards:boards,custom_boards:[]}}}));
 for(let i=0;i<2;i++){await page.goto('/#member');await expect(page.locator('#member-public-rank')).toHaveText('#2');boards.reverse();}
 for(const b of boards)b.rankings=[];await page.reload();await expect(page.locator('#member-public-rank')).toHaveText('尚未上榜');
});
test('comeback is explicit and non-featured campaigns retain named buttons',async({page})=>{
 await memberFixture(page);const boards=[{leaderboard_id:'old',type:'campaign',name:'Old named board',rankings:[]},{leaderboard_id:'new',type:'campaign',name:'Selected board',is_current_comeback:true,rankings:[]}];
 await page.route('**/api/leaderboards*',r=>r.fulfill({json:{ok:true,data:{leaderboards:boards,custom_boards:[]}}}));
 await page.goto('/#leaderboards');await page.locator('[data-category=comeback]').click();await expect(page.locator('#board-name')).toHaveText('Selected board');
 await page.locator('[data-custom-board=old]').click();await expect(page.locator('#board-name')).toHaveText('Old named board');
 boards[1].is_current_comeback=false;await page.locator('#boards-refresh').click();await page.locator('[data-category=comeback]').click();await expect(page.locator('#board-name')).toHaveText('');await expect(page.locator('#board-table')).toBeHidden();
});
test('new Campaign defaults, underscore copy and authoritative Solo dropdown remain intact',async({page})=>{
 const s=await adminFixture(page);await page.goto('/#admin');await tab(page,'活動管理');await page.getByRole('button',{name:'建立活動',exact:true}).click();
 await expect(page.getByLabel('活動代號（必填）')).toHaveAttribute('placeholder','英文、數字、連字號或底線');
 await expect(page.locator('#admin-field-points_per_proof')).toHaveValue('10');await expect(page.locator('#admin-field-daily_mode')).toHaveValue('unlimited');await expect(page.locator('#admin-field-daily_limit')).toBeDisabled();await expect(page.locator('#admin-field-status')).toHaveValue('active');
 for(const [key,value]of [['campaign_id','2026_MAMA_FANS_CHOICE'],['name','New Campaign'],['start_at','2026-10-01T00:00'],['end_at','2026-12-31T00:00']])await page.locator('#admin-field-'+key).fill(value);
 await page.locator('#admin-field-solo_target').selectOption('yuqi');await page.getByRole('button',{name:'保存活動',exact:true}).click();
 await expect.poll(()=>s.calls.find(c=>c.path==='/api/admin/campaigns'&&c.method==='POST')?.body).toMatchObject({campaign_id:'2026_MAMA_FANS_CHOICE',points_per_proof:10,daily_limit:null,status:'active'});
});
test('leaderboard create defaults, generated identity, current selection and historical Campaign dropdown',async({page})=>{
 const s=await adminFixture(page);s.campaigns.push({...s.campaigns[0],campaign_id:'CLOSED',name:'Historical',status:'closed'},{...s.campaigns[0],campaign_id:'ARCHIVED',name:'Archive',status:'archived'});
 await page.goto('/#admin');await tab(page,'排行榜管理');await page.getByRole('button',{name:'建立排行榜',exact:true}).click();
 await expect(page.locator('#admin-field-leaderboard_id')).toHaveCount(0);await expect(page.locator('#admin-field-top_n')).toHaveValue('10');await expect(page.locator('#admin-field-is_public')).toHaveValue('true');await expect(page.locator('#admin-field-status')).toHaveValue('active');
 await expect(page.locator('#admin-field-campaign_id')).toHaveJSProperty('tagName','SELECT');await expect(page.locator('#admin-field-campaign_id option[value=LOCAL]')).toHaveText('本機應援活動 · LOCAL');await expect(page.locator('#admin-field-campaign_id option[value=ARCHIVED]')).toHaveCount(0);
 await expect(page.locator('#admin-field-is_current_comeback')).toBeDisabled();await page.locator('#admin-field-type').selectOption('campaign');await page.locator('#admin-field-name').fill('Featured');await page.locator('#admin-field-campaign_id').selectOption('CLOSED');await page.getByLabel('設為本次回歸',{exact:true}).check();
 await page.getByRole('button',{name:'保存排行榜',exact:true}).click();
 await expect.poll(()=>s.calls.find(c=>c.path==='/api/admin/leaderboards'&&c.method==='POST')?.body).toMatchObject({is_current_comeback:true,campaign_id:'CLOSED',top_n:10,is_public:true,status:'active'});
 expect(s.calls.find(c=>c.path==='/api/admin/leaderboards'&&c.method==='POST').body).not.toHaveProperty('leaderboard_id');
 s.boards[0].campaign_id='ARCHIVED';await tab(page,'排行榜管理');await page.getByRole('button',{name:'查看設定',exact:true}).first().click();await expect(page.locator('#admin-field-campaign_id')).toHaveValue('ARCHIVED');await expect(page.locator('#admin-field-campaign_id option[value=ARCHIVED]')).toContainText('已封存');await expect(page.locator('#admin-field-leaderboard_id')).toHaveAttribute('readonly','');
});
test('Drive backup has own authorized tab and is absent from all Cases',async({page})=>{
 const s=await adminFixture(page);await page.goto('/#admin');await page.getByRole('button',{name:'全部案件',exact:true}).click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
 expect(s.calls.some(c=>c.path==='/api/admin/backups')).toBe(false);await tab(page,'Google Drive 備份');expect(s.calls.some(c=>c.path==='/api/admin/backups')).toBe(true);await expect(page.locator('#admin-panel')).toContainText('Google Drive 備份');
});
test('reviewer cannot see or load the Drive management tab',async({page})=>{
 const s=await adminFixture(page,{role:'reviewer'});await page.goto('/#admin');await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');await expect(page.getByRole('button',{name:'Google Drive 備份',exact:true})).toHaveCount(0);expect(s.calls.some(c=>c.path==='/api/admin/backups')).toBe(false);
});
test('only owner has rightmost staff management; normal Admin cannot grant and reviewer has exactly three tabs',async({page})=>{
 const s=await adminFixture(page,{role:'super_admin'});await page.goto('/#admin');await expect(page.locator('#admin-tabs button').last()).toHaveText('管理員管理');await tab(page,'管理員管理');
 await page.getByLabel('對方的 Google 帳號',{exact:true}).fill('staff-fixture@example.com');await page.locator('#admin-field-staff_role').selectOption('admin');await page.getByRole('button',{name:'確認新增權限',exact:true}).click();await expect(page.locator('#admin-panel')).toContainText('Fixture staff');expect(s.calls.find(c=>c.path==='/api/admin/staff'&&c.method==='POST').body).toEqual({email:'staff-fixture@example.com',role:'admin'});
});
test('ordinary Admin lacks staff page while reviewer can enter export with its required Campaign metadata',async({page})=>{
 const s=await adminFixture(page);await page.goto('/#admin');await expect(page.getByRole('button',{name:'管理員管理',exact:true})).toHaveCount(0);
 s.role='reviewer';await page.reload();await expect(page.locator('#admin-tabs button')).toHaveText(['工作總覽','案件審核','圖片批次匯出']);await tab(page,'圖片批次匯出');await expect(page.locator('.image-export')).toBeVisible();await expect(page.locator('#admin-gate')).toBeHidden();
});
test('layout, left help button, bottom sidebar and paused danger capsule in both themes',async({page})=>{
 for(const width of [320,390,430,1024,1440])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:1000});await page.goto(preview+'?preview_identity=admin&preview_gate=off&preview_theme='+theme+'#home');await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
  await expect(page.locator('#submission-gate-message')).toHaveClass(/submission-paused/);
  const styles=await page.locator('#submission-gate-message').evaluate(e=>({color:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor,radius:getComputedStyle(e).borderRadius,danger:getComputedStyle(e).getPropertyValue('--danger').trim()}));
  expect(styles.radius).toBe('999px');expect(styles.bg).not.toBe('rgba(0, 0, 0, 0)');
  const isDanger=await page.locator('#submission-gate-message').evaluate(e=>{const x=document.createElement('span');x.style.color='var(--danger)';e.append(x);const same=getComputedStyle(e).color===getComputedStyle(x).color;x.remove();return same;});expect(isDanger).toBe(true);
  await expect(page.locator('a[href="#lookup"] .hero-action-icon')).toHaveText('▣');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(width>980){const help=await page.locator('#workflow-help').boundingBox(),title=await page.locator('.desktop-title').boundingBox(),controls=await page.locator('.account-nav').boundingBox(),footer=await page.locator('.sidebar-footer').boundingBox();expect(help.x-title.x-title.width).toBeGreaterThan(10);expect(help.x-title.x-title.width).toBeLessThan(30);expect(controls.x-help.x-help.width).toBeGreaterThan(30);expect(width-controls.x-controls.width).toBeLessThan(60);expect(1000-footer.y-footer.height).toBeLessThan(40);}
  await page.goto(preview+'?preview_identity=admin&preview_theme='+theme+'#admin');await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');await tab(page,'排行榜管理');await expect(page.locator('.status.neutral').filter({hasText:'系統固定榜'})).toHaveCount(3);await expect(page.locator('.status.approved').filter({hasText:'系統固定榜'})).toHaveCount(0);
 }
});
test('browser local calendar default, campaign clamp and manual edits survive selection',async({page})=>{
 await page.clock.install({time:new Date('2026-10-16T01:00:00Z')});
 await memberFixture(page,{authenticated:true});
 const today=await page.evaluate(()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');});
 expect(today).toBe('2026-10-15');
 const campaigns=[{campaign_id:'A',name:'Local date',category:'Solo',start_at:'2000-01-01T00:00:00Z',end_at:'2100-01-01T00:00:00Z',status:'active',vote_start_date:'2026-10-01',vote_end_date:'2026-10-31',daily_limit:null,points_per_proof:10},{campaign_id:'B',name:'Clamp',category:'團體',start_at:'2000-01-01T00:00:00Z',end_at:'2100-01-01T00:00:00Z',status:'active',vote_start_date:'2026-10-01',vote_end_date:'2026-10-12',daily_limit:null,points_per_proof:10}];
 await page.route('**/api/campaigns',r=>r.fulfill({json:{ok:true,data:{campaigns}}}));await page.goto('/#submit');await expect(page.locator('#vote-date')).toHaveValue(today);
 await page.locator('#campaign').selectOption('B');await expect(page.locator('#vote-date')).toHaveValue('2026-10-12');await page.locator('#campaign').selectOption('A');await expect(page.locator('#vote-date')).toHaveValue(today);
 await page.locator('#vote-date').fill('2026-10-10');await page.locator('#campaign').selectOption('B');await expect(page.locator('#vote-date')).toHaveValue('2026-10-10');
});
// Component Worker double verifies UI orchestration/cancellation only. Real ZIP
// bytes and private transport are still covered by export-zip and transport CI.
async function exportComponent(page){
 await adminFixture(page);
 await page.addInitScript(()=>{
  window.showSaveFilePicker=undefined;window.__zip={active:0,max:0,starts:[],downloads:[],delay:40,fail:false};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){if(this.download&&this.href.startsWith('blob:')){window.__zip.downloads.push(this.download);return;}return click.call(this);};
  window.Worker=class{
   constructor(){this.alive=true;window.__zip.active++;window.__zip.max=Math.max(window.__zip.max,window.__zip.active);}
   postMessage(d){if(d.type==='start'){window.__zip.starts.push(Number(d.proofBase.match(/packages\/(\d+)/)[1]));setTimeout(()=>{if(this.alive)this.onmessage?.({data:window.__zip.fail?{type:'error',code:'EXPORT_PROOF_UNAVAILABLE'}:{type:'chunk',bytes:new Uint8Array([80,75,5,6]).buffer}});},window.__zip.delay);}else if(d.type==='ack')setTimeout(()=>{if(this.alive)this.onmessage?.({data:{type:'done'}});},0);}
   terminate(){if(this.alive){this.alive=false;window.__zip.active--;}}
  };
 });
 const job={id:'00000000-0000-4000-8000-000000000099',created_at:'2026-10-01T00:00:00Z',campaign_name:'Fixture',filters:{package_bytes:67108864,from:'2026-10-01T00:00',to:'2026-10-02T00:00'},image_count:3,total_bytes:9,packages:[1,2,3].map(number=>({number,image_count:1,total_bytes:3,status:number===2?'completed':'planned',attempt_id:number===2?'00000000-0000-4000-8000-000000000002':null}))},calls=[];
 await page.route('**/api/admin/image-exports**',async route=>{
  const path=new URL(route.request().url()).pathname,body=route.request().postDataJSON(),number=Number(path.match(/packages\/(\d+)/)?.[1]),p=job.packages.find(p=>p.number===number);calls.push({path,body});
  let data=path==='/api/admin/image-exports'?{jobs:[job]}:job;
  if(path.endsWith('/start')){const readOnly=p.status==='completed';if(!readOnly){p.status='in_progress';p.attempt_id=body.attempt_id;}data={package:p,read_only:readOnly,items:[{file_size:3}]};}
  if(path.endsWith('/state')){p.status=body.status;data=p;}
  return route.fulfill({json:{ok:true,data}});
 });
 await page.goto('/#admin');await tab(page,'圖片批次匯出');await expect(page.locator('.export-package')).toHaveCount(3);return{job,calls};
}
test('completed re-download failure/cancel preserves completed package without state writes',async({page})=>{
 const {job,calls}=await exportComponent(page),second=page.locator('[data-package="2"]');
 await expect(second.getByRole('button',{name:'再次下載',exact:true})).toBeEnabled();
 await page.evaluate(()=>{window.__zip.fail=true;});await second.getByRole('button',{name:'再次下載',exact:true}).click();await expect(page.locator('.image-export')).toContainText('原本已完成狀態保持不變');expect(job.packages[1].status).toBe('completed');
 await page.evaluate(()=>{window.__zip.fail=false;window.__zip.delay=500;});await second.getByRole('button',{name:'再次下載',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('.image-export')).toContainText('再次下載已取消');expect(job.packages[1].status).toBe('completed');expect(calls.some(c=>c.path.endsWith('/packages/2/state'))).toBe(false);
});
test('batch all downloads every package in order, one Worker at a time including completed',async({page})=>{
 const {job,calls}=await exportComponent(page);
 await page.getByRole('button',{name:'批次全下載',exact:true}).click();await expect(page.locator('.image-export')).toContainText('全部套件已依序產生');
 expect(await page.evaluate(()=>window.__zip.starts)).toEqual([1,2,3]);expect(await page.evaluate(()=>window.__zip.max)).toBe(1);expect(await page.evaluate(()=>window.__zip.downloads)).toHaveLength(3);expect(job.packages.every(p=>p.status==='completed')).toBe(true);expect(calls.some(c=>c.path.endsWith('/packages/2/state'))).toBe(false);await expect(page.locator('.image-export')).toContainText('瀏覽器權限');
});
test('batch cancellation stops before the next package without corrupting completed ones',async({page})=>{
 const {job}=await exportComponent(page);await page.evaluate(()=>{window.__zip.delay=500;});await page.getByRole('button',{name:'批次全下載',exact:true}).click();await page.getByRole('button',{name:'停止批次下載',exact:true}).click();await expect(page.getByRole('button',{name:'批次全下載',exact:true})).toBeEnabled();expect(await page.evaluate(()=>window.__zip.starts)).toEqual([1]);expect(job.packages[0].status).toBe('completed');expect(job.packages[1].status).toBe('completed');expect(job.packages[2].status).toBe('planned');
});
