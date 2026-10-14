// Evidence only. No digest, member identity, object key or automatic review.
const states={unknown:'尚未分析',pending:'尚未分析',processing:'分析中',clear:'未發現相同檔案',
  exact_duplicate:'發現同會員同活動相同檔案',failed:'分析失敗／待重試',not_applicable:'不適用：此證明沒有會員身分'};
export function renderDuplicateEvidence(evidence,doc=document){
  const box=doc.createElement('section');box.className='member-case';box.setAttribute('aria-label','檔案比對提示');
  const text=(tag,value)=>{const n=doc.createElement(tag);n.textContent=value;box.append(n);};
  text('h3','檔案比對提示');
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
