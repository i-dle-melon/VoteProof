import {test,expect} from './isolated-ui-fixture.mjs';
import {adminFixture} from './admin-fixture.mjs';
import {png} from './member-fixture.mjs';
import {memberFixture} from './member-fixture.mjs';
const preview='http://127.0.0.1:4174/VoteProof/';
const ready=page=>expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
const tab=async(page,name)=>{await page.locator('#admin-tabs').getByRole('button',{name,exact:true}).click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');};
test('Campaign guidance switches, hides empty content, zoom closes and restores focus',async({page})=>{
 await page.goto(preview+'#submit');await ready(page);await page.locator('#campaign').selectOption('PREVIEW-CAMPAIGN');await expect(page.locator('#campaign-guidance')).toBeVisible();await expect(page.locator('#campaign-instructions')).toContainText('展示 FANBASE');await expect(page.locator('#campaign-example')).toHaveJSProperty('complete',true);
 await page.locator('#campaign-example-open').click();await expect(page.locator('#campaign-example-dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#campaign-example-dialog')).toBeHidden();await expect(page.locator('#campaign-example-open')).toBeFocused();
 await page.locator('#campaign').selectOption('PREVIEW-GROUP');await expect(page.locator('#campaign-guidance')).toBeHidden();await page.locator('#campaign').selectOption('PREVIEW-CAMPAIGN');await expect(page.locator('#campaign-instructions')).toContainText('展示 FANBASE');
});
test('Admin Campaign image upload, replace, remove and public instructions use shared form',async({page})=>{
 const state=await adminFixture(page);await page.goto('/#admin');await tab(page,'活動管理');await page.getByRole('button',{name:'編輯活動',exact:true}).click();
 await page.getByLabel('投稿說明（公開顯示）',{exact:true}).fill('合作：Fixture FANBASE\n注意保留日期');await page.getByLabel('投稿範例圖片',{exact:true}).setInputFiles({name:'example.png',mimeType:'image/png',buffer:png});await expect(page.locator('.campaign-example-preview')).toBeVisible();await page.getByRole('button',{name:'保存活動',exact:true}).click();
 await expect.poll(()=>state.content.LOCAL?.example_asset_id).toBeTruthy();expect(state.assets.size).toBe(1);expect(state.content.LOCAL.submission_instructions).toContain('Fixture FANBASE');
 await tab(page,'活動管理');await page.getByRole('button',{name:'編輯活動',exact:true}).click();await expect(page.locator('.campaign-example-preview')).toBeVisible();await page.getByLabel('投稿範例圖片',{exact:true}).setInputFiles({name:'replacement.png',mimeType:'image/png',buffer:png});await page.getByRole('button',{name:'保存活動',exact:true}).click();await expect.poll(()=>state.assets.size).toBe(2);
 await tab(page,'活動管理');await page.getByRole('button',{name:'編輯活動',exact:true}).click();await page.getByRole('button',{name:'移除範例圖片',exact:true}).click();await page.getByRole('button',{name:'保存活動',exact:true}).click();await expect.poll(()=>state.content.LOCAL.example_asset_id).toBe(null);
});
test('announcement Admin placement, editor, plain text preview, version save and reviewer exclusion',async({page})=>{
 const state=await adminFixture(page);await page.goto('/#admin');await expect(page.locator('#admin-tabs button')).toHaveCount(10);const names=await page.locator('#admin-tabs button').allTextContents();expect(names.indexOf('彈窗公告')).toBe(names.indexOf('圖片批次匯出')-1);
 await tab(page,'彈窗公告');await page.getByRole('button',{name:'新增公告',exact:true}).click();await page.getByLabel('公告標題',{exact:true}).fill('Fixture notice');await page.getByLabel('公告內容',{exact:true}).fill('<img src=x onerror=alert(1)>\nPlain line');await page.getByLabel('公告狀態',{exact:true}).selectOption('true');await page.getByRole('button',{name:'預覽公告',exact:true}).click();await expect(page.getByLabel('公告預覽')).toContainText('<img');await expect(page.getByLabel('公告預覽').locator('img')).toHaveCount(0);await page.getByRole('button',{name:'儲存公告',exact:true}).click();await expect.poll(()=>state.announcements.length).toBe(1);expect(state.announcements[0]).toMatchObject({enabled:true,dismissible:true,version:0});
 state.role='reviewer';await page.reload();await expect(page.locator('#admin-tabs button')).toHaveText(['工作總覽','案件審核','圖片批次匯出']);
});
test('server fixtures: disabled, future and expired announcements never open; security flows remain unobstructed',async({page})=>{
 for(const mode of ['off','future','expired']){await page.goto(preview+'?preview_announcement='+mode+'#home');await ready(page);await expect(page.locator('#announcement-dialog')).toBeHidden();}
 await page.goto(preview+'?preview_announcement=on#security');await ready(page);await expect(page.locator('#announcement-dialog')).toBeHidden();
});
test('public dismissal remembers only version; same version stays closed and new version opens',async({page})=>{
 await page.goto(preview+'?preview_announcement=on#home');await ready(page);await expect(page.locator('#announcement-dialog')).toBeVisible();await page.keyboard.press('Tab');await page.keyboard.press('Escape');await expect(page.locator('#announcement-dialog')).toBeHidden();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('voteproof-announcement-dismissals')));expect(Object.values(saved)).toEqual([0]);await page.reload();await ready(page);await expect(page.locator('#announcement-dialog')).toBeHidden();await page.locator('#announcement-open').click();await expect(page.locator('#announcement-dialog')).toBeVisible();await page.locator('#announcement-close').click();await expect(page.locator('#announcement-open')).toBeFocused();
 await page.evaluate(()=>localStorage.setItem('voteproof-announcement-dismissals',JSON.stringify({'00000000-0000-4000-8000-000000000002':-1})));await page.reload();await ready(page);await expect(page.locator('#announcement-dialog')).toBeVisible();
});
test('non-dismissible announcement prevents Escape but allows login and security navigation',async({page})=>{
 await page.goto(preview+'?preview_announcement=locked#home');await ready(page);await expect(page.locator('#announcement-dialog')).toBeVisible();await expect(page.locator('#announcement-close')).toBeHidden();await page.keyboard.press('Escape');await expect(page.locator('#announcement-dialog')).toBeVisible();await page.locator('#announcement-security').click();await expect(page).toHaveURL(/#security$/);await expect(page.locator('#announcement-dialog')).toBeHidden();
});
test('public popup renders HTML as text and a real server version change overrides prior dismissal',async({page})=>{
 await memberFixture(page);const row={announcement_id:'00000000-0000-4000-8000-000000000099',title:'Public notice',body:'<img src=x onerror=alert(1)>\nSecond line',dismissible:true,button_label:'Unsafe',button_url:'javascript:alert(1)',version:1};await page.route('**/api/announcements',r=>r.fulfill({json:{ok:true,data:{announcements:[row]}}}));
 await page.goto('/#home');await expect(page.locator('#announcement-dialog')).toBeVisible();await expect(page.locator('#announcement-body')).toContainText('<img');await expect(page.locator('#announcement-body img')).toHaveCount(0);await expect(page.locator('#announcement-body a')).toHaveCount(0);await page.locator('#announcement-close').click();await page.reload();await expect(page.locator('#announcement-open')).toBeVisible();await expect(page.locator('#announcement-dialog')).toBeHidden();row.version++;await page.reload();await expect(page.locator('#announcement-dialog')).toBeVisible();
});
test('Preview Admin CMS saves in memory and staff identities use the shared protected UI',async({page})=>{
 page.on('dialog',d=>d.accept());await page.goto(preview+'?preview_identity=super_admin#admin');await ready(page);await expect(page.locator('#admin-tabs button').last()).toHaveText('管理員管理');await tab(page,'彈窗公告');await page.getByRole('button',{name:'編輯公告',exact:true}).click();await page.getByLabel('公告標題',{exact:true}).fill('Preview saved notice');await page.getByLabel('公告狀態',{exact:true}).selectOption('true');await page.getByRole('button',{name:'儲存公告',exact:true}).click();await expect(page.locator('#admin-panel')).toContainText('Preview saved notice');
 await page.goto(preview+'?preview_identity=reviewer#admin');await ready(page);await expect(page.locator('#admin-tabs button')).toHaveText(['工作總覽','案件審核','圖片批次匯出']);await tab(page,'案件審核');await page.locator('.album-photo').first().scrollIntoViewIfNeeded();await expect(page.locator('.album-photo img').first()).toBeVisible();
});
test('content and announcements fit 320/390/430/1024/1440 in Dark and Light',async({page})=>{
 for(const width of [320,390,430,1024,1440])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:900});await page.goto(preview+'?preview_announcement=on&preview_theme='+theme+'#home');await ready(page);if(!await page.locator('#announcement-dialog').isVisible())await page.locator('#announcement-open').click();await expect(page.locator('#announcement-dialog')).toBeVisible();const box=await page.locator('#announcement-dialog').boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.width+box.x).toBeLessThanOrEqual(width);await page.locator('#announcement-close').click();
  await page.goto(preview+'?preview_theme='+theme+'#submit');await ready(page);await page.locator('#campaign').selectOption('PREVIEW-CAMPAIGN');await expect(page.locator('#campaign-example-open')).toBeVisible();await page.locator('#campaign-example-open').click();const large=await page.locator('#campaign-example-dialog').boundingBox();expect(large.x).toBeGreaterThanOrEqual(0);expect(large.x+large.width).toBeLessThanOrEqual(width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.keyboard.press('Escape');
 }
});
