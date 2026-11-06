import {test,expect} from '@playwright/test';

test('auto duplicate batch results stay distinct from approvals and failures in Dark/Light',async({page})=>{
 const requests=[];page.on('request',r=>requests.push(r.url()));page.on('dialog',d=>d.accept());
 // Local UI response contract only. Backend classification is independently tested
 // with real handlers/SQLite; this does not provide trusted proof or call Production.
 await page.route('**/js/preview-fixtures.js',async route=>{
  const response=await route.fetch(),source=await response.text();
  const before='row.status="approved";row.version++;row.points_awarded=row.source==="guest"?0:10;return {ok:true,...row,outcome:"approved"};';
  expect(source.split(before)).toHaveLength(2);
  await route.fulfill({response,body:source.replace(before,`row.status=item.case_id==='VP-PREVIEW-006'?'approved':'duplicate';row.version++;
   row.points_awarded=row.status==='duplicate'||row.source==='guest'?0:10;
   return {ok:true,...row,outcome:row.status==='duplicate'?'duplicate':'approved'};`)});
 });
 for(const theme of['dark','light']){
  await page.goto('http://127.0.0.1:4174/VoteProof/?preview_identity=admin&preview_theme='+theme+'#admin');
  await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
  await page.getByRole('button',{name:'選取前20張初審案件',exact:true}).click();
  await expect(page.locator('[data-review-select]:checked')).toHaveCount(3);
  await page.locator('#admin-batch-approve').click();
  await expect(page.locator('.batch-review-results')).toContainText('成功 1 · 重複投稿 2 · 失敗 0 · 未確認 0');
  await page.screenshot({path:'.wrangler/pending-exact-summary-'+test.info().project.name+'-'+theme+'.png'});
  await expect(page.locator('#admin-batch-approve')).toBeDisabled();
  const cases=await page.evaluate(async()=>{const m=await import('./js/preview-fixtures.js');return m.adminCases.filter(c=>['VP-PREVIEW-001','VP-PREVIEW-004'].includes(c.case_id)).map(c=>({status:c.status,points:c.points_awarded}));});
  expect(cases).toEqual([{status:'duplicate',points:0},{status:'duplicate',points:0}]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
 expect(requests.some(u=>['http:','https:'].includes(new URL(u).protocol)&&(new URL(u).hostname!=='127.0.0.1'||new URL(u).pathname.startsWith('/api/')))).toBe(false);
});

test('single approve that resolves duplicate reports the actual result after closing detail',async({page})=>{
 page.on('dialog',d=>d.accept());
 await page.route('**/js/preview-fixtures.js',async route=>{
  const response=await route.fetch(),source=await response.text();
  const before='row.status={approve:"approved",reject:"rejected",mark_duplicate:"duplicate",complete:"completed",revoke:"revoked"}[input.action];';
  expect(source.split(before)).toHaveLength(2);
  await route.fulfill({response,body:source.replace(before,`if(input.action==='approve'){row.status='duplicate';row.version++;row.points_awarded=0;return reply({...row,review_outcome:'auto_duplicate'});} `+before)});
 });
 await page.goto('http://127.0.0.1:4174/VoteProof/?preview_identity=admin#admin');
 await expect(page.locator('html')).toHaveAttribute('data-preview-ready','true');
 await page.locator('.admin-case-row').first().locator('.case-preview').click({position:{x:12,y:12}});
 await page.locator('#admin-field-action').selectOption('approve');
 await page.locator('[data-preview-review] button[type=submit]').click();
 await expect(page.locator('#admin-panel > .notice')).toContainText('已歸類重複投稿');
 await expect(page.locator('#admin-panel > .notice')).toContainText('未重複發放積分');
 await expect(page.locator('.inline-review')).toHaveCount(0);
});
