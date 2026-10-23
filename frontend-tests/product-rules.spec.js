import {test,expect} from '@playwright/test';
import {adminFixture} from './admin-fixture.mjs';
import {memberFixture} from './member-fixture.mjs';
const base='http://127.0.0.1:4174/VoteProof/';
const scene=(options={},view='home')=>base+'?'+new URLSearchParams(Object.entries(options).map(([k,v])=>['preview_'+k,v]))+'#'+view;
const ready=async page=>expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
test('shared member profile has immutable fan ID and nonblocking duplicate nickname warning',async({page})=>{
 await page.goto(scene({},'member'));await ready(page);
 await expect(page.locator('#member-profile-name')).toHaveText('葉子');
 await expect(page.locator('#profile-fan-readonly')).toHaveText('fan_yeh');
 await expect(page.locator('#profile-player')).toBeHidden();
 await expect(page.locator('#profile-nickname-warning')).toContainText('仍可繼續使用');
 await page.locator('#profile-nickname').fill('葉子改名');await page.locator('#profile-save').click();
 await expect(page.locator('#member-profile-name')).toHaveText('葉子改名');
 await expect(page.locator('#profile-nickname-warning')).toBeVisible();
});
test('anonymous form selects campaign without classification or identity inputs',async({page})=>{
 await page.goto(scene({identity:'guest'},'submit'));await ready(page);
 await expect(page.locator('#nickname')).toBeHidden();await expect(page.locator('#player-id')).toBeHidden();
 await expect(page.locator('#submission-owner-hint')).toContainText('匿名投稿');
 await page.locator('#campaign').selectOption('PREVIEW-CAMPAIGN');
 await page.locator('#campaign').selectOption('PREVIEW-GROUP');
 await expect(page.locator('#vote-type, [name=vote_type], [name=category], [name=solo_target]')).toHaveCount(0);
 await page.goto(scene({identity:'guest',submission:'success'},'submit'));await ready(page);
 await expect(page.locator('#submission-success-message')).toContainText('不需要特別記錄');
 await expect(page.locator('#success-query-info')).not.toHaveAttribute('open','');
 await expect(page.locator('#success-query-key')).toBeHidden();
 await page.goto(scene({submission:'success'},'submit'));await ready(page);
 await expect(page.locator('#submission-success-message')).toContainText('我的案件');await expect(page.locator('#success-owned-cases')).toBeVisible();
});
test('own case dialog closes on Escape and restores focus, including narrow mobile and both themes',async({page})=>{
 for(const width of [320,390,430,1440])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:800});await page.goto(scene({theme},'lookup'));await ready(page);
  const row=page.locator('#owned-cases button').nth(2);await row.click();
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.locator('#owned-case-fields')).toContainText('展示退件原因');
  const bounds=await page.getByRole('dialog').boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeHidden();await expect(row).toBeFocused();
  await row.click();await page.locator('#owned-case-close').click();await expect(row).toBeFocused();
 }
});
test('Preview inline review loads proof automatically, switches one panel and approves/rejects with collapse',async({page})=>{
 const requests=[];page.on('request',r=>requests.push(r.url()));page.on('dialog',d=>d.accept());
 await page.goto(scene({identity:'admin'},'admin'));await ready(page);
 const rows=page.locator('.admin-case-row'),open=i=>rows.nth(i).locator('.case-preview');
 await open(0).click({position:{x:12,y:12}});await expect(rows.nth(0).locator('.inline-review')).toBeVisible();await expect(open(0)).toHaveAttribute('aria-expanded','true');
 await expect(rows.nth(0).locator('.admin-proof-grid img')).toBeVisible();
 await open(1).click({position:{x:12,y:12}});await expect(rows.nth(0).locator('.inline-review')).toHaveCount(0);await expect(open(0)).toHaveAttribute('aria-expanded','false');
 await rows.nth(1).getByRole('button',{name:'收合',exact:true}).click();
 await open(0).click({position:{x:12,y:12}});await page.locator('#admin-field-action').selectOption('approve');await page.locator('[data-preview-review] button[type=submit]').click();
 await expect(rows.nth(0).locator('.inline-review')).toHaveCount(0);await expect(rows.nth(0).locator(':scope > .status')).toHaveText('已通過');
 await open(1).click({position:{x:12,y:12}});await page.locator('#admin-field-action').selectOption('reject');await page.locator('#admin-field-reason').fill('Preview only rejection');await page.locator('[data-preview-review] button[type=submit]').click();
 await expect(rows.nth(1).locator('.inline-review')).toHaveCount(0);await expect(rows.nth(1).locator(':scope > .status')).toHaveText('未通過');
 expect(requests.some(u=>new URL(u).protocol==='http:' && (u.includes('/api/')||new URL(u).hostname!=='127.0.0.1'))).toBe(false);
});
test('Preview review API failure retains expanded panel and retryable form',async({page})=>{
 page.on('dialog',d=>d.accept());await page.goto(scene({identity:'admin',review:'error'},'admin'));await ready(page);
 await page.locator('.admin-case-row').first().locator('.case-preview').click({position:{x:12,y:12}});await page.locator('[data-preview-review] button[type=submit]').click();
 await expect(page.locator('.inline-review')).toBeVisible();await expect(page.locator('.inline-review [role=alert]')).not.toBeEmpty();await expect(page.locator('[data-preview-review] button[type=submit]')).toBeEnabled();
});
test('system ranking cards expose no edit/rebuild and custom buttons stay fifth through seventh',async({page})=>{
 await page.goto(scene({identity:'admin'},'admin'));await ready(page);await page.locator('#admin-tabs').getByRole('button',{name:'排行榜管理',exact:true}).click();
 const fixed=page.locator('#admin-panel article').filter({hasText:'系統固定榜'});await expect(fixed).toHaveCount(3);await expect(fixed.locator('button')).toHaveCount(0);
 await page.goto(scene({},'leaderboards'));await ready(page);await expect(page.locator('#board-categories button')).toHaveCount(7);
 await page.locator('#board-categories button').nth(3).click();await expect(page.locator('#solo-target-wrap,#solo-target-filter')).toHaveCount(0);await expect(page.locator('#board-rule-status')).toContainText('歷史積分');
});
test('actual frontend uses protected Admin proof path automatically; API failure keeps review inline',async({page})=>{
 const fixture=await adminFixture(page);await page.goto('/admin#admin');
 await page.locator('.case-preview').click({position:{x:12,y:12}});await expect(page.locator('.inline-review img')).toBeVisible();
 expect(fixture.calls.some(c=>c.path.includes('/files/'))).toBe(true);
 // Fail only the review POST, not /api/admin/me or other identity/authorization reads.
 let failedPosts=0;
 await page.route('**/api/admin/cases/*/review',route=>{
  if(route.request().method()!=='POST')return route.fallback();
  failedPosts++;
  return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'ADMIN_SERVICE_UNAVAILABLE',message:'Review temporarily unavailable'}})});
 });
 const failedResponse=page.waitForResponse(r=>r.request().method()==='POST'&&/\/api\/admin\/cases\/[^/]+\/review$/.test(new URL(r.url()).pathname)&&r.status()===503);
 await page.locator('[data-preview-review] button[type=submit]').click();
 await failedResponse;
 expect(failedPosts).toBe(1);
 await expect(page.locator('.inline-review')).toBeVisible();
 await expect(page.locator('[data-preview-review] button[type=submit]')).toBeEnabled();
 expect(fixture.cases[0].status).toBe('pending');
});
test('actual member case modal uses owner-only endpoint with no query key',async({page})=>{
 const fixture=await memberFixture(page,{authenticated:true});await page.goto('/#member');await page.locator('#member-cases button').first().click();
 await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#member-cases button').first()).toBeFocused();
 const read=fixture.calls.find(c=>c.path.startsWith('/api/me/cases/'));expect(read).toBeTruthy();expect(read.headers['x-case-query-key']).toBeUndefined();
});
test('inline review row click fits mobile themes and collapse revokes proof object URL',async({page})=>{
 await page.addInitScript(()=>{const revoke=URL.revokeObjectURL;globalThis.__revokedProofs=0;URL.revokeObjectURL=url=>{globalThis.__revokedProofs++;revoke.call(URL,url);};});
 for(const width of [320,390,430])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:800});await page.goto(scene({identity:'admin',theme},'admin'));await ready(page);
  await page.locator('.admin-case-row .case-preview').first().click({position:{x:12,y:12}});
  await expect(page.locator('.inline-review img')).toHaveJSProperty('naturalWidth',640);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.inline-review').getByRole('button',{name:'收合',exact:true}).click();
  await expect(page.locator('.inline-review')).toHaveCount(0);expect(await page.evaluate(()=>globalThis.__revokedProofs)).toBe(1);
 }
});
