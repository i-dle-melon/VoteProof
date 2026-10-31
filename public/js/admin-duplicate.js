// Evidence only. No digest, member identity, object key or automatic review.
const states={unknown:'尚未分析',pending:'尚未分析',processing:'分析中',clear:'未發現相同檔案',
  exact_duplicate:'發現同會員同活動相同檔案',failed:'分析失敗／待重試',not_applicable:'不適用：此證明沒有會員身分'};
export function renderDuplicateEvidence(evidence,doc=document){
  const box=doc.createElement('section');box.className='member-case';box.setAttribute('aria-label','檔案比對提示');
  const text=(tag,value)=>{const n=doc.createElement(tag);n.textContent=value;box.append(n);};
  text('h3','檔案比對提示');
  if(evidence?.policy==='automatic_exact_v1'){
    const c=evidence.classification;
    const labels={clear:'未發現同會員同活動相同檔案',pending_match:'疑似重複：原案仍待審核，本案未自動判重複',
      exact_duplicate:'建案時已自動歸類為重複投稿，不重複發放積分',unknown:'歷史檔案缺少可信雜湊，結果 UNKNOWN'};
    text('p',labels[c.decision]??labels.unknown);
    text('p','依據：R2 已驗證 SHA-256；同會員、同活動。分類時間：'+c.created_at);
    if(c.reference_case_id)text('p','原案：'+c.reference_case_id+' · 分類時版本 '+c.reference_version+' · 目前狀態 '+c.current_reference_status);
    if(c.source_changed)text('p','原案狀態或版本已改變；以上為不可變的建案時判定，請人工確認。');
    return box;
  }
  if(!evidence||evidence.hash_state==='not_verified'){text('p','此證明尚未完成檔案比對。');return box;}
  if(evidence.hash_state==='partial')text('p','部分證明尚未完成檔案比對。');
  if(!evidence.analyses?.length)text('p','尚未分析');
  for(const item of evidence.analyses??[]){
    text('p',states[item.state]??states.unknown);
    if(item.state==='exact_duplicate'&&item.canonical_case_id&&item.canonical_file_id)
      text('p','同會員／同活動 exact SHA-256 match · '+item.canonical_case_id+' · 證明 '+item.canonical_file_id);
  }
  text('p','比對僅涵蓋同會員同活動完全相同的檔案；不會自動拒絕案件或修改點數。');return box;
}
