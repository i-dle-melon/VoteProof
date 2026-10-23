const make=(tag,text='',cls='')=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
const button=(text,fn)=>{const b=make('button',text,'btn btn-white');b.type='button';b.addEventListener('click',fn);return b;};
const labels={approve:'通過審核',reject:'不通過審核',mark_duplicate:'標記重複',complete:'完成案件',revoke:'撤銷案件',flag_detailed:'轉詳細審核',campaign_create:'建立活動',campaign_update:'更新活動',leaderboard_create:'建立排行榜',leaderboard_update:'更新排行榜',leaderboard_rebuild:'重建排行榜',leaderboard_archive:'封存排行榜',member_tier_update:'更新會員等級',manual_adjustment:'手動調整積分',bootstrap_membership:'授予管理權限',member_block:'封鎖會員',member_restore:'恢復會員',member_lookup:'會員查詢',member_mail_send:'寄信給會員',announcement_create:'建立公告',announcement_update:'更新公告',announcement_enable:'開放公告',announcement_disable:'關閉公告',submission_note_update:'更新投稿說明',example_image_upload:'上傳範例圖片',example_image_replace:'替換範例圖片',example_image_delete:'移除範例圖片'};
const stamp=v=>{const d=new Date(v);return Number.isFinite(d.valueOf())?d.toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'時間未記錄';};
const safe=v=>v==null?'未記錄':String(v).replace(/\bM-[0-9a-f-]{36}\b/gi,'[會員識別已隱藏]');
export const auditOperator=row=>row.actor_kind==='system'?'系統':row.operator_fan_id?.trim()||'管理員（未提供粉絲 ID）';
const action=row=>labels[row.action]??safe(row.action);
const targetLabel=row=>['member','admin_membership'].includes(row.target_type)?row.target??'會員（未提供粉絲 ID）':row.target??safe(row.target_id);
const allowedFields=new Set(['status','version','points_awarded','point_status','review_stage','review_risk_reason','status_reason','campaign_id','name','category','solo_target','start_at','end_at','campaign_timezone','vote_start_date','vote_end_date','points_per_proof','daily_limit','note','type','vote_type','start_date','end_date','top_n','is_public','is_current_comeback','min_points','tier_id','enabled','title','body','message','submission_instructions','outcome','reason','delta','points','source','role']);
for(const k of ['case_id','duplicate_of_case_id','transaction_id','leaderboard_id','run_id','row_count','source_count','generated_at','campaign_version','campaign_category','proof_count','example_asset_id','dismissible','button_label','button_enabled','starts_at','ends_at'])allowedFields.add(k);
function safePayload(value){if(!value||typeof value!=='object'||Array.isArray(value))return '原始紀錄未保存可顯示的資料。';const pairs=Object.entries(value).filter(([k,v])=>allowedFields.has(k)&&(v==null||['string','number','boolean'].includes(typeof v)));return pairs.length?JSON.stringify(Object.fromEntries(pairs),null,2):'原始紀錄未保存可顯示的資料。';}

