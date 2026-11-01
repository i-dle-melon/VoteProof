const el=(t,s='',c='')=>{const n=document.createElement(t);n.textContent=String(s??'');if(c)n.className=c;return n;};
const btn=(s,fn)=>{const n=el('button',s,'btn btn-white');n.type='button';n.addEventListener('click',fn);return n;};
const when=v=>Number.isFinite(v)&&v>0?new Date(v*1000).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'未取得';
const fmt=v=>v===null||v===undefined?'UNKNOWN（資料不完整）':String(v);
export async function renderHealthMonitor({container,request,signal}){
 const cards=el('section','','grid grid-4'),info=el('p','','notice'),details=el('details'),technical=el('section','','card'),historyDetails=el('details'),bar=el('div','','admin-filter'),events=el('section','','grid grid-2'),coverage=el('p','','notice warn');
 details.append(el('summary','技術資訊（按需載入）'),technical);historyDetails.append(el('summary','詳細歷史（按需載入）'),bar,coverage,events);
 const type=el('select'),status=el('select'),from=el('input'),to=el('input');from.type=to.type='date';from.setAttribute('aria-label','開始日期（台灣時間）');to.setAttribute('aria-label','結束日期（台灣時間）');
 for(const[v,n]of[['all','全部類型'],['backup','備份'],['capacity','容量'],['cleanup','清理'],['operation','未完成作業（UNSUPPORTED）']])type.add(new Option(n,v));
 for(const[v,n]of[['all','全部狀態'],['pending','待處理'],['manual','人工確認'],['resolved','已處理']])status.add(new Option(n,v));type.setAttribute('aria-label','異常類型');status.setAttribute('aria-label','處理狀態');
 const refresh=btn('立即更新',()=>void reload()),more=btn('載入更多',()=>void execute(()=>history(false)));more.hidden=true;
 bar.append(type,status,from,to,btn('篩選',()=>void execute(()=>history(true))));historyDetails.append(more);
 container.append(el('h2','系統健康監控'),el('p','手動更新；未知不是正常。技術資訊與歷史預設收合，沒有背景自動刷新。','tiny'),refresh,info,cards,details,historyDetails);
 let disposed=false,busy=false,epoch=0,pending=null,compatible=true,technicalLoaded=false,historyLoaded=false,cursor=null,filters=null;
 const alive=n=>!disposed&&!signal?.aborted&&!document.hidden&&epoch===n&&container.isConnected;
 const states={normal:'正常',abnormal:'異常',unknown:'未知'};
 for(const name of['網站API狀態','圖片上傳狀態','R2容量與快照','Google Drive備份']){const c=el('article','','activity-card'),s=el('strong','未知');s.dataset.healthState='unknown';c.append(el('span',name,'tiny'),s,el('p','尚未取得可信證據。','tiny'));cards.append(c);}
 const invalidate=()=>{for(const c of cards.querySelectorAll('[data-health-state]')){c.textContent='未知';c.dataset.healthState='unknown';}};
 function versionError(){compatible=false;throw Error('監控 API 版本不相容或尚未發布；請確認 Worker／前端版本後重新整理。');}
 async function read(path){const d=await request(path,{signal:pending?.signal});if(d?.schema_compatibility!=='p1_legacy_0028_v1')versionError();return d;}
 function failure(e,n){if(!alive(n))return;invalidate();if(e.status===404||e.code==='NOT_FOUND'){try{versionError();}catch(x){info.textContent=x.message;}}else info.textContent=e.message??'監控查詢失敗，狀態未知。';}
 async function summary(){const n=epoch;try{const d=await read('health-monitor/summary?view=overview');if(!alive(n))return;if(d.view!=='overview'||!d.checks)versionError();
  cards.replaceChildren();for(const[key,name]of[['api','網站API狀態'],['upload','圖片上傳狀態'],['storage','R2容量與快照'],['backup','Google Drive備份']]){const v=d.checks[key],c=el('article','','activity-card'),s=el('strong',states[v?.state]??states.unknown);s.dataset.healthState=Object.hasOwn(states,v?.state)?v.state:'unknown';c.append(el('span',name,'tiny'),s,el('p',v?.message??'UNKNOWN：沒有可信證據。','tiny'));cards.append(c);}
  info.textContent='更新時間：'+when(d.checked_at)+(d.checked_at===null?' · UI PREVIEW：沒有正式監控資料；UNKNOWN。':'');
 }catch(e){failure(e,n);}}
 async function detail(){const n=epoch;try{const d=await read('health-monitor/summary');if(!alive(n))return;const s=d.storage??{},signals=d.pending_operations?.known_signals??{},mb=x=>x===null||x===undefined?'未知':(x/1e6).toFixed(1)+' MB';
  technical.replaceChildren(el('h3','R2 容量與已觀察訊號'),el('p','使用量：'+mb(s.used_bytes)+'／'+mb(s.budget_bytes)),el('p','最近盤點：'+when(s.observed_at)),el('p','可信期限：'+when(s.trusted_until)),el('p','清理：'+(s.cleanup_mode==='live'?'啟用':'關閉（不是故障）')),el('p','Reservation：'+fmt(signals.reservations?.count)),el('p','Write Pin：'+fmt(signals.write_pins?.count)),el('p','備份異常：'+fmt(d.backup_failures?.count)),el('p','完整作業／Archive Dispatch：UNSUPPORTED'),el('p','上傳歷史PARTIAL COVERAGE；舊 DELETE／ACK：UNKNOWN。'));
  if(!s.trusted_until||s.trusted_until<=Date.now()/1000)technical.append(el('p','快照已過期，不代表即時容量。','notice warn'));technicalLoaded=true;
 }catch(e){failure(e,n);}}
 async function history(reset=true){const n=epoch;try{const applied=reset?new URLSearchParams({type:type.value,status:status.value}):new URLSearchParams(filters);if(reset){if(from.value)applied.set('from',from.value);if(to.value)applied.set('to',to.value);}const q=new URLSearchParams(applied);if(!reset&&cursor)q.set('cursor',cursor);
  const d=await read('health-monitor/events?'+q);if(!alive(n))return;if(!Array.isArray(d.events))versionError();if(reset){events.replaceChildren();filters=applied;}for(const item of d.events){const c=el('article','','member-case');c.append(el('h3',item.type),el('p','時間：'+when(item.created_at)),el('p','類型：'+item.code),el('p','狀態：'+({pending:'待處理',manual:'人工確認',resolved:'已處理'}[item.status]??item.status)));events.append(c);}
  if(!events.children.length)events.append(el('p',d.coverage==='unsupported'?'UNSUPPORTED：無完整作業來源，不代表 0 件。':'窗口內無符合條件的已記錄異常；窗口以外仍為 UNKNOWN。'));coverage.textContent=(d.coverage==='partial_window'?'PARTIAL WINDOW：已截斷。':'PARTIAL COVERAGE：僅已記錄來源。')+' '+(d.message??'舊DELETE／ACK UNKNOWN。');cursor=d.next_cursor;more.hidden=!cursor;historyLoaded=true;
 }catch(e){failure(e,n);}}
 async function execute(fn){if(busy||disposed||signal?.aborted||document.hidden||!compatible)return;busy=true;pending=new AbortController();refresh.disabled=more.disabled=true;try{await fn();}finally{busy=false;pending=null;if(!disposed){refresh.disabled=more.disabled=!compatible;}}}
 async function reload(){return execute(async()=>{await summary();technicalLoaded=historyLoaded=false;if(compatible&&details.open&&alive(epoch))await detail();if(compatible&&historyDetails.open&&alive(epoch))await history(true);});}
 details.addEventListener('toggle',()=>{if(details.open&&!technicalLoaded)void execute(detail);});historyDetails.addEventListener('toggle',()=>{if(historyDetails.open&&!historyLoaded)void execute(()=>history(true));});
 const visibility=()=>{if(document.hidden){epoch++;pending?.abort();invalidate();}};
 const cleanup=()=>{disposed=true;epoch++;pending?.abort();document.removeEventListener('visibilitychange',visibility);signal?.removeEventListener('abort',cleanup);};signal?.addEventListener('abort',cleanup,{once:true});document.addEventListener('visibilitychange',visibility);
 await reload();return cleanup;
}
