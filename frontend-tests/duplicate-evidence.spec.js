import {test,expect} from '@playwright/test';
import {adminFixture} from './admin-fixture.mjs';
test('Admin exact evidence displays relationship, prior status/time and never changes review automatically',async({page})=>{
 const state=await adminFixture(page);
 state.cases[0].duplicate_evidence={hash_state:'verified',exact_match_detected:true,policy:'review_evidence_only',matches:[
   {relationship:'cross_member_exact',previous_case_id:'VP-20261001-AAAAAAAAAAAAAAAA',previous_status:'approved',previous_submitted_at:'2026-10-01T00:00:00.000Z'},
   {relationship:'same_member_other_campaign',previous_case_id:'VP-20260901-BBBBBBBBBBBBBBBB',previous_status:'rejected',previous_submitted_at:'2026-09-01T00:00:00.000Z'},
 ]};
 await page.goto('/#admin');await page.locator('#admin-panel').getByRole('button',{name:'查看與審核',exact:true}).click();
 const evidence=page.getByRole('region',{name:'檔案比對提示'});
 await expect(evidence).toContainText('此檔案可能已提交過');await expect(evidence).toContainText('不同會員／相同檔案');
 await expect(evidence).toContainText('同一會員／不同活動');await expect(evidence).toContainText('VP-20261001-AAAAAAAAAAAAAAAA');
 await expect(evidence).toContainText('已通過');await expect(evidence).toContainText('2026-10-01');
 await expect(evidence).toContainText('不會自動拒絕案件');expect(state.calls.filter(c=>c.path.endsWith('/review'))).toHaveLength(0);
 await expect(evidence).not.toContainText(/email|sha256|proofs\/|@/);expect(state.cases[0].status).toBe('pending');
});
test('Unverified legacy proof displays honest missing hash state',async({page})=>{
 const state=await adminFixture(page);state.cases[0].duplicate_evidence={hash_state:'not_verified',exact_match_detected:false,matches:[]};
 await page.goto('/#admin');await page.locator('#admin-panel').getByRole('button',{name:'查看與審核',exact:true}).click();
 await expect(page.getByRole('region',{name:'檔案比對提示'})).toContainText('尚未完成檔案比對');
});
test('Evidence uses text nodes and handles partial/truncated state',async({page})=>{
 const state=await adminFixture(page);state.cases[0].duplicate_evidence={hash_state:'partial',exact_match_detected:true,truncated:true,matches:[{relationship:'guest_exact_unknown',previous_case_id:'<img src=x onerror=alert(1)>',previous_status:'pending',previous_submitted_at:'2026-01-01'}]};
 await page.goto('/#admin');await page.locator('#admin-panel').getByRole('button',{name:'查看與審核',exact:true}).click();
 const box=page.getByRole('region',{name:'檔案比對提示'});await expect(box).toContainText('部分證明');await expect(box).toContainText('僅顯示最近 100 筆');await expect(box.locator('img')).toHaveCount(0);await expect(box).toContainText('<img');
});
