import {test,expect} from '@playwright/test';
import {adminFixture} from './admin-fixture.mjs';

test.use({timezoneId:'America/Los_Angeles'});
async function overview(page,now='2026-11-02T00:30:00Z'){
  await page.clock.setFixedTime(new Date(now));await adminFixture(page);const reads=[];
  await page.route('**/api/admin/overview**',route=>{
    const req=route.request(),u=new URL(req.url());reads.push({method:req.method(),query:Object.fromEntries(u.searchParams)});
    return route.fulfill({json:{ok:true,data:{member_count:u.search?null:98,case_totals:{pending:7,approved:8,rejected:3,revoked:2}}}});
  });
  await page.goto('/#admin');await page.locator('#admin-tabs').getByRole('button',{name:'工作總覽',exact:true}).click();
  await expect(page.getByRole('button',{name:'日期區間',exact:true})).toHaveCount(3);return reads;
}
const rangeButtons=page=>page.getByRole('button',{name:'日期區間',exact:true});

test('overview datetime defaults use Taipei yesterday/today 23:00 across month, year and leap day',async({page})=>{
  await overview(page);
  for(const[now,start,end]of[
    ['2026-11-01T16:30:00Z','2026-11-01T23:00','2026-11-02T23:00'],
    ['2026-10-31T16:30:00Z','2026-10-31T23:00','2026-11-01T23:00'],
    ['2025-12-31T16:30:00Z','2025-12-31T23:00','2026-01-01T23:00'],
    ['2024-02-29T16:30:00Z','2024-02-29T23:00','2024-03-01T23:00'],
  ]){
    await page.clock.setFixedTime(new Date(now));await rangeButtons(page).first().click();const dialog=page.locator('.admin-range-dialog');
    await expect(dialog.getByLabel('開始日期與時間')).toHaveValue(start);await expect(dialog.getByLabel('結束日期與時間')).toHaveValue(end);
    await dialog.getByRole('button',{name:'關閉',exact:true}).click();await expect(dialog).toHaveCount(0);
  }
});

test('overview datetime defaults refresh on reopen after Taipei midnight without reloading',async({page})=>{
  await overview(page,'2026-11-01T15:59:00Z');await rangeButtons(page).first().click();let dialog=page.locator('.admin-range-dialog');
  await expect(dialog.getByLabel('開始日期與時間')).toHaveValue('2026-10-31T23:00');await expect(dialog.getByLabel('結束日期與時間')).toHaveValue('2026-11-01T23:00');
  await dialog.getByLabel('開始日期與時間').fill('2026-10-20T11:22');await dialog.getByRole('button',{name:'關閉',exact:true}).click();
  await page.clock.setFixedTime(new Date('2026-11-01T16:01:00Z'));await rangeButtons(page).first().click();dialog=page.locator('.admin-range-dialog');
  await expect(dialog.getByLabel('開始日期與時間')).toHaveValue('2026-11-01T23:00');await expect(dialog.getByLabel('結束日期與時間')).toHaveValue('2026-11-02T23:00');
});

test('overview datetime all three counts send UTC minute ranges with desktop/mobile dark/light layout',async({page},info)=>{
  const reads=await overview(page),labels=['待審核','已通過','未通過'];
  await page.setViewportSize({width:info.project.name==='desktop-chrome'?1280:320,height:900});
  const totals=await page.locator('#admin-panel .activity-card strong').allTextContents();
  for(const theme of['dark','light']){
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    for(let i=0;i<labels.length;i++){
      await rangeButtons(page).nth(i).click();const dialog=page.locator('.admin-range-dialog'),from=dialog.getByLabel('開始日期與時間'),to=dialog.getByLabel('結束日期與時間');
      await expect(dialog).toContainText(labels[i]);await expect(from).toHaveAttribute('type','datetime-local');await expect(to).toHaveAttribute('type','datetime-local');
      await expect(from).toHaveValue('2026-11-01T23:00');await expect(to).toHaveValue('2026-11-02T23:00');
      await from.fill('2026-11-01T23:17');await to.fill('2026-11-02T22:43');await dialog.getByRole('button',{name:'查詢數量',exact:true}).click();
      await expect(dialog).toContainText(labels[i]+'：'+[7,8,3][i]+' 件（依投稿時間統計）');
      const request=reads.at(-1);expect(request).toEqual({method:'GET',query:{from_at:'2026-11-01T15:17:00.000Z',to_at:'2026-11-02T14:43:00.000Z'}});
      expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
      for(const control of[from,to,dialog.getByRole('button',{name:'查詢數量',exact:true}),dialog.getByRole('button',{name:'關閉',exact:true})]){
        await expect(control).toBeVisible();const box=await control.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual((await page.viewportSize()).width+1);
      }
      if(i===0)await page.screenshot({path:'.wrangler/frontend-previews/overview-datetime-'+info.project.name+'-'+theme+'.png'});
      await dialog.getByRole('button',{name:'關閉',exact:true}).click();
    }
  }
  expect(reads.every(r=>r.method==='GET')).toBe(true);expect(await page.locator('#admin-panel .activity-card strong').allTextContents()).toEqual(totals);
});

test('overview datetime equal, reversed and missing values do not issue range queries',async({page})=>{
  const reads=await overview(page);await rangeButtons(page).first().click();const dialog=page.locator('.admin-range-dialog'),from=dialog.getByLabel('開始日期與時間'),to=dialog.getByLabel('結束日期與時間');
  for(const start of['2026-11-02T23:00','2026-11-03T23:00']){
    await from.fill(start);await to.fill('2026-11-02T23:00');await dialog.getByRole('button',{name:'查詢數量',exact:true}).click();
    await expect(dialog).toContainText('開始早於結束');
  }
  await from.fill('');await dialog.getByRole('button',{name:'查詢數量',exact:true}).click();expect(reads.filter(r=>Object.keys(r.query).length)).toHaveLength(0);
});
