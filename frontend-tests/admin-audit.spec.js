import {test,expect} from '@playwright/test';
import {adminFixture} from './admin-fixture.mjs';
const root=page=>page.locator('#admin-panel');
async function setup(page,n=45){const state=await adminFixture(page);state.audit=Array.from({length:n},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,source:'admin',created_at:'2026-10-23T02:00:00.000Z',actor_kind:i===1?'system':'admin',operator_fan_id:i===2?null:'FAN_ADMIN_01',action:'campaign_update',target_type:'campaign',target_id:'LOCAL-'+i,reason:'調整活動 '+i,before:{status:'draft',private:'do-not-render',object_key:'private-image'},after:{status:'active',note:'<img src=x onerror="window.unsafe=1">'}}));await page.goto('/#admin');await page.locator('#admin-tabs').getByRole('button',{name:'操作紀錄',exact:true}).click();await expect(root(page).locator('tbody tr')).toHaveCount(Math.min(n,20));return state;}
test('audit shows Fan ID/system/fallback with bounded cursor paging and visited-page jumps',async({page})=>{
 const state=await setup(page);await expect(root(page)).toContainText('FAN_ADMIN_01');await expect(root(page)).toContainText('系統');await expect(root(page)).toContainText('管理員（未提供粉絲 ID）');await expect(root(page)).not.toContainText(state.member.member_id);
 await root(page).getByRole('button',{name:'下一頁',exact:true}).click();await expect(root(page)).toContainText('第 2 頁');await expect(root(page)).toContainText('LOCAL-20');
 await root(page).getByRole('button',{name:'上一頁',exact:true}).click();await expect(root(page)).toContainText('LOCAL-0');
 await root(page).getByLabel('已瀏覽頁碼',{exact:true}).fill('2');await root(page).getByRole('button',{name:'前往',exact:true}).click();await expect(root(page)).toContainText('LOCAL-20');
 const before=state.calls.length;await root(page).getByLabel('已瀏覽頁碼',{exact:true}).fill('99');await root(page).getByRole('button',{name:'前往',exact:true}).click();expect(state.calls.length).toBe(before);
 await root(page).getByLabel('每頁筆數',{exact:true}).selectOption('10');await expect(root(page).locator('tbody tr')).toHaveCount(10);await expect(root(page)).toContainText('第 1 頁');
});
test('details load only on demand, render safe text, cache per page, Escape/close restore focus',async({page})=>{
 const state=await setup(page);const detailsCalls=()=>state.calls.filter(c=>/^\/api\/admin\/audit-logs\//.test(c.path));expect(detailsCalls()).toHaveLength(0);
 const opener=root(page).getByRole('button',{name:'查閱細項',exact:true}).first();await opener.click();const modal=page.getByRole('dialog',{name:'操作紀錄細項',exact:true});await expect(modal).toContainText('FAN_ADMIN_01');await expect(modal).toContainText('draft');await expect(modal).toContainText('<img');await expect(modal).not.toContainText('do-not-render');await expect(modal).not.toContainText('private-image');await expect(modal.locator('img')).toHaveCount(0);expect(detailsCalls()).toHaveLength(1);
 await page.keyboard.press('Escape');await expect(modal).toHaveCount(0);await expect(opener).toBeFocused();await opener.click();await expect(modal).toContainText('draft');expect(detailsCalls()).toHaveLength(1);await modal.getByRole('button',{name:'關閉',exact:true}).click();await expect(opener).toBeFocused();
 await page.clock.install();const n=state.calls.filter(c=>c.path.includes('audit-logs')).length;await page.clock.fastForward(120000);expect(state.calls.filter(c=>c.path.includes('audit-logs')).length).toBe(n);
});
test('audit table/modal fit mobile and both themes; navigation disposes private details',async({page},info)=>{
 await setup(page,3);for(const theme of ['light','dark']){await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'.wrangler/audit-list-'+info.project.name+'-'+theme+'.png'});await root(page).getByRole('button',{name:'查閱細項'}).first().click();const modal=page.getByRole('dialog',{name:'操作紀錄細項'});await expect(modal).toContainText('修改後資料');const box=await modal.boundingBox();expect(box.width).toBeLessThanOrEqual(page.viewportSize().width);await page.screenshot({path:'.wrangler/audit-ui-'+info.project.name+'-'+theme+'.png'});await modal.getByRole('button',{name:'關閉',exact:true}).click();}
 await root(page).getByRole('button',{name:'查閱細項'}).first().click();await page.keyboard.press('Escape');await page.locator('#admin-tabs').getByRole('button',{name:'工作總覽',exact:true}).click();await expect(page.getByRole('dialog',{name:'操作紀錄細項'})).toHaveCount(0);
});
test('audit errors preserve last page; permission/MFA failure clears details and cannot show audits',async({page})=>{
 const state=await setup(page,3);await page.route('**/api/admin/audit-logs?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'ADMIN_SERVICE_UNAVAILABLE'}})}));await root(page).getByRole('button',{name:'重新整理操作紀錄'}).click();await expect(root(page).locator('tbody tr')).toHaveCount(3);await expect(root(page)).toContainText('保留最後成功結果');await root(page).getByLabel('每頁筆數',{exact:true}).selectOption('10');await expect(root(page).getByLabel('每頁筆數',{exact:true})).toHaveValue('20');await expect(root(page).locator('tbody tr')).toHaveCount(3);await page.unroute('**/api/admin/audit-logs?**');state.elevationUntil=0;
 await root(page).getByRole('button',{name:'查閱細項'}).first().click();await expect(page.locator('#admin-content')).toBeHidden();await expect(page.getByRole('dialog',{name:'操作紀錄細項'})).toHaveCount(0);
});
test('leaving during lazy module loading makes no late audit request or hidden private panel',async({page})=>{
 const state=await adminFixture(page);let requested=false,finishLoad;const gate=new Promise(resolve=>{finishLoad=resolve;});
 await page.route('**/js/admin-audit.js',async route=>{requested=true;await gate;await route.continue();});
 await page.goto('/#admin');await page.locator('#admin-tabs').getByRole('button',{name:'操作紀錄',exact:true}).click();await expect.poll(()=>requested).toBe(true);
 await page.getByRole('link',{name:'VoteProof 首頁',exact:true}).click();const response=page.waitForResponse('**/js/admin-audit.js');finishLoad();await response;await page.waitForLoadState('networkidle');
 expect(state.calls.filter(c=>c.path.includes('audit-logs'))).toHaveLength(0);await expect(root(page).locator('.audit-table')).toHaveCount(0);
});