export async function renderAdminAudit({container,request,signal,message}){
  let page=1,size=20,committedSize=20,cursors=[null],nextCursor=null,loading=false,dialog=null,details=new Map(),disposed=false;
  const title=make('div','','audit-titlebar'),reload=button('重新整理操作紀錄',()=>void load(1,true));
  title.append(make('h2','操作紀錄'),reload);
  const intro=make('p','查看已保存的管理操作。細項僅於點擊時讀取，不會自動刷新。','tiny');
  const toolbar=make('div','','audit-toolbar'),sizeLabel=make('label','每頁筆數 '),select=make('select');select.setAttribute('aria-label','每頁筆數');
  for(const n of [10,20,50])select.append(new Option(n+' 筆',String(n)));select.value='20';sizeLabel.append(select);
  const status=make('p','','tiny');status.setAttribute('role','status');
  const error=make('p','','notice warn');error.setAttribute('role','alert');error.hidden=true;
  const wrap=make('div','','audit-table-wrap'),table=make('table','','audit-table');table.setAttribute('aria-label','管理員操作紀錄');
  const head=make('thead'),headRow=make('tr'),columns=['時間（台灣）','操作人員','動作','目標','修改摘要','細項'];for(const text of columns){const th=make('th',text);th.scope='col';headRow.append(th);}head.append(headRow);const body=make('tbody');table.append(head,body);wrap.append(table);
  const pager=make('form','','audit-pagination'),previous=button('上一頁',()=>void load(page-1)),next=button('下一頁',()=>void load(page+1)),position=make('span'),pageLabel=make('label','已瀏覽頁碼 '),input=make('input');
  input.type='number';input.min='1';input.max='1';input.value='1';input.step='1';input.required=true;input.inputMode='numeric';input.setAttribute('aria-label','已瀏覽頁碼');pageLabel.append(input);
  const go=make('button','前往','btn btn-white');go.type='submit';pager.append(previous,position,pageLabel,go,next);
  const explanation=make('p','僅可跳至本次已瀏覽的頁碼；下一頁沿用游標，不掃描深頁或計算全站總筆數。','tiny');
  toolbar.append(sizeLabel,status);container.append(title,intro,toolbar,error,wrap,pager,explanation);
  const alive=()=>!disposed&&!signal.aborted&&container.isConnected;
  function sync(){previous.disabled=loading||page<=1;next.disabled=loading||!nextCursor||page>=200;select.disabled=reload.disabled=input.disabled=go.disabled=loading;position.textContent='第 '+page+' 頁';input.value=String(page);input.max=String(cursors.length);table.setAttribute('aria-busy',String(loading));}
  function close(){dialog?.close();dialog?.remove();dialog=null;}
  async function show(row,opener){
    if(!alive())return;close();
    const current=make('dialog','','case-dialog audit-detail-dialog');dialog=current;current.setAttribute('aria-label','操作紀錄細項');
    const bar=make('div','','audit-titlebar'),dismiss=button('關閉',()=>current.close());bar.append(make('h2','操作紀錄細項'),dismiss);
    const content=make('div'),notice=make('p','載入細項中…');notice.setAttribute('role','status');current.append(bar,notice,content);
    current.addEventListener('close',()=>{current.remove();if(dialog===current)dialog=null;if(opener.isConnected)opener.focus();});
    current.addEventListener('click',event=>{const r=current.getBoundingClientRect();if(event.target===current&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))current.close();});
    document.body.append(current);current.showModal();dismiss.focus();
    try{
      const key=row.source+':'+row.id;let pending=details.get(key);
      if(!pending){pending=request('audit-logs/'+encodeURIComponent(row.id)+'?source='+encodeURIComponent(row.source)).then(data=>{if(!data.log||data.log.id!==row.id||data.log.source!==row.source)throw {code:'SERVICE_UNAVAILABLE'};return data.log;});details.set(key,pending);pending.catch(()=>{if(details.get(key)===pending)details.delete(key);});}
      const record=await pending;
      if(!alive()||!current.open||dialog!==current)return;
      const dl=make('dl','','case-details');for(const [label,value]of [['操作時間（台灣）',stamp(record.created_at)],['操作人員粉絲 ID',auditOperator(record)],['動作類型',action(record)],['操作目標',targetLabel(record)],['修改摘要',row.reason??action(record)],['完整操作內容',record.reason??'原始紀錄未保存操作說明。'],['紀錄編號',record.id]])dl.append(make('dt',label),make('dd',safe(value)));
      content.append(dl);for(const [label,value]of [['修改前資料',record.before],['修改後資料',record.after]])content.append(make('h3',label),make('pre',safePayload(value),'audit-payload'));
      content.append(make('p',record.detail_policy??'僅顯示原始紀錄已保存且可安全展示的欄位。','tiny'));notice.textContent='';
    }catch(cause){if(alive()&&current.open)notice.textContent=message(cause);}
  }
  async function load(target,reset=false){
    if(loading||!alive()||!Number.isSafeInteger(target)||target<1||target>200)return;
    const cursor=reset?null:target===page+1?nextCursor:cursors[target-1];if(!reset&&target>cursors.length&&!cursor)return;
    loading=true;sync();status.textContent='載入中…';error.hidden=true;
    try{
      const params=new URLSearchParams({view:'summary',limit:String(size)});if(cursor)params.set('cursor',cursor);
      const data=await request('audit-logs?'+params);
      if(!alive())return;if(!Array.isArray(data.logs)||data.logs.length>size||!(data.next_cursor===null||typeof data.next_cursor==='string'))throw {code:'SERVICE_UNAVAILABLE'};
      if(reset)cursors=[null];cursors[target-1]=cursor;page=target;committedSize=size;nextCursor=data.next_cursor;details.clear();close();body.replaceChildren();
      for(const row of data.logs){const tr=make('tr');const read=button('查閱細項',()=>void show(row,read));read.disabled=!row.id||!row.source;
        for(const [index,value]of [stamp(row.created_at),auditOperator(row),action(row),targetLabel(row),row.reason??action(row),null].entries()){const td=make('td');td.dataset.label=columns[index];if(index===5)td.append(read);else td.textContent=safe(value);tr.append(td);}body.append(tr);}
      if(!data.logs.length){const tr=make('tr'),td=make('td','目前沒有操作紀錄。');td.colSpan=6;tr.append(td);body.append(tr);}
      status.textContent='本頁 '+data.logs.length+' 筆 · '+(nextCursor?'尚有下一頁':'已到目前最後一頁')+(page>=200?' · 已達本次瀏覽上限，請重新整理。':'');
    }catch(cause){if(alive()){size=committedSize;select.value=String(size);error.textContent=message(cause);error.hidden=false;status.textContent='載入失敗，保留最後成功結果。';}}
    finally{loading=false;if(alive())sync();}
  }
  select.addEventListener('change',()=>{size=Number(select.value);void load(1,true);});
  pager.addEventListener('submit',event=>{event.preventDefault();const n=Number(input.value);if(pager.reportValidity()&&Number.isSafeInteger(n)&&n>=1&&n<=cursors.length)void load(n);});
  signal.addEventListener('abort',()=>{disposed=true;details.clear();close();},{once:true});
  sync();await load(1);
}
