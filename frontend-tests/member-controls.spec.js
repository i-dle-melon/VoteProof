import {test,expect} from './isolated-ui-fixture.mjs';
const preview='http://127.0.0.1:4174/VoteProof/';
const ready=p=>expect(p.locator('html')).toHaveAttribute('data-preview-ready','true');
const tab=async(p,name)=>{await p.locator('#admin-tabs').getByRole('button',{name,exact:true}).click();await expect(p.locator('#admin-panel')).toHaveAttribute('aria-busy','false');};
test('point ledger starts collapsed and modal pages ten rows forward and backward, fits both themes',async({page})=>{
 await page.goto(preview+'?preview_identity=member#member');
 await ready(page);
 const details=page.locator('#point-record-details');
 const opener=page.getByRole('button',{name:'查看點數異動清單'});
 await expect(details).not.toHaveAttribute('open');
 await expect(opener).toBeHidden();
 await details.locator('summary').click();
 await opener.click();
 const dialog=page.getByRole('dialog',{name:'點數異動明細'});
 await expect(dialog.locator('.point-record-row')).toHaveCount(10);
 const first=await dialog.locator('.point-record-row').first().textContent();
 await dialog.getByRole('button',{name:'下一頁'}).click();
 await expect(dialog).toContainText('第 2／3 頁');
 await expect(dialog.locator('.point-record-row')).toHaveCount(10);
 await dialog.getByRole('button',{name:'下一頁'}).click();
 await expect(dialog.locator('.point-record-row')).toHaveCount(3);
 await expect(dialog.getByRole('button',{name:'下一頁'})).toBeDisabled();
 await dialog.getByRole('button',{name:'上一頁'}).click();
 await dialog.getByRole('button',{name:'上一頁'}).click();
 await expect(dialog.locator('.point-record-row').first()).toHaveText(first);
 await dialog.getByRole('button',{name:'關閉'}).click();
 await expect(opener).toBeFocused();
 for(const width of [320,390,430,1024,1440])for(const theme of ['dark','light']){
   await page.setViewportSize({width,height:900});
   await page.goto(preview+'?preview_identity=member&preview_theme='+theme+'#member');
   await ready(page);
   await page.locator('#point-record-details summary').click();
   await page.getByRole('button',{name:'查看點數異動清單'}).click();
   const modal=page.getByRole('dialog',{name:'點數異動明細'});
   await expect(modal.locator('.point-record-row')).toHaveCount(10);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   expect(await modal.evaluate(d=>{const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
   await modal.getByRole('button',{name:'關閉'}).click();
 }
});
test('manager blocks only after red confirmation, list restores member; reviewer has no entry',async({page})=>{
 await page.goto(preview+'?preview_identity=admin#admin');await ready(page);await tab(page,'會員封鎖');const labels=await page.locator('#admin-tabs button').allTextContents();expect(labels.indexOf('會員封鎖')).toBe(labels.indexOf('會員等級')+1);
 await page.locator('#admin-panel').getByLabel('粉絲 ID',{exact:true}).fill('preview_other_fan');await page.getByLabel('封鎖原因',{exact:true}).fill('展示封鎖測試原因');await page.getByRole('button',{name:'封鎖會員',exact:true}).click();const d=page.getByRole('dialog',{name:'確認封鎖會員',exact:true});await expect(d).toBeVisible();await expect(d).toContainText('preview_other_fan');await expect(page.locator('.blocked-member-row')).toHaveCount(1);
 await expect(d.getByRole('button',{name:'確認封鎖',exact:true})).toHaveCSS('background-color','rgb(255, 38, 61)');await d.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('.blocked-member-row')).toHaveCount(1);
 await page.getByRole('button',{name:'封鎖會員',exact:true}).click();await d.getByRole('button',{name:'確認封鎖',exact:true}).click();await expect(d).toHaveCount(0);const row=page.locator('.blocked-member-row').filter({hasText:'preview_other_fan'});await expect(row).toContainText('已被封鎖');await expect(row).toContainText('展示封鎖測試原因');await row.getByRole('button',{name:'恢復會員',exact:true}).click();const restore=page.getByRole('dialog',{name:'確認恢復會員'});await restore.getByRole('button',{name:'確認恢復',exact:true}).click();await expect(row).toHaveCount(0);
 await tab(page,'排行榜管理');const rebuild=page.getByRole('button',{name:'重建成績',exact:true}).first();await expect(rebuild).toHaveClass(/status rejected/);
 await page.goto(preview+'?preview_identity=reviewer#admin');await ready(page);await expect(page.locator('#admin-tabs').getByRole('button',{name:'會員封鎖',exact:true})).toHaveCount(0);
});
test('blocked member sees locked screen, cannot operate main controls, may sign out',async({page})=>{
 await page.goto(preview+'?preview_identity=blocked#member');await ready(page);await expect(page.locator('#member-blocked')).toBeVisible();await expect(page.locator('.app-shell')).toHaveAttribute('inert','');await expect(page.locator('.bottom-nav')).toHaveAttribute('inert','');await page.locator('#member-blocked-logout').click();await expect(page.locator('#member-blocked')).toBeHidden();await expect(page.locator('.app-shell')).not.toHaveAttribute('inert');
});
test('failed block stays open for retry without changing the list; confirm fits phone viewport',async({page})=>{
 await page.setViewportSize({width:320,height:740});await page.goto(preview+'?preview_identity=admin&preview_data=error#admin');await ready(page);await tab(page,'會員封鎖');await page.locator('#admin-panel').getByLabel('粉絲 ID',{exact:true}).fill('preview_other_fan');await page.getByLabel('封鎖原因',{exact:true}).fill('測試 API 失敗');await page.getByRole('button',{name:'封鎖會員',exact:true}).click();const d=page.getByRole('dialog',{name:'確認封鎖會員',exact:true});await expect(d.getByRole('button',{name:'取消',exact:true})).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(d.getByRole('button',{name:'確認封鎖',exact:true})).toBeFocused();await d.getByRole('button',{name:'確認封鎖',exact:true}).click();await expect(d.getByRole('status')).not.toBeEmpty();await expect(d).toBeVisible();await expect(d.getByRole('button',{name:'確認封鎖',exact:true})).toBeEnabled();expect((await d.boundingBox()).width).toBeLessThanOrEqual(320);await page.keyboard.press('Escape');await expect(d).toHaveCount(0);await expect(page.locator('.blocked-member-row')).toHaveCount(1);
});
test('privacy background closes with return focus; manual announcement opens on every view',async({page})=>{
 await page.goto(preview+'#home');await ready(page);const opener=page.locator('.footer-note a[href="#about"]');await opener.click();const d=page.locator('#about-dialog');await expect(d).toBeVisible();await d.getByRole('heading').first().click();await expect(d).toBeVisible();await page.mouse.click(2,2);await expect(d).toBeHidden();await expect(opener).toBeFocused();
 for(const view of ['member','submit','admin','login']){await page.goto(preview+'?preview_identity=admin&preview_announcement=on#'+view);await ready(page);if(await page.locator('#announcement-dialog').isVisible())await page.locator('#announcement-close').click();await page.locator('#announcement-open').click();await expect(page.locator('#announcement-dialog')).toBeVisible();await page.locator('#announcement-close').click();}
});
