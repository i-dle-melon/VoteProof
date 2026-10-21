import {test,expect} from '@playwright/test';
import {memberFixture} from './member-fixture.mjs';
import {randomUUID} from 'node:crypto';
const description='此功能僅適用於「密碼」登入，信任期限為 30 天。(Google免設定)';
for(const mfa of [false,true])test(`Google-only hides all password device UI, including MFA ${mfa?'ON':'OFF'}, without requesting devices`,async({page})=>{
 const state=await memberFixture(page,{authenticated:true,googleOnly:true,googleMfaEnabled:mfa});await page.goto('/#security');
 await expect(page.locator('#security-google')).toContainText('已連結');await expect(page.locator('#security-password-devices')).toBeHidden();
 await page.goto('/#member');await expect(page.locator('#member-auth-method')).toHaveText('Google');await expect(page.locator('#member-password-devices')).toBeHidden();
 expect(state.calls.filter(c=>c.path==='/api/auth/trusted-devices')).toHaveLength(0);
});
for(const dual of [false,true])test(`${dual?'dual':'password-only'} member sees exact password trust copy and empty state`,async({page})=>{
 const state=await memberFixture(page,{authenticated:true,dual});await page.goto('/#security');const section=page.locator('#security-password-devices');
 await expect(section).toBeVisible();await expect(section.getByRole('heading',{name:'密碼登入信任裝置',exact:true})).toBeVisible();
 await expect(section).toContainText(description);await expect(page.locator('#security-devices-status')).toHaveText('目前沒有已信任的裝置。');
 await page.goto('/#member');await expect(page.locator('#member-password-devices')).toBeVisible();await expect(page.locator('#member-trusted-state')).toHaveText('目前沒有已信任的裝置。');
 expect(state.calls.filter(c=>c.path==='/api/auth/trusted-devices')).toHaveLength(2);
});
test('existing device timestamps and revoke API are preserved',async({page})=>{
 const state=await memberFixture(page,{authenticated:true,dual:true}),id=randomUUID();state.devices=[{id,label:'測試手機',created_at:1780000000,last_used_at:1780001000,expires_at:4102444800}];
 await page.goto('/#security');const section=page.locator('#security-password-devices');await expect(section).toContainText('測試手機');
 for(const text of ['建立時間','最後使用時間','到期時間'])await expect(section).toContainText(text);
 page.once('dialog',dialog=>dialog.accept());await section.getByRole('button',{name:'撤銷裝置信任',exact:true}).click();await expect(page.locator('#security-devices-status')).toHaveText('目前沒有已信任的裝置。');
 const call=state.calls.find(c=>c.path===`/api/auth/trusted-devices/${id}/revoke`);expect(call.body).toEqual({});expect(call.headers['x-csrf-token']).toBe(state.csrf);
});
test('password device section fits mobile and desktop themes without polling',async({page})=>{
 const state=await memberFixture(page,{authenticated:true,dual:true});state.devices=[{id:randomUUID(),label:'測試手機',created_at:1780000000,last_used_at:1780001000,expires_at:4102444800}];
 await page.goto('/#security');await expect(page.locator('#security-devices')).toContainText('測試手機');const count=state.calls.filter(c=>c.path==='/api/auth/trusted-devices').length;
 for(const width of [320,390,430,1024,1440])for(const theme of ['dark','light']){await page.setViewportSize({width,height:900});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 expect(state.calls.filter(c=>c.path==='/api/auth/trusted-devices')).toHaveLength(count);
});
