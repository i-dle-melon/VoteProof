import {test,expect} from './isolated-ui-fixture.mjs';
import {adminFixture} from './admin-fixture.mjs';
import {png} from './member-fixture.mjs';
const preview='http://127.0.0.1:4174/VoteProof/';
const ready=p=>expect(p.locator('html')).toHaveAttribute('data-preview-ready','true');
const tab=async(p,name)=>{await p.locator('#admin-tabs').getByRole('button',{name,exact:true}).click();await expect(p.locator('#admin-panel')).toHaveAttribute('aria-busy','false');};

test('ordinary close reappears on entry; only explicit opt-out persists and can be undone',async({page})=>{
 await page.goto(preview+'?preview_announcement=on#home');await ready(page);await expect(page.locator('#announcement-dialog')).toBeVisible();await expect(page.locator('#announcement-security')).toHaveCount(0);
 await page.locator('#announcement-close').click();await page.reload();await ready(page);await expect(page.locator('#announcement-dialog')).toBeVisible();
 await page.locator('#announcement-never').check();await page.locator('#announcement-close').click();await page.reload();await ready(page);await expect(page.locator('#announcement-dialog')).toBeHidden();
 await page.locator('#announcement-open').click();await page.locator('#announcement-never').uncheck();await page.locator('#announcement-close').click();await page.reload();await ready(page);await expect(page.locator('#announcement-dialog')).toBeVisible();
});

test('CMS hides button without losing configured URL; public renderer obeys false',async({page})=>{
 const state=await adminFixture(page);state.announcements=[{announcement_id:'00000000-0000-4000-8000-000000000020',title:'Link toggle',body:'Body',enabled:true,dismissible:true,button_enabled:true,button_label:'Read guide',button_url:'https://example.com/guide',version:0}];
 await page.goto('/#admin');await tab(page,'彈窗公告');await page.getByRole('button',{name:'編輯公告',exact:true}).click();await page.getByLabel('顯示連結按鈕',{exact:true}).selectOption('false');await expect(page.getByLabel('按鈕文字（選填）',{exact:true})).toBeDisabled();await page.getByRole('button',{name:'儲存公告',exact:true}).click();
 await expect.poll(()=>state.announcements[0].button_enabled).toBe(false);expect(state.announcements[0].button_url).toBe('https://example.com/guide');
 await page.route('**/api/announcements',r=>r.fulfill({json:{ok:true,data:{announcements:state.announcements}}}));await page.goto('/#home');await page.reload();await expect(page.locator('#announcement-dialog')).toBeVisible();await expect(page.locator('#announcement-body a')).toHaveCount(0);
});

test('overview member count uses separate authoritative aggregate for admin and reviewer',async({page})=>{
 await adminFixture(page,{role:'reviewer'});await page.goto('/#admin');await tab(page,'工作總覽');await expect(page.locator('[data-member-total] strong')).toHaveText('1284');await expect(page.locator('#admin-tabs button')).toHaveText(['工作總覽','案件審核','圖片批次匯出']);
});

test('case thumbnails load only on Cases viewport, two at a time; preview reuses and revokes private blobs',async({page},testInfo)=>{
 const state=await adminFixture(page);state.cases=Array.from({length:20},(_,i)=>({...state.cases[0],case_id:'VP-20261017-'+'ABCDEFGHJKLMNPQRSTUVWXYZ'[i].repeat(14)+'AB',nickname:'Fixture '+i,files:state.cases[0].files}));
 let requests=0,active=0,max=0;await page.route('**/api/admin/cases/*/files/*',async route=>{requests++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,60));await route.fulfill({contentType:'image/png',body:png});active--;});
 await page.addInitScript(()=>{window.revokedProofs=[];const original=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=u=>{window.revokedProofs.push(u);original(u);};});
 await page.goto('/#member');expect(requests).toBe(0);await page.goto('/#admin');await expect(page.locator('#admin-content')).toBeVisible();await page.getByRole('button',{name:'全部案件',exact:true}).click();
 const first=page.locator('.admin-case-row .case-preview').first();await first.scrollIntoViewIfNeeded();await expect(first.locator('img')).toBeVisible();expect(max).toBeLessThanOrEqual(2);expect(requests).toBeLessThan(20);
 const src=await first.locator('img').getAttribute('src'),before=requests;
 if(testInfo.project.name==='desktop-chrome')await first.hover();else{await first.dispatchEvent('pointerdown',{pointerType:'touch',clientX:20,clientY:20});}
 const zoom=page.getByRole('dialog',{name:'證明圖片放大預覽'});await expect(zoom).toBeVisible();await expect(zoom.locator('img')).toHaveAttribute('src',src);
 if(testInfo.project.name!=='desktop-chrome'){await first.dispatchEvent('pointerup',{pointerType:'touch'});await first.dispatchEvent('click');await expect(page.locator('.inline-review')).toHaveCount(0);await zoom.getByRole('button',{name:'關閉圖片預覽',exact:true}).click();await expect(first).toBeFocused();}else await page.mouse.move(0,0);
 await expect(zoom).toBeHidden();expect(requests).toBe(before);await tab(page,'工作總覽');await expect(page.getByRole('dialog',{name:'證明圖片放大預覽'})).toHaveCount(0);expect(await page.evaluate(()=>window.revokedProofs.length)).toBeGreaterThan(0);
});

test('privacy opens native modal without leaving page, traps focus, closes and restores opener',async({page})=>{
 await page.goto(preview+'#home');await ready(page);const link=page.locator('.footer-note a[href="#about"]');await link.click();const dialog=page.locator('#about-dialog');await expect(dialog).toBeVisible();await expect(dialog).toContainText('圖片與查詢資訊');await expect(page).toHaveURL(/#home$/);await expect(page.locator('#view-home')).toBeVisible();await page.locator('#about-close').focus();await page.keyboard.press('Shift+Tab');await expect(dialog.locator('button').last()).toBeFocused();await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(link).toBeFocused();
 await page.goto(preview+'#about');await ready(page);await expect(dialog).toBeVisible();await page.locator('#about-close').click();await expect(page).toHaveURL(/#home$/);
});

test('new footer and both native modals fit mobile and desktop in both themes',async({page})=>{
 for(const width of [320,390,430,1024,1440])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:900});await page.goto(preview+'?preview_announcement=on&preview_theme='+theme+'#home');await ready(page);await expect(page.locator('#announcement-dialog')).toBeVisible();await page.locator('#announcement-close').click();await page.locator('.footer-note a[href="#about"]').click();const box=await page.locator('#about-dialog').boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.width+box.x).toBeLessThanOrEqual(width);expect(box.height).toBeLessThanOrEqual(900);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.keyboard.press('Escape');
 }
 await expect(page.locator('.footer-owner')).toHaveAttribute('href','https://i-dle-melon.github.io/vote/');await expect(page.locator('.footer-note')).toContainText('Designed & Maintained by');
});
