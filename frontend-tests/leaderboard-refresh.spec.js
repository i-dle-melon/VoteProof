import {test,expect} from '@playwright/test';
import {memberFixture} from './member-fixture.mjs';
async function fixture(page){
  await page.clock.install();await memberFixture(page);
  await page.addInitScript(()=>{globalThis.__boardVisible=true;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>globalThis.__boardVisible?'visible':'hidden'});});
  const boards=[
    {leaderboard_id:'system-history',name:'歷史累計',type:'all_time'},
    {leaderboard_id:'system-group',name:'團體排行',type:'all_time',vote_type:'團體'},
    {leaderboard_id:'system-solo',name:'Solo 總排行',type:'all_time',vote_type:'Solo'},
    {leaderboard_id:'COMEBACK',name:'本次回歸',type:'campaign',is_current_comeback:true},
    ...[5,6,7].map(n=>({leaderboard_id:'CUSTOM'+n,name:'自訂第'+n+'榜',type:'custom'}))
  ].map(b=>({...b,version:0,rankings:[],generated_at:null}));
  const state={calls:[],points:10,fail:false,delayed:null};
  await page.route('**/api/leaderboards*',async route=>{
    const id=new URL(route.request().url()).searchParams.get('id');state.calls.push(id);
    if(id&&state.delayed)await state.delayed;
    if(id&&state.fail)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'LEADERBOARD_SERVICE_UNAVAILABLE'}})});
    const selected=id?boards.filter(b=>b.leaderboard_id===id).map(b=>({...b,generated_at:'2026-10-22T00:00:00Z',rankings:[{rank:1,member_id:'PUBLIC-MEMBER',nickname:'公開會員',points:state.points,proof_count:1,reached_at:'2026-10-22T00:00:00Z'}]})):boards;
    return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:{leaderboards:selected,custom_boards:boards.filter(b=>b.type==='custom'),generated_at:null}})});
  });return state;
}
test('only selected ranking loads; uniform 10-minute refresh keeps custom fifth/sixth/seventh selection',async({page})=>{
  const s=await fixture(page);await page.goto('/#leaderboards');await expect(page.locator('#board-results')).toContainText('10 點');
  expect(s.calls).toEqual([null,'system-history']);
  for(const n of [5,6,7])await expect(page.locator('#board-categories [data-custom-board="CUSTOM'+n+'"]')).toBeVisible();
  await page.locator('#board-categories [data-custom-board="CUSTOM6"]').click();await expect(page.locator('#board-name')).toHaveText('自訂第6榜');
  s.points=20;await page.clock.fastForward(600000);await expect(page.locator('#board-results')).toContainText('20 點');
  await expect(page.locator('#board-select')).toHaveValue('CUSTOM6');expect(s.calls.filter(Boolean)).toEqual(['system-history','CUSTOM6','CUSTOM6']);
  const count=s.calls.length;await page.locator('#boards-refresh').click();await expect(page.locator('#boards-refresh')).toBeEnabled();expect(s.calls).toHaveLength(count);
});
test('hidden/leave pauses requests and overdue return refreshes once without overlapping calls',async({page})=>{
  const s=await fixture(page);await page.goto('/#leaderboards');await expect(page.locator('#board-results')).toContainText('10 點');
  await page.evaluate(()=>{globalThis.__boardVisible=false;document.dispatchEvent(new Event('visibilitychange'));});
  await page.clock.fastForward(700000);expect(s.calls).toHaveLength(2);
  await page.evaluate(()=>{globalThis.__boardVisible=true;document.dispatchEvent(new Event('visibilitychange'));document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>s.calls.length).toBe(4);await expect(page.locator('#boards-refresh')).toBeEnabled();
  await page.evaluate(()=>{location.hash='lookup';});await expect(page.locator('#view-lookup')).toBeVisible();
  const count=s.calls.length;await page.clock.fastForward(700000);expect(s.calls).toHaveLength(count);
  await page.evaluate(()=>{location.hash='leaderboards';});await expect.poll(()=>s.calls.length).toBe(count+2);
});
test('automatic refresh failure retains last successful table and error; home avoids whole catalog reads',async({page})=>{
  const s=await fixture(page);await page.goto('/#leaderboards');await expect(page.locator('#board-results')).toContainText('10 點');
  s.fail=true;await page.clock.fastForward(600000);await expect(page.locator('#boards-message')).toContainText('保留上次成功成績');
  await expect(page.locator('#board-table')).toBeVisible();await expect(page.locator('#board-results')).toContainText('10 點');
  s.fail=false;await page.locator('#boards-refresh').click();await expect(page.locator('#boards-message')).toHaveText('');
  s.calls.length=0;await page.goto('/#home');await expect(page.locator('#home-board-results')).toContainText('10 點');expect(s.calls).toEqual([]);
  await page.reload();await expect(page.locator('#home-board-results')).toContainText('10 點');expect(s.calls).toEqual(['system-history']);
});
test('Pages fixture shares catalog/detail renderer and retains all seven board buttons without Production calls',async({page})=>{
  const apiRequests=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))apiRequests.push(r.url());});
  await page.goto('http://127.0.0.1:4174/VoteProof/?preview_identity=guest#leaderboards');
  await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
  await expect(page.locator('#board-results tr')).not.toHaveCount(0);
  await expect(page.locator('#board-categories button')).toHaveCount(7);
  await page.locator('#board-categories [data-custom-board]').last().click();
  await expect(page.locator('#board-name')).toHaveText('展示特別活動榜');expect(apiRequests).toEqual([]);
});
