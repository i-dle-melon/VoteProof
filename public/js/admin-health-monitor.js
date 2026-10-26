
const el=(t,s='',c='')=>{const x=document.createElement(t);x.textContent=String(s??'');if(c)x.className=c;return x;};
const btn=(s,fn)=>{const b=el('button',s,'btn btn-white');b.type='button';b.addEventListener('click',fn);return b;};
const when=v=>Number.isFinite(v)&&v>0?new Date(v*1000).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'未取得';
const fmt=v=>v===null||v===undefined?'資料不完整':String(v);
export async function renderHealthMonitor({container,request,signal}){
 const title=el('h2','系統健康監控'),tip=el('p','唯讀、按需查詢。不掃描 R2，也不重新驗證 Google Drive。','tiny'),
 cards=el('section','','grid grid-4'),storage=el('section','','card'),bar=el('div','','admin-filter'),events=el('section','','grid grid-2'),info=el('p','','notice');
 const type=el('select'),status=el('select'),auto=el('input');auto.type='checkbox';auto.setAttribute('aria-label','每 60 秒更新');
 for(const [v,n] of [['all','全部類型'],['backup','備份'],['capacity','容量'],['cleanup','清理'],['operation','未完成作業']])type.add(new Option(n,v));
 for(const [v,n] of [['all','全部狀態'],['pending','待處理'],['manual','人工確認'],['resolved','已處理']])status.add(new Option(n,v));
 const autoLabel=el('label','每 60 秒更新');autoLabel.prepend(auto);
 const from=el('input'),to=el('input');from.type=to.type='date';from.setAttribute('aria-label','開始日期（台灣時間）');
 to.setAttribute('aria-label','結束日期（台灣時間）');
 const refresh=btn('立即更新',()=>void reload()),more=btn('載入更多',()=>void history(false));more.hidden=true;
 bar.append(type,status,from,to,btn('篩選',()=>void history(true)),refresh,autoLabel);container.append(title,tip,cards,storage,bar,info,events,more);
 let disposed=false,busy=false,cursor=null,epoch=0,timer=null;
 const ok=n=>!disposed&&!signal?.aborted&&epoch===n&&container.isConnected;
 const stat=(k,v,t)=>{const x=el('article','','activity-card');x.append(el('span',k,'tiny'),el('strong',fmt(v)),el('p',t,'tiny'));return x;};
 async function summary(){
  if(busy||disposed||document.hidden)return;busy=true;const n=epoch;
  try{const d=await request('health-monitor/summary');if(!ok(n))return;
   cards.replaceChildren(stat('上傳失敗',d.upload_failures?.count,'尚無完整失敗紀錄'),stat('備份異常',d.backup_failures?.count,'目前失敗備份'),stat('清理失敗',d.cleanup_failures?.count,'最近 24 小時告警'),stat('待處理作業',d.pending_operations?.count,'含未知 ACK、Write Pin'));
   const s=d.storage??{},mb=v=>v===null||v===undefined?'未知':(v/1e6).toFixed(1)+' MB';
   storage.replaceChildren(el('h3','R2 容量狀態'),el('p','使用量：'+mb(s.used_bytes)+'／'+mb(s.budget_bytes)),el('p','最近盤點：'+when(s.observed_at)),el('p','可信期限：'+when(s.trusted_until)),el('p','清理：'+(s.cleanup_mode==='live'?'啟用':'關閉')),el('p','警戒：'+(s.blocked?'停止寫入或快照失效':'正常')),el('p','異常：'+(s.anomaly??'無已記錄異常')),el('p','歷史 DELETE／ACK：'+(d.pending_operations?.legacy_ack_unverified?'尚未驗證（不能視為 0）':'已留存狀態')));
   if(s.trusted_until&&s.trusted_until<Date.now()/1000)storage.append(el('p','快照已過期，不代表即時容量。','notice warn'));
   info.textContent='更新時間：'+new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
  }catch(e){if(ok(n))info.textContent=e.message??'監控摘要載入失敗。';}finally{busy=false;}
 }
 async function history(reset=true){
  if(busy||disposed||document.hidden)return;busy=true;
  if(reset){epoch++;cursor=null;events.replaceChildren();}
  const n=epoch;
  try{const q=new URLSearchParams({type:type.value,status:status.value});if(from.value)q.set('from',from.value);if(to.value)q.set('to',to.value);if(cursor)q.set('cursor',cursor);
   const d=await request('health-monitor/events?'+q);if(!ok(n))return;
   for(const item of d.events??[]){const c=el('article','','member-case');c.append(el('h3',item.type),el('p','時間：'+when(item.created_at)),el('p','類型：'+item.code),el('p','狀態：'+({pending:'待處理',manual:'人工確認',resolved:'已處理'}[item.status]??item.status)));events.append(c);}
   if(!events.children.length)events.append(el('p','無符合條件的已記錄異常；不表示全部操作均有日誌。'));
   cursor=d.next_cursor;more.hidden=!cursor;
  }catch(e){if(ok(n))info.textContent=e.message??'異常紀錄載入失敗。';}
  finally{busy=false;}
 }
 async function reload(){await summary();await history(true);}
 const stop=()=>{if(timer!==null)clearInterval(timer);timer=null;};
 auto.addEventListener('change',()=>{stop();if(auto.checked)timer=setInterval(()=>{if(!document.hidden&&!disposed)void reload();},60000);});
 type.addEventListener('change',()=>void history(true));status.addEventListener('change',()=>void history(true));
 await reload();return()=>{disposed=true;epoch++;stop();};
}
