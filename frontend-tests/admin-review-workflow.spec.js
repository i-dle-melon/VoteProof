import {test,expect} from '@playwright/test';
const base='http://127.0.0.1:4174/VoteProof/?preview_identity=admin';
const ready=async page=>expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');

test('album tiles show only square photos and accessible selection circles at mobile and desktop sizes',async({page})=>{
 for(const width of [320,390,430,1024,1440])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:850});await page.goto(base+'&preview_theme='+theme+'#admin');await ready(page);
  const tile=page.locator('.review-album .album-case').first(),photo=tile.locator('.case-preview'),select=tile.locator('[data-review-select]');
  await photo.scrollIntoViewIfNeeded();await expect(photo.locator('img')).toBeVisible();
  for(const selector of ['.case-summary','.review-person',':scope > .status','.review-actions'])await expect(tile.locator(selector)).toBeHidden();
  await expect(photo).toHaveText('');await expect(tile.locator('.album-select')).toHaveText('');
  const imageBox=await photo.boundingBox(),hitBox=await tile.locator('.album-select').boundingBox();
  expect(Math.abs(imageBox.width-imageBox.height)).toBeLessThan(1);expect(hitBox.width).toBeGreaterThanOrEqual(44);expect(hitBox.height).toBeGreaterThanOrEqual(44);
  const columns=await page.locator('.review-album').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);expect(columns).toBe(width<=600?3:width<1200?4:6);
  await select.check();await expect(select).toBeChecked();await expect(page.locator('.inline-review')).toHaveCount(0);
  await select.focus();await page.keyboard.press('Space');await expect(select).not.toBeChecked();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await photo.click({position:{x:12,y:12}});await expect(page.locator('.inline-review img')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await tile.getByRole('button',{name:'收合',exact:true}).click();await expect(page.locator('.inline-review')).toHaveCount(0);
 }
});
test('album exact IDs batch approve supports partial failure and retries only failed selection',async({page})=>{
 page.on('dialog',d=>d.accept());const requests=[];page.on('request',r=>requests.push(r.url()));
 await page.goto(base+'&preview_review=partial#admin');await ready(page);
 await expect(page.locator('.review-album .admin-case-row')).toHaveCount(3);
 await page.locator('.review-album .case-preview').first().scrollIntoViewIfNeeded();await expect(page.locator('.review-album img').first()).toBeVisible();
 await page.getByRole('button',{name:'選取已載入初審案件',exact:true}).click();
 await expect(page.locator('[data-review-select]:checked')).toHaveCount(3);
 await page.locator('#admin-batch-approve').click();
 await expect(page.locator('.batch-review-results')).toContainText('VP-PREVIEW-001 · 已通過');
 await expect(page.locator('.batch-review-results')).toContainText('VP-PREVIEW-004');
 await expect(page.locator('[data-review-select]:checked')).toHaveCount(1);
 await page.locator('#admin-batch-approve').click();
 await expect(page.locator('.batch-review-results')).toContainText('VP-PREVIEW-004 · 已通過');
 await expect(page.locator('#admin-batch-approve')).toBeDisabled();
 const states=await page.evaluate(async()=>{const m=await import('./js/preview-fixtures.js');return m.adminCases.filter(c=>['VP-PREVIEW-001','VP-PREVIEW-004','VP-PREVIEW-006'].includes(c.case_id)).map(c=>({id:c.case_id,status:c.status,version:c.version,points:c.points_awarded}));});
 expect(states.every(s=>s.status==='approved'&&s.version===2)).toBe(true);
 expect(states.find(s=>s.id==='VP-PREVIEW-006').points).toBe(0);
 expect(requests.some(u=>['http:','https:'].includes(new URL(u).protocol)&&(u.includes('/api/')||new URL(u).hostname!=='127.0.0.1'))).toBe(false);
});
test('manual risk reason moves case to detailed queue without rejection or automatic points',async({page})=>{
 page.on('dialog',d=>d.accept());await page.goto(base+'#admin');await ready(page);
 await page.locator('.admin-case-row').first().locator('.case-preview').click({position:{x:12,y:12}});
 await page.locator('#admin-field-action').selectOption('flag_detailed');
 await expect(page.locator('#admin-field-review_risk_reason option')).toHaveCount(4);
 await page.locator('#admin-field-review_risk_reason').selectOption('exact_duplicate');
 await page.locator('#admin-field-reason').fill('Manual inspection concern');
 await page.locator('[data-preview-review] button[type=submit]').click();
 await expect(page.locator('.inline-review')).toHaveCount(0);
 await page.getByRole('button',{name:'詳細審核',exact:true}).click();
 const card=page.locator('.admin-case-row').filter({hasText:'VP-PREVIEW-001'});
 await expect(card).toContainText('詳細審核');
 await expect(card.locator(':scope > .status')).toHaveText('待審核');
 const data=await page.evaluate(async()=>{const m=await import('./js/preview-fixtures.js');const row=m.adminCases.find(c=>c.case_id==='VP-PREVIEW-001');return {status:row.status,points:row.points_awarded,stage:row.review_stage,reason:row.review_risk_reason};});
 expect(data).toEqual({status:'pending',points:0,stage:'detailed',reason:'exact_duplicate'});
 await card.locator('.case-preview').click({position:{x:12,y:12}});await page.locator('#admin-field-action').selectOption('approve');await page.locator('[data-preview-review] button[type=submit]').click();
 await expect(page.locator('.inline-review')).toHaveCount(0);await expect(card.locator(':scope > .status')).toHaveText('已通過');
});
test('album and inline detail fit mobile Dark/Light; leaving Admin clears private images',async({page})=>{
 for(const width of [320,390,430])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:850});await page.goto(base+'&preview_theme='+theme+'#admin');await ready(page);
  await page.locator('.review-album .case-preview').first().scrollIntoViewIfNeeded();await expect(page.locator('.review-album img').first()).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.admin-case-row').first().locator('.case-preview').click({position:{x:12,y:12}});
  await expect(page.locator('.inline-review img')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(()=>location.hash='member');await expect(page.locator('#admin-panel img')).toHaveCount(0);
 }
});
