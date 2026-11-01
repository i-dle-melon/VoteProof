import {expect} from '@playwright/test';
// Member roles/tiers moved inside Member Management; this still uses the real
// visible controls and server revalidation, never an internal render shortcut.
export async function selectAdminTab(page,name){
 const panel=page.locator('#admin-panel');
 if(['會員等級','會員封鎖'].includes(name)){
  await page.locator('#admin-tabs').getByRole('button',{name:'會員管理',exact:true}).click();
  await expect(panel).toHaveAttribute('aria-busy','false');
  await panel.getByRole('button',{name,exact:true}).click();
 }else await page.locator('#admin-tabs').getByRole('button',{name,exact:true}).click();
 await expect(panel).toHaveAttribute('aria-busy','false');
}
