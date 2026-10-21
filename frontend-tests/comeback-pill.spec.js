import {test,expect} from '@playwright/test';
import {adminFixture} from './admin-fixture.mjs';
test('comeback matches completed green pill without checkmark; open/public labels and board rules stay unchanged',async({page})=>{
 const state=await adminFixture(page);state.boards[0].is_current_comeback=true;
 state.boards.push({...state.boards[0],leaderboard_id:'OTHER',name:'其他排行榜',is_current_comeback:false});
 await page.goto('/#admin');await page.locator('#admin-tabs').getByRole('button',{name:'排行榜管理',exact:true}).click();
 const badge=page.locator('#admin-panel .status.comeback');await expect(badge).toHaveText('本次回歸');await expect(badge).toHaveCount(1);
 const card=page.getByRole('heading',{name:'本機公開成績',exact:true}).locator('..');
 await expect(card.locator(':scope > .status').first()).toHaveClass('status');
 const open=await card.locator(':scope > .status').first().textContent();expect(open).toBe('開放');
 await expect(card.locator('p').first()).toHaveText('公開');
 await expect(page.getByRole('heading',{name:'其他排行榜',exact:true}).locator('..').locator('.status.comeback')).toHaveCount(0);
 for(const width of [320,390,430,1024,1440])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:900});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  const result=await badge.evaluate(target=>{
   const reference=document.createElement('span');reference.className='status completed';reference.textContent='已完成';target.parentNode.append(reference);
   const properties=['color','backgroundColor','borderRadius','paddingTop','paddingRight','paddingBottom','paddingLeft','fontSize','fontWeight'];
   const a=getComputedStyle(target),b=getComputedStyle(reference),equal=properties.every(key=>a[key]===b[key]);
   const icon=getComputedStyle(target,'::before').content;reference.remove();return {equal,icon,overflow:document.documentElement.scrollWidth>innerWidth};
  });
  expect(result.equal).toBe(true);expect(['none','normal','""']).toContain(result.icon);expect(result.overflow).toBe(false);
 }
 expect(state.calls.some(c=>c.method==='POST'&&c.path.includes('leaderboards'))).toBe(false);
});
