const el=(tag,text='',cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const button=(text,action,cls='btn btn-white')=>{const b=el('button',text,cls);b.type='button';b.addEventListener('click',action);return b;};
const caseStatuses={pending:'待審核',approved:'已通過',completed:'已完成',rejected:'未通過',duplicate:'重複投稿',revoked:'已撤銷'};
const backupStatuses={confirmed:'已確認',pending:'待備份',processing:'備份中',failed:'備份失敗'};
const statusOptions=labels=>[['','全部'],...Object.entries(labels)];
const formatSize=size=>size.toLocaleString('zh-TW')+' 位元組';
export async function renderManualCleanup({container,request,run,isCurrent,loadProof}){
 const selected=new Map(),filters=el('form','','admin-filter manual-cleanup-filter'),list=el('section','','grid grid-2'),status=el('p','','notice info'),count=el('p'),progress=el('p');status.setAttribute('role','status');
 container.append(el('h2','R2 手動清理'),el('p','重複投稿、未通過及已撤銷的圖片可直接選取，無需備份、下載或等待 7 天。已完成案件須有與原圖相符的 Drive 備份或已確認下載紀錄，通常須結案滿 7 天。台灣時間 2026 年 11 月 25 日前的投稿圖片免等 7 天，可使用既有 Drive 備份確認紀錄。較新的圖片使用 Drive 備份時須即時驗證，若已確認下載則可勾選提早清理。','tiny'));
 const control=(name,title,type,choices)=>{const l=el('label',title),n=el(type==='select'?'select':'input');n.name=name;n.setAttribute('aria-label',title);if(type==='select')for(const[v,t]of choices)n.append(new Option(t,v));else n.type=type;l.append(n);filters.append(l);return n;};
 const campaign=control('campaign_id','活動','text'),choices=el('datalist');choices.id='manual-cleanup-campaigns';campaign.setAttribute('list',choices.id);filters.append(choices);
 void request('campaigns?limit=50').then(d=>{if(isCurrent())for(const c of d.campaigns??[]){const option=new Option(c.name,c.campaign_id);choices.append(option);}}).catch(()=>{});
 control('from','投稿開始日期（台灣）','date');control('to','投稿結束日期（台灣）','date');
 control('status','案件狀態','select',statusOptions(caseStatuses));
 control('backup','Drive 備份狀態','select',statusOptions(backupStatuses));
 control('eligible','清理資格','select',[['','全部'],['yes','可進入清理驗證'],['no','不可清理']]);
 const search=el('button','搜尋','btn btn-primary');search.type='submit';filters.append(search);
 let query=new URLSearchParams(),cutoff=null,cursor=null,all=null,working=false,stopRequested=false,epoch=0,enabled=false,preview=null;
 const closePreview=()=>{if(preview){const d=preview;preview=null;d.close();d.remove();}};
 async function showProof(row){if(working||!loadProof)return;const n=epoch;try{const blob=await loadProof(row);if(!active(n))return;closePreview();const d=el('dialog','','proof-preview-dialog'),image=el('img'),url=URL.createObjectURL(blob);image.src=url;image.alt='清理前圖片預覽';d.append(button('關閉',()=>d.close()),image);container.append(d);preview=d;d.addEventListener('close',()=>{URL.revokeObjectURL(url);d.remove();if(preview===d)preview=null;},{once:true});d.showModal();}catch(e){if(isCurrent())status.textContent=e.code==='PROOF_ARCHIVED_IN_DRIVE'?'圖片已從網站清理，無法預覽。':e.message??'圖片暫時無法預覽';}}
 const checkboxes=new Map(),actions=el('div','','manual-cleanup-actions'),stop=button('停止後續圖片',()=>{stopRequested=true;});stop.dataset.reviewStop='';stop.hidden=true;
 const earlyExport=el('input'),earlyLabel=el('label','未滿 7 天也可清理（僅限已確認下載）','manual-cleanup-early');
 earlyExport.type='checkbox';earlyLabel.prepend(earlyExport);
 const execute=button('確認清理已選圖片',()=>void clean(),'btn btn-review-reject'),more=button('載入更多',()=>void page(false));
 const active=n=>isCurrent()&&n===epoch;
 function markFile(row,text){selected.delete(row.file_id);const b=checkboxes.get(row.file_id);if(b){b.disabled=true;b.dataset.eligible='false';b.dataset.reviewCommitted='true';const card=b.closest('article');card.lastElementChild.textContent=text;for(const button of card.querySelectorAll('button')){button.disabled=true;button.dataset.reviewCommitted='true';}}}
 function markDeleted(row){
  selected.delete(row.file_id);
  checkboxes.get(row.file_id)?.closest('article')?.remove();
  checkboxes.delete(row.file_id);
 }
 const markUnknown=row=>markFile(row,'刪除結果待人工核對；不會重送。');
 function sync(){const n=all?all.total-all.excluded.size:selected.size,bytes=all?all.bytes-[...all.excluded.values()].reduce((s,r)=>s+r.size,0):[...selected.values()].reduce((s,r)=>s+r.size,0);count.textContent='已選 '+n+' 張 · 預計釋放 '+formatSize(bytes)+(all?'（符合目前篩選的全部分頁）':'');earlyExport.disabled=working;execute.dataset.reviewCommitted=String(working||n===0||!enabled);execute.disabled=working||n===0||!enabled;for(const[id,b]of checkboxes)b.checked=all?b.dataset.eligible==='true'&&!all.excluded.has(id):selected.has(id);}
 const params=()=>{const p=new URLSearchParams(query);if(cutoff)p.set('cutoff',cutoff);return p;};
 async function page(reset){
  if(working)return;const n=++epoch;
  if(reset){selected.clear();all=null;list.replaceChildren();checkboxes.clear();cursor=null;cutoff=null;query=new URLSearchParams([...new FormData(filters)].filter(([,v])=>v));
   if(earlyExport.checked)query.set('allow_early_export','1');
   more.hidden=true;sync();
  }
  const p=params();p.set('summary','0');if(cursor)p.set('cursor',cursor);
  try{const d=await request('storage/manual?'+p);if(!active(n))return;cutoff=d.cutoff;cursor=d.next_cursor;enabled=d.enabled===true;
   for(const row of d.items){
    if(row.cleanup_state==='cold')continue;
    const c=el('article','','member-case'),label=el('label',row.case_id),box=el('input');box.type='checkbox';box.disabled=!row.eligible;box.dataset.eligible=String(row.eligible);box.setAttribute('aria-label','選取圖片 '+row.file_id);label.prepend(box);box.addEventListener('change',()=>{if(all){if(box.checked)all.excluded.delete(row.file_id);else all.excluded.set(row.file_id,row);}else if(box.checked)selected.set(row.file_id,row);else selected.delete(row.file_id);sync();});checkboxes.set(row.file_id,box);
    c.append(label,el('p',(Object.hasOwn(caseStatuses,row.status)?caseStatuses[row.status]:'狀態不明')+' · '+formatSize(row.size)));
    if(loadProof&&row.cleanup_state!=='deleting')c.append(button('預覽圖片',()=>void showProof(row)));
    c.append(el('p',row.reason));list.append(c);
   }
   more.hidden=!cursor;status.textContent=!enabled?'手動清理尚未啟用，目前只提供唯讀候選清單。':!cursor&&!list.childElementCount?'沒有符合篩選的圖片。':'候選清單為唯讀；實際清理前重新檢查全部安全條件。';sync();
  }catch(e){if(active(n))status.textContent=e.code??e.message??'無法載入。';}
 }
 async function select(first20){
  if(working)return;working=true;sync();const n=epoch;
  try{const p=params();p.set('eligible','yes');if(first20)p.set('summary','0');const d=await request('storage/manual?'+p);if(!active(n))return;selected.clear();
   if(first20){all=null;for(const r of d.items)selected.set(r.file_id,r);}else all={total:d.eligible_count,bytes:d.eligible_bytes,query:p,excluded:new Map()};
  }catch(e){status.textContent=e.code??e.message;}finally{working=false;sync();}
 }
 async function clean(){
  if(working||!enabled||(!all&&!selected.size))return;closePreview();const plan=all?{...all,query:new URLSearchParams(all.query),excluded:new Map(all.excluded)}:null,items=[...selected.values()],total=plan?plan.total-plan.excluded.size:items.length;if(!total)return;
  const allowEarlyExport=query.has('allow_early_export');
  const earlyWarning=allowEarlyExport?'\n已勾選提早清理，符合條件的已下載圖片可在結案未滿 7 天時刪除。':'';
  if(!confirm('確認清理已選 '+total+' 張 R2 原始圖片？'+earlyWarning+'\n11 月 25 日前的投稿圖片可使用既有 Drive 備份確認紀錄，符合清理條件即可免等 7 天。\n重複投稿、未通過及已撤銷的圖片可無備份清理。若沒有另外留存，清理後將無法取回原圖。\n案件、積分與現有 Drive 備份會保留。以匯出紀錄清理的圖片請先保留下載的 ZIP。清理後無法線上讀取或再次匯出。刪除結果不明時會立即停止，不會重送。'))return;
  await run(async()=>{working=true;stopRequested=false;stop.hidden=false;let done=0,deleted=0,failed=0,unknown=0,next=null,queue=items,morePages=!!plan;
   try{while(isCurrent()&&!stopRequested&&(queue.length||morePages)){
    if(!queue.length){const p=new URLSearchParams(plan.query);p.set('summary','0');if(next)p.set('cursor',next);const d=await request('storage/manual?'+p);queue=d.items;next=d.next_cursor;morePages=!!next;if(!queue.length)continue;}
    const row=queue.shift();if(plan?.excluded.has(row.file_id))continue;const input={file_id:row.file_id,case_version:row.case_version,backup_version:row.backup_version,attempt_id:crypto.randomUUID(),
     ...(row.archive_source==='none'?{without_archive:true}:allowEarlyExport&&row.archive_source==='export'?{allow_early_export:true}:{})};
    try{const d=await request('storage/manual/'+row.file_id+'/clean',{method:'POST',body:input});
     if(d.state==='deleted'){deleted++;markDeleted(row);}else{unknown++;markUnknown(row);stopRequested=true;}
    }catch(e){
     // Read only after any failed request. No automatic re-verify/re-DELETE.
     try{const s=await request('storage/manual/'+row.file_id+'/status');if(s.state==='deleted'){deleted++;markDeleted(row);}else if(['unknown','verifying','deleting'].includes(s.state)){unknown++;markUnknown(row);stopRequested=true;}else{failed++;status.textContent=e.code??e.message;}}catch{unknown++;markUnknown(row);stopRequested=true;}
    }
    done++;progress.textContent='已處理 '+done+'/'+total+' · 已清理 '+deleted+' · 失敗 '+failed+' · 未確認 '+unknown;
   }}finally{working=false;stop.hidden=true;all=null;sync();status.textContent=unknown?'結果不明，已停止；保留鎖、稽核及待對帳狀態。':stopRequested?'已停止後續清理。':'本次處理完成；需要重新搜尋取得最新資格。';}
  });
 }
 actions.append(button('選取全部可清理圖片',()=>void select(false)),button('選取前20張可清理圖片',()=>void select(true)),button('清除目前選取',()=>{if(!working){selected.clear();all=null;sync();}}),earlyLabel,execute,stop);
 earlyExport.addEventListener('change',()=>void page(true));
 filters.addEventListener('submit',e=>{e.preventDefault();if(!working)void page(true);});container.append(filters,actions,count,status,progress,list,more);await page(true);
 return()=>{epoch++;closePreview();};
}
