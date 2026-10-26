
import {memberContactUI} from './admin-member-contact.js';
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
 form.append(mode,search,status,submit);const msg=el('p','','notice'),list=el('section','','grid grid-2'),detail=el('section'),more=btn('載入下一頁',()=>void fetchList(false));
 container.append(heading,tip,form,msg,list,more,detail);
 let disposed=false,loading=false,next=null,epoch=0,contact=null;more.hidden=true;
 const current=n=>!disposed&&!signal?.aborted&&epoch===n&&container.isConnected;
 const query=()=>{const q=new URLSearchParams({status:status.value});if(search.value.trim())q.set(mode.value,search.value.trim());if(next)q.set('cursor',next);return q;};
 async function fetchList(reset=true){
   if(loading||disposed)return;
   if(reset){epoch++;next=null;list.replaceChildren();detail.replaceChildren();form.hidden=false;list.hidden=false;contact?.cleanup();contact=null;}
   const n=epoch;loading=true;more.disabled=true;msg.textContent='讀取會員列表…';
   try{const d=await request('members-overview?'+query());if(!current(n))return;
     msg.textContent=d.search_mode==='nickname_prefix_case_sensitive'?'暱稱搜尋採區分大小寫的開頭比對。':d.members.length?'點選詳細資料查看會員。':'無符合會員。';
     for(const m of d.members){const c=el('article','','member-case');c.append(el('h3',m.nickname),line('粉絲 ID',m.fan_id),line('會員 ID',m.member_id),line('狀態',m.status==='suspended'?'已封鎖':'正常'),line('等級',m.tier?.name),line('積分',m.total_points),el('p',counts(m.proof_counts),'tiny'),btn('詳細資料',()=>void open(m.member_id)));list.append(c);}
     next=d.next_cursor;more.hidden=!next;
   }catch(e){if(current(n))msg.textContent=e.message??'會員查詢失敗。';}
   finally{loading=false;more.disabled=false;}
 }
 form.addEventListener('submit',e=>{e.preventDefault();void fetchList(true);});
 async function open(id){
   epoch++;const n=epoch;contact?.cleanup();contact=null;form.hidden=true;list.hidden=true;more.hidden=true;detail.replaceChildren();msg.textContent='讀取會員詳細資料…';
   detail.append(btn('返回會員列表',()=>{void fetchList(true);}));
   try{const {member:m}=await request('members-overview/'+encodeURIComponent(id));if(!current(n))return;
     const c=el('article','','member-case');
     c.append(el('h3',m.nickname),line('會員 ID',m.member_id),line('粉絲 ID',m.fan_id),line('狀態',m.status==='suspended'?'已封鎖':'正常'),line('註冊',date(m.created_at)),line('等級',m.tier?.name),line('積分',m.total_points),line('投稿統計',counts(m.proof_counts)),line('登入方式',m.login_methods?.join('、')||'未設定'));
     if(m.status==='suspended')c.append(line('封鎖原因',m.blocked_reason),line('封鎖時間',date(m.blocked_at)));
     const actions=el('div','','admin-filter'),history=el('section');
     actions.append(btn('投稿紀錄',()=>void historyPage('cases',m.member_id,history)),btn('積分紀錄',()=>void historyPage('transactions',m.member_id,history)));
     if(m.fan_id){
       const mail=btn('查看 Email／聯絡',()=>contact?.open());contact=memberContactUI({request,opener:mail,initialFanId:m.fan_id});actions.append(mail);
       actions.append(btn(m.status==='suspended'?'恢復會員':'封鎖會員',async()=>{
         const action=m.status==='suspended'?'restore':'block',reason=prompt('操作原因（1～500 字）');if(reason===null)return;
         if(!reason.trim()||reason.trim().length>500){msg.textContent='請輸入有效的原因。';return;}
         if(!confirm('確定'+(action==='block'?'封鎖':'恢復')+'粉絲 ID '+m.fan_id+'？'))return;
         try{await request('member-blocks',{method:'POST',body:{fan_id:m.fan_id,confirmed_fan_id:m.fan_id,action,reason:reason.trim()}});await open(id);}
         catch(e){msg.textContent=e.message??'操作未完成，請重新查詢。';}
       }));
     }
     actions.append(btn('調整積分',async()=>{
       const raw=prompt('正負整數積分（單次上限 1000000）');if(raw===null)return;
       if(!/^-?\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||!Number(raw)||Math.abs(Number(raw))>1000000){msg.textContent='積分格式無效。';return;}
       const reason=prompt('調整原因（1～500 字）');if(reason===null)return;
       if(!reason.trim()||reason.trim().length>500){msg.textContent='原因格式無效。';return;}
       if(!confirm('確認調整 '+raw+' 分？'))return;
       try{await request('points/adjustments',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:{member_id:id,points:Number(raw),reason:reason.trim()}});await open(id);}
       catch(e){msg.textContent=e.message??'結果不明，請查詢積分異動再決定是否重試。';}
     }));
     c.append(actions,history);detail.append(c);msg.textContent='詳細資料已載入。';
   }catch(e){if(current(n))msg.textContent=e.message??'詳細資料無法載入。';}
 }
 async function historyPage(kind,id,host){
   epoch++;const n=epoch;host.replaceChildren(el('h3',kind==='cases'?'投稿紀錄':'積分異動'));
   let cursor=null,busy=false;const out=el('section','','grid grid-2'),more=btn('載入更多',()=>void page());
   host.append(out,more);
   async function page(){
     if(busy||disposed)return;busy=true;more.disabled=true;
     try{const d=await request('members-overview/'+encodeURIComponent(id)+'/'+kind+(cursor?'?cursor='+encodeURIComponent(cursor):''));
       if(!current(n))return;
       for(const r of d[kind]??[]){const c=el('article','','member-case');c.append(line('時間',date(r.created_at)),kind==='cases'?line('案件',r.case_id):line('種類',r.category),kind==='cases'?line('狀態',r.status):line('原因',r.reason),line('積分',kind==='cases'?r.points_awarded:r.points));out.append(c);}
       if(!out.children.length)out.append(el('p','沒有紀錄。'));
       cursor=d.next_cursor;more.hidden=!cursor;
     }catch(e){if(current(n))host.append(el('p',e.message??'歷史查詢失敗。','notice warn'));}
     finally{busy=false;more.disabled=false;}
   }
   await page();
 }
 await fetchList();return()=>{disposed=true;epoch++;contact?.cleanup();};
}
