const el=(t,s='',c='')=>{const x=document.createElement(t);x.textContent=String(s??'');if(c)x.className=c;return x;};
const btn=(s,fn)=>{const b=el('button',s,'btn btn-white');b.type='button';b.addEventListener('click',fn);return b;};
const when=v=>Number.isFinite(v)&&v>0?new Date(v*1000).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'未取得';
const fmt=v=>v===null||v===undefined?'UNKNOWN（資料不完整）':String(v);
export async function renderHealthMonitor({container,request,signal}){
 const cards=el('section','','grid grid-4'),storage=el('section','','card'),bar=el('div','','admin-filter'),events=el('section','','grid grid-2'),info=el('p','','notice'),coverage=el('p','','notice warn');
 container.append(el('h2','系統健康監控'),el('p','Legacy 0028 唯讀監控。每來源最多 1000 筆固定窗口；不掃描 R2、不驗證 Drive。','tiny'),cards,storage,bar,info,coverage,events);
 const type=el('select'),status=el('select'),auto=el('input');auto.type='checkbox';auto.setAttribute('aria-label','每 60 秒更新');
 for(const[v,n]of[['all','全部類型'],['backup','備份'],['capacity','容量'],['cleanup','清理'],['operation','未完成作業（UNSUPPORTED）']])type.add(new Option(n,v));
 for(const[v,n]of[['all','全部狀態'],['pending','待處理'],['manual','人工確認'],['resolved','已處理']])status.add(new Option(n,v));
 type.setAttribute('aria-label','異常類型');status.setAttribute('aria-label','處理狀態');
 const from=el('input'),to=el('input');from.type=to.type='date';from.setAttribute('aria-label','開始日期（台灣時間）');to.setAttribute('aria-label','結束日期（台灣時間）');
 const autoLabel=el('label','每 60 秒更新');autoLabel.prepend(auto);
 const refresh=btn('立即更新',()=>void reload()),more=btn('載入更多',()=>void execute(()=>history(false)));more.hidden=true;
 bar.append(type,status,from,to,btn('篩選',()=>void execute(()=>history(true))),refresh,autoLabel);container.append(more);
 let disposed=false,busy=false,cursor=null,epoch=0,timer=null,filters=null,pending=null,compatible=true;
 const ok=n=>!disposed&&!signal?.aborted&&!document.hidden&&epoch===n&&container.isConnected;
 const stat=(name,v,tip)=>{const c=el('article','','activity-card');c.append(el('span',name,'tiny'),el('strong',fmt(v)),el('p',tip,'tiny'));return c;};
 const stop=()=>{if(timer!==null)clearTimeout(timer);timer=null;};
 const schedule=()=>{stop();if(auto.checked&&compatible&&!busy&&!disposed&&!signal?.aborted&&!document.hidden)timer=setTimeout(()=>void reload(),60000);};
 function versionError(){compatible=false;auto.checked=false;auto.disabled=true;stop();throw Error('監控 API 版本不相容或尚未發布；已停止自動更新，請確認 Worker／前端版本後重新整理。');}
 async function read(path){const d=await request(path,{signal:pending?.signal});if(d?.schema_compatibility!=='p1_legacy_0028_v1')versionError();return d;}
 function failure(e,n){if(!ok(n))return;if(e.status===404||e.code==='NOT_FOUND'){try{versionError();}catch(x){info.textContent=x.message;}}else info.textContent=e.message??'監控查詢失敗。';}
 async function summary(){const n=epoch;try{
  const d=await read('health-monitor/summary');if(!ok(n))return;
  cards.replaceChildren(stat('上傳失敗',d.upload_failures?.count,'PARTIAL COVERAGE：尚無完整歷史'),stat('備份異常',d.backup_failures?.count,d.backup_failures?.coverage??'UNKNOWN'),stat('清理失敗',d.cleanup_failures?.count,d.cleanup_failures?.coverage??'UNKNOWN'),stat('待確認總數',d.pending_operations?.count,'PARTIAL COVERAGE：不可加總成完整工作數'));
  const s=d.storage??{},mb=v=>v===null||v===undefined?'未知':(v/1e6).toFixed(1)+' MB',known=d.pending_operations?.known_signals??{};
  storage.replaceChildren(el('h3','R2 容量與已觀察訊號'),el('p','使用量：'+mb(s.used_bytes)+'／'+mb(s.budget_bytes)),el('p','最近盤點：'+when(s.observed_at)),el('p','可信期限：'+when(s.trusted_until)),el('p','清理：'+(s.cleanup_mode==='live'?'啟用':'關閉（不是故障）')),el('p','警戒：'+(s.blocked?'停止寫入或快照失效':'正常')),el('p','異常：'+(s.anomaly??'無已記錄異常')),el('p','Reservation：'+fmt(known.reservations?.count)+'；窗口內觀察 '+fmt(known.reservations?.observed_count)),el('p','Write Pin：'+fmt(known.write_pins?.count)+'；窗口內觀察 '+fmt(known.write_pins?.observed_count)),el('p','完整作業／Archive Dispatch：UNSUPPORTED'),el('p','舊 DELETE／ACK：UNKNOWN，0028 沒有完整終態追蹤。'));
  if(!s.trusted_until||s.trusted_until<=Date.now()/1000)storage.append(el('p','快照已過期，不代表即時容量。','notice warn'));
  info.textContent='更新時間：'+when(d.checked_at);
 }catch(e){failure(e,n);}}
 async function history(reset=true){if(reset)epoch++;const n=epoch;try{
  const applied=reset?new URLSearchParams({type:type.value,status:status.value}):new URLSearchParams(filters);
  if(reset){if(from.value)applied.set('from',from.value);if(to.value)applied.set('to',to.value);}
  const q=new URLSearchParams(applied);if(!reset&&cursor)q.set('cursor',cursor);
  const d=await read('health-monitor/events?'+q);if(!ok(n))return;
  if(!Array.isArray(d.events))versionError();
  if(reset){events.replaceChildren();filters=applied;}
  for(const item of d.events){const c=el('article','','member-case');c.append(el('h3',item.type),el('p','時間：'+when(item.created_at)),el('p','類型：'+item.code),el('p','狀態：'+({pending:'待處理',manual:'人工確認',resolved:'已處理'}[item.status]??item.status)));events.append(c);}
  if(!events.children.length)events.append(el('p',d.coverage==='unsupported'?'UNSUPPORTED：無完整作業來源，不代表 0 件。':'窗口內無符合條件的已記錄異常；窗口以外及未記錄歷史仍為 UNKNOWN。'));
  coverage.textContent=(d.coverage==='partial_window'?'PARTIAL WINDOW：已截斷，每來源最多 1000 筆。':'PARTIAL COVERAGE：僅已記錄來源。')+' '+(d.message??'舊 DELETE／ACK 為 UNKNOWN。');
  cursor=d.next_cursor;more.hidden=!cursor;
 }catch(e){failure(e,n);}}
 async function execute(action){if(busy||disposed||signal?.aborted||document.hidden||!compatible)return;busy=true;stop();pending=new AbortController();refresh.disabled=more.disabled=true;
  try{await action();}finally{busy=false;pending=null;if(!disposed){refresh.disabled=more.disabled=false;schedule();}}
 }
 async function reload(){return execute(async()=>{await summary();if(compatible&&!disposed&&!signal?.aborted&&!document.hidden)await history(true);});}
 const visibility=()=>{if(document.hidden){epoch++;stop();pending?.abort();}else schedule();};
 const cleanup=()=>{disposed=true;epoch++;stop();pending?.abort();document.removeEventListener('visibilitychange',visibility);signal?.removeEventListener('abort',cleanup);};
 signal?.addEventListener('abort',cleanup,{once:true});document.addEventListener('visibilitychange',visibility);auto.addEventListener('change',schedule);
 type.addEventListener('change',()=>void execute(()=>history(true)));status.addEventListener('change',()=>void execute(()=>history(true)));
 await reload();return cleanup;
}
