import {test,expect} from '@playwright/test';
import {adminFixture} from './admin-fixture.mjs';
const reply=(route,data)=>route.fulfill({json:{ok:true,data}});

for(const enabled of[undefined,false,true])test(`fixed presentation UI requires explicit capability: ${String(enabled)}`,async({page})=>{
 const state=await adminFixture(page),posts=[];
 const fixed=['history','group','solo'].map((id,i)=>({leaderboard_id:'system-'+id,name:['歷史累計','團體排行','Solo 總排行'][i],
  type:'all_time',system_fixed:true,status:'active',is_public:true,top_n:100,version:0,
  ...(enabled===undefined?{}:{presentation_enabled:enabled})}));
 await page.route('**/api/admin/leaderboards**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(req.method()==='GET'&&path==='/api/admin/leaderboards')return reply(route,{leaderboards:state.boards,system_boards:fixed,next_cursor:null});
  if(req.method()==='POST'&&path.endsWith('/presentation')){
   expect(enabled).toBe(true);const body=req.postDataJSON();posts.push({path,body,headers:req.headers()});
   const row=fixed.find(b=>path.includes('/'+b.leaderboard_id+'/'));Object.assign(row,body,{version:row.version+1});return reply(route,row);
  }
  return route.fallback();
 });
 await page.goto('/#admin');await page.locator('#admin-tabs').getByRole('button',{name:'排行榜管理',exact:true}).click();
 const panel=page.locator('#admin-panel'),cards=panel.locator('article').filter({hasText:'系統固定計分範圍'});
 await expect(cards).toHaveCount(3);
 await expect(panel.getByRole('button',{name:'查看設定',exact:true})).toBeVisible();
 if(enabled!==true){
  await expect(panel.getByRole('button',{name:'設定顯示',exact:true})).toHaveCount(0);
  await expect(panel.getByRole('button',{name:'保存顯示設定',exact:true})).toHaveCount(0);
  await expect(cards.getByText('顯示設定尚未啟用；目前維持既有排行榜設定。',{exact:true})).toHaveCount(3);
  expect(posts).toEqual([]);return;
 }
 await expect(cards.getByRole('button',{name:'設定顯示',exact:true})).toHaveCount(3);
 await cards.first().getByRole('button',{name:'設定顯示',exact:true}).click();
 await page.getByLabel('按鈕顯示名稱',{exact:true}).fill('新歷史名稱');
 await panel.getByRole('button',{name:'保存顯示設定',exact:true}).click();
 await expect(panel.locator('h3').filter({hasText:'新歷史名稱'})).toBeVisible();
 expect(posts).toHaveLength(1);expect(posts[0].body).toEqual({name:'新歷史名稱',top_n:100,is_public:true,expected_version:0});
 expect(posts[0].headers['x-csrf-token']).toBe(state.csrf);expect(posts[0].headers['x-voteproof-request']).toBe('1');
});
