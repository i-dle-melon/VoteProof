
import {memberContactUI} from './admin-member-contact.js';
// Keep unresolved actions across tab/view navigation, without storing identities in browser storage.
const unresolvedActions=new Map();
const el=(t,s='',c='')=>{const x=document.createElement(t);x.textContent=String(s??'');if(c)x.className=c;return x;};
const btn=(s,fn)=>{const b=el('button',s,'btn btn-white');b.type='button';b.addEventListener('click',fn);return b;};
const date=s=>s?new Date(s).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'—';
const line=(k,v)=>el('p',k+'：'+String(v??'—'));
const counts=c=>'投稿 '+(c?.total??0)+'／待審核 '+(c?.pending??0)+'／通過 '+(c?.approved??0)+'／拒絕 '+(c?.rejected??0);
export async function renderMemberOverview({container,request,signal}){
 const heading=el('h2','會員管理'),tip=el('p','每頁 20 位。僅點開會員才查詢詳細資料；Email 須另外授權查詢。','tiny');
 const form=el('form','','admin-filter'),mode=el('select'),search=el('input'),status=el('select'),submit=el('button','搜尋','btn btn-primary');
 submit.type='submit';search.placeholder='輸入粉絲 ID／暱稱';search.autocomplete='off';search.maxLength=100;search.setAttribute('aria-label','會員搜尋');
 for(const [v,n] of [['fan_id','粉絲 ID（精確）'],['nickname','暱稱（開頭）']])mode.add(new Option(n,v));
 for(const [v,n] of [['all','全部狀態'],['active','正常'],['suspended','已封鎖']])status.add(new Option(n,v));
 mode.setAttribute('aria-label','會員搜尋方式');status.setAttribute('aria-label','會員狀態');
 form.append(mode,search,status,submit);const msg=el('p','','notice'),list=el('section','','grid grid-2'),detail=el('section'),more=btn('下一頁',()=>void fetchList(false)),previous=btn('上一頁',()=>void fetchList(false,true)),pageLabel=el('span','第 1 頁');
 container.append(heading,tip,form,msg,list,previous,pageLabel,more,detail);
 let disposed=false,loading=false,next=null,epoch=0,historyEpoch=0,contact=null,actionBusy=false,filters=null,page=0,cursors=[null];more.hidden=previous.hidden=true;
 const current=n=>!disposed&&!signal?.aborted&&epoch===n&&container.isConnected;
 const query=(index,reset)=>{const q=reset?new URLSearchParams({status:status.value}):new URLSearchParams(filters);if(reset&&search.value.trim())q.set(mode.value,search.value.trim());if(!reset&&cursors[index])q.set('cursor',cursors[index]);return q;};
 async function fetchList(reset=true,back=false,stay=false){
   if(loading||disposed||signal?.aborted||actionBusy)return;
   epoch++;historyEpoch++;const index=reset?0:stay?page:back?page-1:page+1;
   if(index<0)return;const q=query(index,reset);
   const n=epoch;loading=true;more.disabled=true;msg.textContent='讀取會員列表…';
   try{const d=await request('members-overview?'+q);if(!current(n))return;
     if(!Array.isArray(d?.members)||d.page_size!==20)throw Error('會員管理版本不相容，請重新整理或聯絡管理員。');
     if(reset){cursors=[null];filters=new URLSearchParams(q);}page=index;
     contact?.cleanup();contact=null;list.replaceChildren();detail.replaceChildren();form.hidden=false;list.hidden=false;pageLabel.hidden=false;
     msg.textContent=d.search_mode==='nickname_prefix_case_sensitive'?'暱稱搜尋採區分大小寫的開頭比對。':d.members.length?'點選詳細資料查看會員。':'無符合會員。';
     for(const m of d.members){const c=el('article','','member-case');c.append(el('h3',m.nickname),line('粉絲 ID',m.fan_id),line('會員 ID',m.member_id),line('註冊時間',date(m.created_at)),line('狀態',m.status==='suspended'?'已封鎖':'正常'),line('等級',m.tier?.name),line('積分',m.total_points),el('p',counts(m.proof_counts),'tiny'),btn('詳細資料',()=>void open(m.member_id)));list.append(c);}
     next=d.next_cursor;cursors[page+1]=next;more.hidden=!next;previous.hidden=page===0;pageLabel.textContent='第 '+(page+1)+' 頁';
   }catch(e){if(current(n))msg.textContent=e.status===404?'目前 Worker 尚未提供會員管理 API；請確認發布版本後重新整理。':e.message??'會員查詢失敗。';}
   finally{loading=false;more.disabled=false;}
 }
 form.addEventListener('submit',e=>{e.preventDefault();void fetchList(true);});
 async function open(id){
   if(disposed||signal?.aborted||actionBusy)return;epoch++;historyEpoch++;const n=epoch;contact?.cleanup();contact=null;form.hidden=true;list.hidden=true;more.hidden=previous.hidden=pageLabel.hidden=true;detail.replaceChildren();msg.textContent='讀取會員詳細資料…';
   detail.append(btn('返回會員列表',()=>{void fetchList(false,false,true);}));
   try{const {member:m}=await request('members-overview/'+encodeURIComponent(id));if(!current(n))return;
     if(!m||m.member_id!==id)throw Error('會員詳細資料版本不相容，請重新整理。');
     const c=el('article','','member-case');
     c.append(el('h3',m.nickname),line('會員 ID',m.member_id),line('粉絲 ID',m.fan_id),line('狀態',m.status==='suspended'?'已封鎖':'正常'),line('註冊',date(m.created_at)),line('等級',m.tier?.name),line('積分',m.total_points),line('投稿統計',counts(m.proof_counts)),line('登入方式',m.login_methods?.join('、')||'未設定'));
     if(m.status==='suspended')c.append(line('封鎖原因',m.blocked_reason),line('封鎖時間',date(m.blocked_at)));
     const actions=el('div','','admin-filter'),history=el('section'),writeButtons=[];
     let pending=unresolvedActions.get(id);
     const protect=button=>{writeButtons.push(button);button.disabled=!!pending;return button;};
     async function mutate(kind,options){
       if(actionBusy||pending||!current(n))return;
       const marker=JSON.stringify({kind,request_id:options.headers?.['Idempotency-Key']??crypto.randomUUID()});
       unresolvedActions.set(id,marker);
       pending=marker;actionBusy=true;writeButtons.forEach(b=>b.disabled=true);
       try{await request(kind,options);unresolvedActions.delete(id);pending=null;actionBusy=false;if(current(n))await open(id);}
       catch{if(current(n))msg.textContent='操作結果尚待確認；未自動重送。請查閱會員狀態、積分紀錄與稽核後再由管理員處理。此分頁保留重送保護。';}
       finally{actionBusy=false;}
     }
     actions.append(btn('投稿紀錄',()=>void historyPage('cases',m.member_id,history)),btn('積分紀錄',()=>void historyPage('transactions',m.member_id,history)));
     if(m.fan_id){
       const mail=btn('查看 Email／聯絡',()=>contact?.open());contact=memberContactUI({request,opener:mail,initialFanId:m.fan_id});actions.append(mail);
       actions.append(protect(btn(m.status==='suspended'?'恢復會員':'封鎖會員',async()=>{
         if(actionBusy||pending||!current(n))return;
         const action=m.status==='suspended'?'restore':'block',reason=prompt('操作原因（1～500 字）');if(reason===null)return;
         if(!reason.trim()||reason.trim().length>500){msg.textContent='請輸入有效的原因。';return;}
         if(!confirm('確定'+(action==='block'?'封鎖':'恢復')+'粉絲 ID '+m.fan_id+'？'))return;
         await mutate('member-blocks',{method:'POST',body:{fan_id:m.fan_id,confirmed_fan_id:m.fan_id,action,reason:reason.trim()}});
       })));
     }
     actions.append(protect(btn('調整積分',async()=>{
       if(actionBusy||pending||!current(n))return;
       const raw=prompt('正負整數積分（單次上限 1000000）');if(raw===null)return;
       if(!/^-?\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||!Number(raw)||Math.abs(Number(raw))>1000000){msg.textContent='積分格式無效。';return;}
       const reason=prompt('調整原因（1～500 字）');if(reason===null)return;
       if(!reason.trim()||reason.trim().length>500){msg.textContent='原因格式無效。';return;}
       if(!confirm('確認調整 '+raw+' 分？'))return;
       await mutate('points/adjustments',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:{member_id:id,points:Number(raw),reason:reason.trim()}});
     })));
     c.append(actions,history);detail.append(c);msg.textContent=pending?'此會員有尚待確認的操作，請先查閱狀態、積分及稽核；此分頁禁止重送。':'詳細資料已載入。';
   }catch(e){if(current(n))msg.textContent=e.message??'詳細資料無法載入。';}
 }
 async function historyPage(kind,id,host){
   const born=epoch,historyId=++historyEpoch,n=epoch;const active=()=>current(born)&&historyId===historyEpoch;host.replaceChildren(el('h3',kind==='cases'?'投稿紀錄':'積分異動'));
   let cursor=null,busy=false;const out=el('section','','grid grid-2'),more=btn('載入更多',()=>void page());
   host.append(out,more);
   async function page(){
     if(busy||!active())return;busy=true;more.disabled=true;
     try{const d=await request('members-overview/'+encodeURIComponent(id)+'/'+kind+(cursor?'?cursor='+encodeURIComponent(cursor):''));
       if(!active())return;
       for(const r of d[kind]??[]){const c=el('article','','member-case');c.append(line('時間',date(r.created_at)),kind==='cases'?line('案件',r.case_id):line('種類',r.category),kind==='cases'?line('狀態',r.status):line('原因',r.reason),line('積分',kind==='cases'?r.points_awarded:r.points));out.append(c);}
       if(!out.children.length)out.append(el('p','沒有紀錄。'));
       cursor=d.next_cursor;more.hidden=!cursor;
     }catch(e){if(active())host.append(el('p',e.message??'歷史查詢失敗。','notice warn'));}
     finally{busy=false;more.disabled=false;}
   }
   await page();
 }
 const cleanup=()=>{disposed=true;epoch++;historyEpoch++;contact?.cleanup();signal?.removeEventListener('abort',cleanup);};
 signal?.addEventListener('abort',cleanup,{once:true});await fetchList();return cleanup;
}
