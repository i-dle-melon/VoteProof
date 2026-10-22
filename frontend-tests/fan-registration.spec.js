import {test,expect} from '@playwright/test';
import {memberFixture} from './member-fixture.mjs';
const submit=(page,id)=>page.locator('#'+id+' button[type=submit]').click();
async function passwordStep(page,state){
  await page.goto('/#register');await expect(page.locator('#register-challenge-status')).toHaveText('已完成人機驗證');
  await page.locator('#register-email').fill('local@example.com');await submit(page,'register-email-form');
  await page.locator('#register-code').fill('001234');await submit(page,'register-code-form');
  await expect(page.locator('#register-password-form')).toBeVisible();
  await page.locator('#register-password').fill(state.password);await page.locator('#register-confirm').fill(state.password);
}
const hint='粉絲 ID 將用於會員識別、積分及排行榜。請確認填寫正確，設定後不可自行修改。';
test('Fan ID password signup blocks empty/whitespace and shows duplicate error, then accepts valid ID',async({page})=>{
  const state=await memberFixture(page);await passwordStep(page,state);
  await expect(page.locator('label[for=register-fan]')).toHaveText('粉絲 ID（必填）');
  await expect(page.locator('#register-fan')).toHaveAttribute('required','');await expect(page.locator('#register-fan-help')).toHaveText(hint);
  for(const value of ['',' 　']){
    await page.locator('#register-fan').fill(value);await submit(page,'register-password-form');
    await expect(page.locator('#register-error')).toHaveText('請填寫粉絲 ID，才能完成註冊。');
    expect(state.calls.filter(c=>c.path.endsWith('/credentials'))).toHaveLength(0);
  }
  state.fanIdTaken=true;await page.locator('#register-fan').fill('existing');await submit(page,'register-password-form');
  await expect(page.locator('#register-error')).toHaveText('此粉絲 ID 已被使用，請確認後重新輸入。');
  state.fanIdTaken=false;await page.locator('#register-fan').fill(' fan_yeh ');
  await page.locator('#register-password').fill(state.password);await page.locator('#register-confirm').fill(state.password);
  await submit(page,'register-password-form');await expect(page.locator('#register-totp-form')).toBeVisible();
  expect(state.calls.filter(c=>c.path.endsWith('/credentials')).at(-1).body.player_id).toBe('fan_yeh');
});
test('Fan ID Google first signup is required and retry preserves the same profile flow',async({page})=>{
  const state=await memberFixture(page);await page.goto('/#google');await expect(page.locator('#google-profile')).toBeVisible();
  await page.locator('#google-nickname').fill('葉子');
  await expect(page.locator('label[for=google-player]')).toHaveText('粉絲 ID（必填）');await expect(page.locator('#google-fan-help')).toHaveText(hint);
  for(const value of ['',' 　']){
    await page.locator('#google-player').fill(value);await submit(page,'google-confirm-form');
    await expect(page.locator('#google-error')).toHaveText('請填寫粉絲 ID，才能完成註冊。');
    expect(state.calls.filter(c=>c.path.endsWith('/google/confirm'))).toHaveLength(0);
  }
  state.fanIdTaken=true;await page.locator('#google-player').fill('existing');await submit(page,'google-confirm-form');
  await expect(page.locator('#google-error')).toHaveText('此粉絲 ID 已被使用，請確認後重新輸入。');
  state.fanIdTaken=false;await page.locator('#google-player').fill(' fan_yeh ');await submit(page,'google-confirm-form');
  await expect(page.locator('#member-content')).toBeVisible();
  expect(state.calls.filter(c=>c.path.endsWith('/google/confirm')).at(-1).body.player_id).toBe('fan_yeh');
});
test('Fan ID does not block existing Google login without new profile input',async({page})=>{
  const state=await memberFixture(page,{googleResult:'GOOGLE_LOGIN_READY'});await page.goto('/#google');
  await expect(page.locator('#google-profile')).toBeHidden();await expect(page.locator('#google-player')).not.toHaveAttribute('required');
  await submit(page,'google-confirm-form');await expect(page.locator('#member-content')).toBeVisible();
  expect(state.calls.find(c=>c.path.endsWith('/google/confirm')).body.player_id).toBeUndefined();
});
