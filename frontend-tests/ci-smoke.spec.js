import { test, expect } from '@playwright/test';
import { memberFixture } from './member-fixture.mjs';
import { adminFixture } from './admin-fixture.mjs';

test('Preview upload contract boots every shared summary without module errors or writes',async({page})=>{
 const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
 const origin='http://127.0.0.1:4174';
 for(const scene of['zero','uploading','failed','success']){
  await page.goto(origin+'/VoteProof/?preview_identity=admin&preview_submission='+scene+'#submit');
  expect(errors).toEqual([]);
  await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
  if(scene!=='zero'){
   const counts=page.locator('#batch-counts');await expect(counts).not.toContainText(/undefined|NaN/);
   await expect(counts).toContainText('處理完成：'+(scene==='success'?3:scene==='failed'?2:1)+' / 3');
   await expect(counts).toContainText('尚未開始：'+(scene==='success'?0:1));
   const progress=await page.locator('#progress').evaluate(p=>p.value);expect(Number.isFinite(progress)).toBe(true);
   expect(progress).toBe(scene==='success'?100:scene==='uploading'?47:33);
  }
 }
 expect(errors).toEqual([]);
 expect(requests.filter(r=>new URL(r.url).origin!==origin||new URL(r.url).pathname.includes('/api/')||!['GET','HEAD'].includes(r.method))).toEqual([]);
 expect(await page.evaluate(()=>document.cookie)).toBe('');
});

test('Guest navigation and recovery controls boot without Preview auth', async ({ page }) => {
  await memberFixture(page);
  for(const view of ['home','submit','lookup','leaderboards','login','register','recover']) {
    await page.goto('/#'+view); await expect(page.locator('#view-'+view)).toBeVisible();
  }
  await expect(page.locator('#preview-controls')).toHaveCount(0);
  await expect(page.locator('#admin-nav-group')).toHaveAttribute('hidden','');
  await expect(page.locator('#recover-totp')).toBeVisible();
  await page.locator('#recover-other-methods > summary').click();
  await page.locator('#recover-switch-method').click();
  await expect(page.locator('#recover-code')).toBeVisible();
});
test('Member and Admin shared renderers retain role entry points', async ({ page }) => {
  await adminFixture(page);
  for(const view of ['member','security','admin']) {
    await page.goto('/#'+view); await expect(page.locator('#view-'+view)).toBeVisible();
  }
  await expect(page.locator('#admin-panel')).toBeVisible();
  await expect(page.locator('#admin-nav-group')).not.toHaveAttribute('hidden');
});
test('Pages shared UI, mobile themes and fixture transport stay public-safe', async ({ page }) => {
  const requests=[],errors=[];
  page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
  page.on('pageerror',e=>errors.push(e.message));
  const origin='http://127.0.0.1:4174';
  await page.goto(origin+'/VoteProof/?preview_identity=admin#home');
  await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
  for(const width of [320,390,430,1024,1440])for(const theme of ['dark','light']) {
    await page.setViewportSize({width,height:900});
    if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('#theme-toggle').click();
    for(const view of ['home','lookup','leaderboards','achievements','member','admin']) {
      await page.evaluate(v=>{location.hash=v;},view); await expect(page.locator('#view-'+view)).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }
  expect(errors).toEqual([]);
  expect(requests.filter(r=>new URL(r.url).origin!==origin||new URL(r.url).pathname.includes('/api/')||!['GET','HEAD'].includes(r.method))).toEqual([]);
});

test('Pages campaign collection shows synthetic stamps and updates the selected result', async ({ page }) => {
  await page.goto('http://127.0.0.1:4174/VoteProof/?preview_theme=light#leaderboards');
  await page.getByRole('link', { name: '查看我的活動成果集章' }).click();
  const panel = page.locator('#view-achievements');
  await expect(panel.getByRole('heading', { name: '活動成果集章', exact: true })).toBeVisible();
  await expect(panel.locator('.achievement-collection-head')).toContainText('已收集 6 / 10');
  await expect(panel.locator('.achievement-rank dd')).toHaveText('#2');
  await expect(panel.locator('.achievement-metrics')).toContainText('8,100');
  await panel.getByRole('button', { name: /音放應援/ }).click();
  await expect(panel.locator('.achievement-banner h2')).toHaveText('音放應援');
  await expect(panel.locator('.achievement-rank dd')).toHaveText('#6');
  await panel.getByRole('button', { name: /冬日舞台投票/ }).click();
  await expect(panel.locator('.achievement-rank dd')).toHaveText('—');
  await page.goto('http://127.0.0.1:4174/VoteProof/?preview_identity=guest#achievements');
  await expect(panel.getByRole('link', { name: '登入會員' })).toBeVisible();
  await expect(panel.locator('.achievement-stamp')).toHaveCount(0);
});

test('Pages member center switches between points and campaign stamps in the same card', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 820 });
  const preview = 'http://127.0.0.1:4174/VoteProof/';
  await page.goto(preview + '?preview_identity=member#member');
  const tabs = page.getByRole('tablist', { name: '會員成果' });
  const points = tabs.getByRole('tab', { name: '點數與目前等級' });
  const stamps = tabs.getByRole('tab', { name: '活動成果集章' });
  const pointsPanel = page.locator('#member-points-panel');
  const stampPanel = page.locator('#member-achievements-panel');

  await expect(points).toHaveAttribute('aria-selected', 'true');
  await expect(pointsPanel.locator('#member-points')).toHaveText('420');
  await expect(stampPanel).toBeHidden();
  expect((await stamps.boundingBox()).x).toBeGreaterThan((await points.boundingBox()).x);

  await stamps.click();
  await expect(page).toHaveURL(/#member$/);
  await expect(stamps).toHaveAttribute('aria-selected', 'true');
  await expect(pointsPanel).toBeHidden();
  await expect(stampPanel.locator('.achievement-stamp')).toHaveCount(10);
  await expect(stampPanel.locator('.achievement-rank dd')).toHaveText('#2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await stamps.press('ArrowLeft');
  await expect(points).toBeFocused();
  await expect(stampPanel).toBeHidden();
  await expect(pointsPanel.locator('#member-points')).toHaveText('420');

  await page.goto(preview + '?preview_identity=guest#member');
  await expect(tabs).toBeHidden();
  await expect(page.locator('#member-gate')).toBeVisible();
});
