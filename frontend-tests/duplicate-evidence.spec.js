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
