import {test,expect} from '@playwright/test';
import {memberFixture} from './member-fixture.mjs';
const submit=page=>page.locator('#google-mfa-submit').click();
async function pending(page,state){
 await page.goto('/#google');await page.locator('#google-confirm-form button[type=submit]').click();
 await expect(page.locator('#google-mfa-form')).toBeVisible();expect(state.authenticated).toBe(false);
}
test('Google MFA enabled login remains unauthenticated until TOTP; a wrong code preserves challenge and recovery is secondary',async({page})=>{
 const state=await memberFixture(page,{googleOnly:true,googleResult:'GOOGLE_LOGIN_READY',googleMfaEnabled:true});await pending(page,state);
 await expect(page.locator('#google-mfa-code')).toBeVisible();await expect(page.locator('#google-mfa-recovery')).toBeHidden();
 state.invalidTotp=1;await page.locator('#google-mfa-code').fill('123456');await submit(page);await expect(page.locator('#google-error')).toContainText('驗證');expect(state.authenticated).toBe(false);
 await page.locator('#google-mfa-code').fill('654321');await submit(page);await expect(page).toHaveURL(/#member$/);expect(state.authenticated).toBe(true);
 const call=state.calls.find(c=>c.path==='/api/auth/google/mfa/verify');expect(call.body.trust_this_device).toBeUndefined();
});
test('Google login accepts one recovery method and clears it after success without exposing it in URL or storage',async({page})=>{
 const state=await memberFixture(page,{googleOnly:true,googleResult:'GOOGLE_LOGIN_READY',googleMfaEnabled:true});await pending(page,state);
 await page.locator('#google-mfa-other-methods summary').click();await page.locator('#google-mfa-switch').click();
 await expect(page.locator('#google-mfa-code')).toBeHidden();await page.locator('#google-mfa-recovery').fill(state.recoveryCodes[0]);await submit(page);
 await expect(page).toHaveURL(/#member$/);const call=state.calls.find(c=>c.path==='/api/auth/google/mfa/recovery');expect(call.body.code).toBeUndefined();
 expect(await page.evaluate(()=>JSON.stringify([location.href,{...localStorage},{...sessionStorage}]))).not.toContain(state.recoveryCodes[0]);await expect(page.locator('#google-mfa-recovery')).toHaveValue('');
});
test('Google-only opt-in uses fresh OAuth, enrolls separately, saves recovery codes and only then enables MFA',async({page})=>{
 const state=await memberFixture(page,{authenticated:true,googleOnly:true,googleMfaAvailable:true});await page.goto('/#security');
 await page.locator('#security-google-mfa-enable').click();await expect(page.locator('#google-mfa-setup')).toBeVisible();
 expect(state.calls.find(c=>c.path==='/api/auth/google/start').body).toEqual({purpose:'security',confirmed:true,mfa_policy_action:'enable'});
 await page.locator('#google-mfa-setup').click();await expect(page.locator('#google-mfa-key')).not.toHaveText('');
 await page.locator('#google-mfa-code').fill('123456');await submit(page);await expect(page.locator('#google-mfa-codes')).toContainText(state.recoveryCodes[0]);
 expect(state.googleMfaEnabled).toBe(false);await expect(page.locator('#google-mfa-key')).toHaveText('');
 await page.locator('#google-mfa-code').fill('654321');await submit(page);expect(state.calls.some(c=>c.path.endsWith('/mfa/enable'))).toBe(false);
 await page.locator('#google-mfa-ack').check();await page.locator('#google-mfa-code').fill('654321');await submit(page);
 await expect(page).toHaveURL(/#security$/);await expect(page.locator('#security-google-mfa-state')).toContainText('已啟用');await expect(page.locator('#google-mfa-codes')).toHaveText('');
});
test('configured dual member does not enroll again and can disable with fresh Google plus recovery',async({page})=>{
 const state=await memberFixture(page,{authenticated:true,dual:true,googleMfaEnabled:true,googleMfaAvailable:true});await page.goto('/#security');
 await page.locator('#security-google-mfa-disable').click();await expect(page.locator('#google-mfa-form')).toBeVisible();
 await page.locator('#google-mfa-other-methods summary').click();await page.locator('#google-mfa-switch').click();await page.locator('#google-mfa-recovery').fill(state.recoveryCodes[0]);await submit(page);
 await expect(page).toHaveURL(/#security$/);await expect(page.locator('#security-google-mfa-state')).toContainText('未啟用');expect(state.passwordConfigured).toBe(true);expect(state.authenticatorConfigured).toBe(true);
 const call=state.calls.find(c=>c.path.endsWith('/mfa/disable'));expect(call.body.code).toBeUndefined();expect(state.calls.some(c=>c.path.includes('/mfa/enroll'))).toBe(false);
});

test('recovery can explicitly stop Google MFA after a separate confirmation',async({page})=>{
 const state=await memberFixture(page,{googleOnly:true,googleResult:'GOOGLE_LOGIN_READY',googleMfaEnabled:true});await pending(page,state);
 await page.locator('#google-mfa-other-methods summary').click();await page.locator('#google-mfa-switch').click();
 await page.locator('#google-mfa-recovery').fill(state.recoveryCodes[0]);await page.locator('#google-mfa-recover-policy').check();page.once('dialog',d=>d.accept());await submit(page);
 await expect(page).toHaveURL(/#member$/);expect(state.googleMfaEnabled).toBe(false);
 expect(state.calls.find(c=>c.path.endsWith('/mfa/recovery')).body).toMatchObject({disable_mfa:true,confirmed:true});
});
test('closed opt-in rollout hides enable but does not hide disabling an existing policy',async({page})=>{
 const state=await memberFixture(page,{authenticated:true,googleOnly:true});await page.goto('/#security');await expect(page.locator('#security-google-mfa-state')).toContainText('尚未開放');await expect(page.locator('#security-google-mfa-enable')).toBeHidden();
 state.googleMfaEnabled=true;await page.locator('#security-refresh').click();await expect(page.locator('#security-google-mfa-disable')).toBeVisible();
});
test('pending Google MFA cancel and expiry do not log in',async({page})=>{
 await page.clock.install();await page.clock.pauseAt(Date.now());const state=await memberFixture(page,{googleOnly:true,googleResult:'GOOGLE_LOGIN_READY',googleMfaEnabled:true,expired:true});await pending(page,state);
 await page.clock.fastForward(1000);await page.locator('#google-mfa-code').fill('123456');await submit(page);await expect(page.locator('#google-error')).toContainText('驗證');expect(state.authenticated).toBe(false);
 await page.locator('#google-mfa-cancel').click();await expect(page).toHaveURL(/#login$/);expect(state.authenticated).toBe(false);
});
test('Google MFA UI fits mobile dark/light and clears setup secrets when leaving',async({page})=>{
 await memberFixture(page,{authenticated:true,googleOnly:true,googleMfaAvailable:true,googlePurpose:'security',googlePolicyAction:'enable'});
 await page.goto('/#google');await page.locator('#google-mfa-setup').click();await expect(page.locator('#google-mfa-key')).not.toHaveText('');
 for(const width of [320,390,430,1024,1440])for(const theme of ['dark','light']){await page.setViewportSize({width,height:900});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await page.goto('/#security');await expect(page.locator('#google-mfa-key')).toHaveText('');
});
