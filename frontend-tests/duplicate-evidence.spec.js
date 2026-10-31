import {test,expect} from '@playwright/test';
import {adminFixture} from './admin-fixture.mjs';
async function open(page,evidence){const state=await adminFixture(page);state.cases[0].duplicate_evidence=evidence;await page.goto('/#admin');await page.locator('#admin-panel .case-preview').first().click({position:{x:12,y:12}});return {state,box:page.getByRole('region',{name:'檔案比對提示'})};}

test('direct intent cases omit cloud duplicate panel while private proof remains visible',async({page})=>{const {box}=await open(page,null);await expect(page.locator('.inline-review img')).toBeVisible();await expect(box).toHaveCount(0);});
test('V1 canonical evidence is member/Campaign scoped and never mutates review',async({page})=>{
 const {state,box}=await open(page,{hash_state:'verified',analyses:[{state:'exact_duplicate',canonical_case_id:'VP-20261001-AAAAAAAAAAAAAAAA',canonical_file_id:'synthetic-proof'}]});
 await expect(box).toContainText('發現同會員同活動相同檔案');await expect(box).toContainText('VP-20261001-AAAAAAAAAAAAAAAA');await expect(box).toContainText('synthetic-proof');
 await expect(box).not.toContainText(/不同會員|不同活動|proofs\/|@/);expect(state.calls.filter(c=>c.path.endsWith('/review'))).toHaveLength(0);expect(state.cases[0].status).toBe('pending');
});
test('Unverified proof honestly remains unknown',async({page})=>{const {box}=await open(page,{hash_state:'not_verified',analyses:[]});await expect(box).toContainText('尚未完成檔案比對');await expect(box).not.toContainText('未發現相同檔案');});
for(const [state,label] of [['pending','尚未分析'],['processing','分析中'],['clear','未發現相同檔案'],['failed','分析失敗／待重試']])test('V1 Admin analysis state '+state,async({page})=>{const {state:fixture,box}=await open(page,{hash_state:'verified',analyses:[{state}]});await expect(box).toContainText(label);if(state!=='clear')await expect(box).not.toContainText('未發現相同檔案');expect(fixture.calls.filter(c=>c.path.endsWith('/review'))).toHaveLength(0);});
test('Canonical evidence uses text nodes and cannot render markup',async({page})=>{const {box}=await open(page,{hash_state:'partial',analyses:[{state:'exact_duplicate',canonical_case_id:'<img src=x onerror=alert(1)>',canonical_file_id:'synthetic-proof'},{state:'pending'}]});await expect(box).toContainText('部分證明');await expect(box.locator('img')).toHaveCount(0);await expect(box).toContainText('<img');});
for(const [decision,label] of [['exact_duplicate','自動歸類為重複投稿'],['pending_match','原案仍待審核'],['unknown','UNKNOWN']])test('new Direct classification is truthful and read-only: '+decision,async({page})=>{
 const {state,box}=await open(page,{policy:'automatic_exact_v1',hash_state:'verified',classification:{decision,created_at:'2026-10-31T00:00:00.000Z',reference_case_id:decision==='unknown'?null:'VP-20261001-AAAAAAAAAAAAAAAA',reference_version:1,current_reference_status:'approved',source_changed:true}});
 await expect(box).toContainText(label);await expect(box).toContainText('R2 已驗證 SHA-256');
 if(decision!=='unknown'){await expect(box).toContainText('VP-20261001-AAAAAAAAAAAAAAAA');await expect(box).toContainText('原案狀態或版本已改變');}if(decision==='exact_duplicate')await box.scrollIntoViewIfNeeded();if(decision==='exact_duplicate')await page.screenshot({path:'.wrangler/frontend-previews/exact-classification-admin-'+test.info().project.name+'.png'});
 expect(state.calls.filter(c=>c.path.endsWith('/review'))).toHaveLength(0);
});
test('new classification basis is text-only, no HTML execution',async({page})=>{const {box}=await open(page,{policy:'automatic_exact_v1',hash_state:'verified',classification:{decision:'pending_match',created_at:'<script>bad()</script>',reference_case_id:'<img src=x onerror=bad()>',reference_version:0,current_reference_status:'pending'}});await expect(box.locator('img,script')).toHaveCount(0);await expect(box).toContainText('<img');});
