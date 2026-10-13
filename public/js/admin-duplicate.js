// Evidence only. No digest, email, member ID, object key or automatic review action.
const labels={same_member_same_campaign:'同一會員／同一活動',cross_member_exact:'不同會員／相同檔案',same_member_other_campaign:'同一會員／不同活動',guest_exact_unknown:'會員關係無法確認'};
const statuses={pending:'待審核',approved:'已通過',completed:'已完成',rejected:'未通過',duplicate:'重複案件',revoked:'已撤銷'};
export function renderDuplicateEvidence(evidence,doc=document){
 const box=doc.createElement('section');box.className='member-case';box.setAttribute('aria-label','檔案比對提示');
 const text=(tag,value)=>{const n=doc.createElement(tag);n.textContent=value;box.append(n);};
 text('h3','檔案比對提示');
 if(!evidence||evidence.hash_state==='not_verified'){text('p','此證明尚未完成檔案比對。');return box;}
 if(evidence.hash_state==='partial')text('p','部分證明尚未完成檔案比對。');
 text('p',evidence.exact_match_detected?'此檔案可能已提交過，請依案件資料人工判斷。':'目前未找到相同檔案。');
 for(const m of evidence.matches??[]){
   if(!labels[m.relationship])continue;
   text('p',`${labels[m.relationship]} · ${m.previous_case_id} · ${statuses[m.previous_status]??'狀態未提供'} · ${m.previous_submitted_at}`);
 }
 if(evidence.truncated)text('p','相符紀錄較多，僅顯示最近 100 筆。');
 text('p','比對僅涵蓋完全相同的檔案；不會自動拒絕案件。');return box;
}
