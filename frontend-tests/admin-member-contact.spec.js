import {test,expect} from './isolated-ui-fixture.mjs';
const preview='http://127.0.0.1:4174/VoteProof/';
async function overview(page,options='preview_identity=admin'){
 await page.goto(preview+'?'+options+'#admin');await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');await page.locator('#admin-tabs').getByRole('button',{name:'工作總覽',exact:true}).click();await expect(page.locator('#admin-panel')).toHaveAttribute('aria-busy','false');
}
async function lookup(page,fan='fan_yeh'){
 await page.getByRole('button',{name:'會員查詢',exact:true}).click();const d=page.getByRole('dialog',{name:'會員查詢',exact:true});await d.getByLabel('粉絲 ID',{exact:true}).fill(fan);await d.getByRole('button',{name:'查詢',exact:true}).click();await expect(d.locator('.member-lookup-result')).toContainText('已驗證 Email');return d;
}
test('lookup beside member total; result fields, exact search, blocked and multi-address fixtures',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await overview(page);
 const card=page.locator('[data-member-total]');await expect(card.getByRole('button',{name:'會員查詢'})).toBeVisible();await expect(card).toContainText('1284');
 const d=await lookup(page,' FAN_YEH ');for(const label of ['葉子','fan_yeh','preview-fan-yeh@example.invalid','會員等級','目前總點數','累計投稿數','註冊時間','登入方式','最後更新時間'])await expect(d).toContainText(label);
 const fan=d.getByLabel('粉絲 ID',{exact:true});await fan.fill('not_found');await d.getByRole('button',{name:'查詢',exact:true}).click();await expect(d.getByRole('status')).toHaveText('找不到此粉絲 ID 的會員。');await expect(d.locator('.member-lookup-result')).toBeEmpty();
 await fan.fill('preview_blocked_fan');await d.getByRole('button',{name:'查詢',exact:true}).click();await expect(d).toContainText('已被封鎖');
 await fan.fill('preview_multi_fan');await d.getByRole('button',{name:'查詢',exact:true}).click();await expect(d.getByRole('button',{name:'寄信給會員',exact:true})).toHaveCount(2);await expect(d).toContainText('有多個不同的已驗證 Email');
 await d.getByRole('button',{name:'寄信給會員',exact:true}).nth(1).click();await expect(page.getByRole('dialog',{name:'寄信給會員',exact:true}).getByLabel('收件者（唯讀）')).toHaveValue('preview-second@example.invalid');expect(errors).toEqual([]);
});
test('Gmail-like native composer fixes From/To, prefill editable, send once and success',async({page})=>{
 await overview(page);const d=await lookup(page);await d.getByRole('button',{name:'寄信給會員',exact:true}).click();const c=page.getByRole('dialog',{name:'寄信給會員',exact:true});
 await expect(c.getByLabel('寄件者（唯讀）')).toHaveValue('idle.voteproof.verify@gmail.com');await expect(c.getByLabel('寄件者（唯讀）')).toHaveAttribute('readonly','');await expect(c.getByLabel('收件者（唯讀）')).toHaveValue('preview-fan-yeh@example.invalid');await expect(c.getByLabel('收件者（唯讀）')).toHaveAttribute('readonly','');
 await c.getByRole('button',{name:'帶入說明',exact:true}).click();expect(await c.getByLabel('內容（純文字）').inputValue()).toContain('展示客服說明');await c.getByLabel('主旨',{exact:true}).fill('展示客服回覆');await c.getByLabel('內容（純文字）').fill('您好，這是編輯後的純文字內容。');
 await page.evaluate(async()=>{const{MemberSession}=await import('./js/member-api.js');const original=MemberSession.prototype.adminRequest;window.mailCalls=[];MemberSession.prototype.adminRequest=async function(p,o){if(p.endsWith('/member-mail/send'))window.mailCalls.push(o.body);return original.call(this,p,o);};});
 await c.getByRole('button',{name:'傳送',exact:true}).evaluate(b=>{b.click();b.click();});await expect(c.getByRole('status')).toHaveText('郵件已傳送。');await expect(c.getByRole('button',{name:'已傳送',exact:true})).toBeDisabled();const calls=await page.evaluate(()=>window.mailCalls);expect(calls).toHaveLength(1);expect(Object.keys(calls[0]).sort()).toEqual(['body','member_id','mutation_id','recipient_ref','subject']);
 await c.getByRole('button',{name:'捨棄',exact:true}).click();await expect(c).toHaveCount(0);await expect(d.getByRole('button',{name:'寄信給會員',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(d).toHaveCount(0);await expect(page.getByRole('button',{name:'會員查詢',exact:true})).toBeFocused();
});
test('confirmed failure preserves editable draft; ambiguous result disables resend',async({page})=>{
 await overview(page,'preview_identity=admin&preview_mail=rejected');let d=await lookup(page);await d.getByRole('button',{name:'寄信給會員',exact:true}).click();let c=page.getByRole('dialog',{name:'寄信給會員',exact:true});await c.getByLabel('主旨',{exact:true}).fill('未寄出測試');await c.getByLabel('內容（純文字）').fill('保留我的草稿');await c.getByRole('button',{name:'傳送',exact:true}).click();await expect(c.getByRole('status')).toContainText('已確認未寄出');await expect(c.getByLabel('內容（純文字）')).toHaveValue('保留我的草稿');await expect(c.getByLabel('主旨',{exact:true})).toBeEditable();await expect(c.getByRole('button',{name:'傳送',exact:true})).toBeEnabled();
 await overview(page,'preview_identity=admin&preview_mail=ambiguous');d=await lookup(page);await d.getByRole('button',{name:'寄信給會員',exact:true}).click();c=page.getByRole('dialog',{name:'寄信給會員',exact:true});await c.getByLabel('主旨',{exact:true}).fill('PREVIEW_AMBIGUOUS');await c.getByLabel('內容（純文字）').fill('結果不明的草稿');await c.getByRole('button',{name:'傳送',exact:true}).click();await expect(c.getByRole('status')).toContainText('寄送結果不明');await expect(c.getByRole('button',{name:'結果不明',exact:true})).toBeDisabled();await expect(c.getByLabel('內容（純文字）')).toHaveValue('結果不明的草稿');
});
test('reviewer retains exactly three tabs without lookup; guest/member direct fixture forbidden',async({page})=>{
 await overview(page,'preview_identity=reviewer');await expect(page.locator('#admin-tabs button')).toHaveCount(3);await expect(page.getByRole('button',{name:'會員查詢',exact:true})).toHaveCount(0);
 for(const role of ['reviewer','member','guest']){await page.goto(preview+'?preview_identity='+role+'#home');await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');const statuses=await page.evaluate(async()=>{const{previewFetch}=await import('./js/preview.js');return Promise.all(['/api/admin/member-lookup','/api/admin/member-mail/send'].map(async p=>(await previewFetch(p,{method:'POST',body:{fan_id:'fan_yeh'}})).status));});expect(statuses).toEqual([403,403]);}
});
test('lookup/compose accessible focus and RWD 320/390/430/1024/1440 in Dark/Light without network calls',async({page})=>{
 const external=[];page.on('request',r=>{const u=new URL(r.url());if(u.origin!=='http://127.0.0.1:4174'||u.protocol!=='blob:'&&u.pathname.startsWith('/api/'))external.push(r.url());});
 for(const width of [320,390,430,1024,1440])for(const theme of ['dark','light']){
 await page.setViewportSize({width,height:900});await overview(page,'preview_identity=admin&preview_theme='+theme);const d=await lookup(page);await expect(d.getByRole('button',{name:'關閉',exact:true})).toBeVisible();await d.getByRole('button',{name:'關閉',exact:true}).focus();await page.keyboard.press('Shift+Tab');await expect(d.getByRole('button',{name:'寄信給會員',exact:true})).toBeFocused();await page.keyboard.press('Tab');await expect(d.getByRole('button',{name:'關閉',exact:true})).toBeFocused();
 expect((await d.boundingBox()).width).toBeLessThanOrEqual(width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await d.getByRole('button',{name:'寄信給會員',exact:true}).click();const c=page.getByRole('dialog',{name:'寄信給會員',exact:true});await expect(c).toHaveClass(/member-mail-compose/);expect((await c.boundingBox()).width).toBeLessThanOrEqual(width);expect(await c.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await page.keyboard.press('Escape');await expect(c).toHaveCount(0);await expect(d.getByRole('button',{name:'寄信給會員',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'會員查詢',exact:true})).toBeFocused();
 }expect(external).toEqual([]);
});
