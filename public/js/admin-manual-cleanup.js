const el=(tag,text='',cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const button=(text,action,cls='btn btn-white')=>{const b=el('button',text,cls);b.type='button';b.addEventListener('click',action);return b;};
export async function renderManualCleanup({container,request,run,isCurrent,loadProof}){
 const selected=new Map(),filters=el('form','','admin-filter'),list=el('section','','grid grid-2'),status=el('p','','notice info'),count=el('p'),progress=el('p');status.setAttribute('role','status');
 container.append(el('h2','R2 手動清理'),el('p','僅清理已結案並超過7天、備份確認且無衝突的圖片；每張仍須即時驗證Drive與R2。只刪R2原始檔，保留案件、積分及永久Drive備份。不啟用自動清理。','tiny'));
 const control=(name,title,type,choices)=>{const l=el('label',title),n=el(type==='select'?'select':'input');n.name=name;n.setAttribute('aria-label',title);if(type==='select')for(const[v,t]of choices)n.append(new Option(t,v));else n.type=type;l.append(n);filters.append(l);return n;};
 const campaign=control('campaign_id','Campaign','text'),choices=el('datalist');choices.id='manual-cleanup-campaigns';campaign.setAttribute('list',choices.id);filters.append(choices);
 void request('campaigns?limit=50').then(d=>{if(isCurrent())for(const c of d.campaigns??[]){const option=new Option(c.name,c.campaign_id);choices.append(option);}}).catch(()=>{});
 control('from','投稿開始日期（台灣）','date');control('to','投稿結束日期（台灣）','date');
 control('status','案件狀態','select',[['','全部'],...['pending','approved','completed','rejected','duplicate','revoked'].map(x=>[x,x])]);
 control('backup','Drive備份狀態','select',[['','全部'],...['confirmed','pending','processing','failed'].map(x=>[x,x])]);
 control('eligible','清理資格','select',[['','全部'],['yes','可進入清理驗證'],['no','不可清理']]);
 const search=el('button','搜尋','btn btn-primary');search.type='submit';filters.append(search);
 let query=new URLSearchParams(),cutoff=null,cursor=null,all=null,working=false,stopRequested=false,epoch=0,enabled=false,preview=null;
 const closePreview=()=>{if(preview){const d=preview;preview=null;d.close();d.remove();}};
 async function showProof(row){if(working||!loadProof)return;const n=epoch;try{const blob=await loadProof(row);if(!active(n))return;closePreview();const d=el('dialog','','proof-preview-dialog'),image=el('img'),url=URL.createObjectURL(blob);image.src=url;image.alt='清理前圖片預覽';d.append(button('關閉',()=>d.close()),image);container.append(d);preview=d;d.addEventListener('close',()=>{URL.revokeObjectURL(url);d.remove();if(preview===d)preview=null;},{once:true});d.showModal();}catch(e){if(isCurrent())status.textContent=e.code==='PROOF_ARCHIVED_IN_DRIVE'?'圖片已清理，備份保存在 Google Drive':e.message??'圖片暫時無法預覽';}}
 const checkboxes=new Map(),actions=el('div','','manual-cleanup-actions'),stop=button('停止後續圖片',()=>{stopRequested=true;});stop.dataset.reviewStop='';stop.hidden=true;
 const execute=button('確認清理已選圖片',()=>void clean(),'btn btn-review-reject'),more=button('載入更多',()=>void page(false));
 const active=n=>isCurrent()&&n===epoch;
 function markFile(row,text){selected.delete(row.file_id);const b=checkboxes.get(row.file_id);if(b){b.disabled=true;b.dataset.eligible='false';b.dataset.reviewCommitted='true';const card=b.closest('article');card.lastElementChild.textContent=text;for(const button of card.querySelectorAll('button')){button.disabled=true;button.dataset.reviewCommitted='true';}}}
 const markDeleted=row=>markFile(row,'圖片已清理，備份保存在 Google Drive');
 const markUnknown=row=>markFile(row,'DELETE結果待人工核對；不會重送。');
 function sync(){const n=all?all.total-all.excluded.size:selected.size,bytes=all?all.bytes-[...all.excluded.values()].reduce((s,r)=>s+r.size,0):[...selected.values()].reduce((s,r)=>s+r.size,0);count.textContent='已選 '+n+' 張 · 預計釋放 '+bytes.toLocaleString()+' bytes'+(all?'（符合目前篩選的全部分頁）':'');execute.dataset.reviewCommitted=String(n===0||!enabled);execute.disabled=working||n===0||!enabled;for(const[id,b]of checkboxes)b.checked=all?b.dataset.eligible==='true'&&!all.excluded.has(id):selected.has(id);}
 const params=()=>{const p=new URLSearchParams(query);if(cutoff)p.set('cutoff',cutoff);return p;};
 async function page(reset){
  if(working)return;const n=++epoch;
  if(reset){selected.clear();all=null;list.replaceChildren();checkboxes.clear();cursor=null;cutoff=null;query=new URLSearchParams([...new FormData(filters)].filter(([,v])=>v));}
  const p=params();if(cursor)p.set('cursor',cursor);
  try{const d=await request('storage/manual?'+p);if(!active(n))return;cutoff=d.cutoff;cursor=d.next_cursor;enabled=d.enabled===true;
   for(const row of d.items){const c=el('article','','member-case'),label=el('label',row.case_id),box=el('input');box.type='checkbox';box.disabled=!row.eligible;box.dataset.eligible=String(row.eligible);box.setAttribute('aria-label','選取圖片 '+row.file_id);label.prepend(box);box.addEventListener('change',()=>{if(all){if(box.checked)all.excluded.delete(row.file_id);else all.excluded.set(row.file_id,row);}else if(box.checked)selected.set(row.file_id,row);else selected.delete(row.file_id);sync();});checkboxes.set(row.file_id,box);c.append(label,el('p',row.status+' · '+row.size+' bytes'));if(loadProof&&!['cold','deleting'].includes(row.cleanup_state))c.append(button('預覽圖片',()=>void showProof(row)));c.append(el('p',row.reason));list.append(c);}
   more.hidden=!cursor;status.textContent=!enabled?'手動清理尚未啟用，目前只提供唯讀候選清單。':d.total===0?'沒有符合篩選的圖片。':'候選清單為唯讀；實際清理前重新檢查全部安全條件。';sync();
  }catch(e){if(active(n))status.textContent=e.code??e.message??'無法載入。';}
 }
 async function select(first20){
  if(working)return;working=true;const n=epoch;
  try{const p=params();p.set('eligible','yes');const d=await request('storage/manual?'+p);if(!active(n))return;selected.clear();
   if(first20){all=null;for(const r of d.items)selected.set(r.file_id,r);}else all={total:d.eligible_count,bytes:d.eligible_bytes,query:p,excluded:new Map()};
  }catch(e){status.textContent=e.code??e.message;}finally{working=false;sync();}
 }
 async function clean(){
  if(working||!enabled||(!all&&!selected.size))return;closePreview();const plan=all?{...all,query:new URLSearchParams(all.query),excluded:new Map(all.excluded)}:null,items=[...selected.values()],total=plan?plan.total-plan.excluded.size:items.length;if(!total)return;
  if(!confirm('確認清理已選 '+total+' 張R2原始圖片？\n案件、積分及Drive備份保留；圖片不再提供線上讀取或匯出。遇到未知ACK立即停止，不重送DELETE。'))return;
  await run(async()=>{working=true;stopRequested=false;stop.hidden=false;let done=0,deleted=0,failed=0,unknown=0,next=null,queue=items,morePages=!!plan;
   try{while(isCurrent()&&!stopRequested&&(queue.length||morePages)){
    if(!queue.length){const p=new URLSearchParams(plan.query);if(next)p.set('cursor',next);const d=await request('storage/manual?'+p);queue=d.items;next=d.next_cursor;morePages=!!next;if(!queue.length)continue;}
    const row=queue.shift();if(plan?.excluded.has(row.file_id))continue;const input={file_id:row.file_id,case_version:row.case_version,backup_version:row.backup_version,attempt_id:crypto.randomUUID()};
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
 actions.append(button('選取全部可清理圖片',()=>void select(false)),button('選取前20張可清理圖片',()=>void select(true)),button('清除目前選取',()=>{if(!working){selected.clear();all=null;sync();}}),execute,stop);
 filters.addEventListener('submit',e=>{e.preventDefault();if(!working)void page(true);});container.append(filters,actions,count,status,progress,list,more);await page(true);
 return()=>{epoch++;closePreview();};
}
