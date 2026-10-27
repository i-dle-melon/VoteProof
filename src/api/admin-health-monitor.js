// Legacy 0028, metadata only. Never infer old DELETE completion from zero signals.
import {adminHandler} from './admin-response.js';
import {jsonSuccess} from './response.js';
import {adminIdentity,ELEVATED_ROLES,AdminError} from '../lib/admin-identity.js';
import {authDatabase,authKey,authMac} from '../lib/auth-session.js';
import {equalQueryHash} from '../lib/case-keys.js';
import {STORAGE} from '../lib/storage-capacity.js';
import {encodeCursor} from './admin-validation.js';

const LIMIT=20,WINDOW=1000,SENTINEL=1001,SCHEMA='p1_legacy_0028_v1';
const invalid=()=>new AdminError(400,'INVALID_HEALTH_QUERY','監控篩選或分頁參數無效。');
const types=['all','backup','capacity','cleanup','operation'],statuses=['all','pending','manual','resolved'];
function options(url){
 const q=url.searchParams;
 if([...q.keys()].some(k=>!['type','status','from','to','cursor'].includes(k)||q.getAll(k).length!==1))throw invalid();
 const type=q.get('type')??'all',status=q.get('status')??'all',from=q.get('from')??'',to=q.get('to')??'';
 if(!types.includes(type)||!statuses.includes(status))throw invalid();
 const date=d=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(d))throw invalid();const at=Date.parse(d+'T00:00:00+08:00');if(!Number.isFinite(at)||new Date(at+28800000).toISOString().slice(0,10)!==d)throw invalid();return at/1000;};
 const since=from?date(from):null,before=to?date(to)+86400:null;if(since!==null&&before!==null&&since>=before)throw invalid();
 return {type,status,since,before,scope:JSON.stringify([type,status,from,to]),raw:q.get('cursor')};
}
// MATERIALIZED LIMIT precedes eligibility/date/order predicates. Row1001 is
// only a truncation sentinel. All subsequent work uses <=1000 picked rows.
function cte(table,columns,bounds){
 return `WITH recent AS MATERIALIZED (SELECT rowid AS seq,${columns} FROM ${table}
 ${bounds?'WHERE rowid BETWEEN ? AND ?':''} ORDER BY rowid DESC LIMIT ${SENTINEL}),
 picked AS MATERIALIZED (SELECT * FROM recent ORDER BY seq DESC LIMIT ${WINDOW})`;
}
const meta=`(SELECT COUNT(*) FROM recent) sampled_rows,(SELECT MIN(seq) FROM picked) lo,(SELECT MAX(seq) FROM picked) hi`;
function counter(db,table,columns,predicate,bind=[]){
 return db.prepare(`${cte(table,columns)} SELECT ${meta},(SELECT COUNT(*) FROM picked WHERE ${predicate}) observed_count`).bind(...bind);
}
function count(row){return {count:row.sampled_rows>=SENTINEL?null:row.observed_count,
 observed_count:row.observed_count,coverage:row.sampled_rows>=SENTINEL?'partial_window':'complete_table',
 window_limit:WINDOW,truncated:row.sampled_rows>=SENTINEL};}
const summary=adminHandler(async(env,url,request)=>{
 await adminIdentity(request,env,ELEVATED_ROLES);if(url.search)throw invalid();
 const now=Math.floor(Date.now()/1000),db=authDatabase(env);
 const rows=await db.batch([
  counter(db,'proof_backups','provider,status',"provider='google_drive' AND status='failed'"),
  counter(db,'storage_alerts','kind,created_at',"kind='cleanup_failed' AND created_at>=?",[now-86400]),
  counter(db,'storage_reservations','state',"state='reserved'"),
  counter(db,'proof_upload_intents','write_token IS NOT NULL AS pinned','pinned=1'),
  db.prepare('SELECT used_bytes,reserved_bytes,observed_at,trusted_until,blocked,anomaly FROM storage_capacity WHERE id=1'),
 ]);
 const [backup,cleanup,reservations,pins]=rows.slice(0,4).map(r=>count(r.results[0])),cap=rows[4].results[0];
 if(!cap)throw new AdminError(503,'ADMIN_SERVICE_UNAVAILABLE','容量狀態尚未取得。');
 return jsonSuccess({schema_compatibility:SCHEMA,checked_at:now,
  upload_failures:{count:null,coverage:'partial_coverage',message:'上傳失敗歷史覆蓋不完整，UNKNOWN，不能視為 0。'},
  backup_failures:{...backup,scope:'current_failed'},cleanup_failures:{...cleanup,scope:'last_24_hours',mode:env.STORAGE_CLEANUP_LIVE_ENABLED==='true'?'live':'dry-run'},
  pending_operations:{count:null,coverage:'partial_coverage',active:null,unknown:null,archive_dispatches:null,
   reservations:reservations.count,write_pins:pins.count,legacy_ack_unverified:true,
   known_signals:{reservations,write_pins:pins},
   unsupported:['image_mutation_operations','storage_archive_dispatches','image_maintenance_control']},
  storage:{used_bytes:cap.observed_at===null?null:cap.used_bytes,budget_bytes:STORAGE.budget,
   observed_at:cap.observed_at,trusted_until:cap.trusted_until,anomaly:cap.anomaly,
   blocked:!!cap.blocked||!cap.trusted_until||cap.trusted_until<=now||!!cap.anomaly||cap.used_bytes+cap.reserved_bytes>=STORAGE.stop,
   cleanup_mode:env.STORAGE_CLEANUP_LIVE_ENABLED==='true'?'live':'dry-run'},
  coverage:{upload:'partial_coverage',backup:backup.coverage,cleanup:cleanup.coverage,operation:'unsupported',legacy_delete_ack:'unknown'},
  window_limit:WINDOW});
});
const sources={
 backup:{table:'proof_backups',prefix:'backup:',columns:'id,created_at,provider,status,last_error_code',
  eligible:"provider='google_drive' AND status='failed'",state:"'pending'",code:"coalesce(last_error_code,'BACKUP_FAILED')",kind:"'backup'"},
 alert:{table:'storage_alerts',prefix:'alert:',columns:'id,created_at,kind,state',eligible:'1=1',
  state:"CASE WHEN kind='recovered' AND state!='ambiguous' THEN 'resolved' WHEN state='ambiguous' THEN 'manual' ELSE 'pending' END",
  code:'kind',kind:"CASE WHEN kind='cleanup_failed' THEN 'cleanup' ELSE 'capacity' END"},
 audit:{table:'storage_audit',prefix:'audit:',columns:'id,created_at,action',
  eligible:"action IN ('alert_ambiguous','alert_rejected','alert_recipient_unavailable')",
  state:"CASE WHEN action='alert_ambiguous' THEN 'manual' ELSE 'pending' END",code:'action',kind:"'capacity'"},
};
const selected=type=>type==='all'?['backup','alert','audit']:type==='backup'?['backup']:type==='capacity'?['alert','audit']:type==='cleanup'?['alert']:[];
function eventQuery(db,tag,opt,bounds,after){
 const s=sources[tag],where=[s.eligible],bind=bounds?[bounds[0],bounds[1]]:[];
 if(opt.type==='cleanup')where.push("kind='cleanup_failed'");else if(opt.type==='capacity'&&tag==='alert')where.push("kind!='cleanup_failed'");
 if(opt.status!=='all'){where.push(`(${s.state})=?`);bind.push(opt.status);}
 if(opt.since!==null){where.push('created_at>=?');bind.push(opt.since);}
 if(opt.before!==null){where.push('created_at<?');bind.push(opt.before);}
 if(after){where.push(`(created_at<? OR (created_at=? AND ('${s.prefix}'||id)<?))`);bind.push(after[0],after[0],after[1]);}
 return db.prepare(`${cte(s.table,s.columns,bounds)} SELECT ${meta},
 (SELECT json_group_array(json_object('id',id,'created_at',created_at,'code',code,'status',status,'type',type)) FROM
 (SELECT '${s.prefix}'||id AS id,created_at,${s.code} AS code,${s.state} AS status,${s.kind} AS type
 FROM picked WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ${LIMIT+1})) events_json`).bind(...bind);
}
async function readCursor(raw,opt,tags,key,actor){
 if(raw===null)return null;
 try{
  if(raw.length>4000||!/^[A-Za-z0-9_-]+$/.test(raw))throw Error();
  const x=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(raw.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));
  if(!Array.isArray(x)||x.length!==2||typeof x[1]!=='string'||!/^[a-f0-9]{64}$/.test(x[1]))throw Error();
  const v=x[0];if(!Array.isArray(v)||v.length!==6||v[0]!==1||v[1]!==opt.scope||!Number.isSafeInteger(v[2])||v[2]<Date.now()/1000||v[2]>Date.now()/1000+1801||
   !Array.isArray(v[3])||v[3].length!==tags.length||!Number.isSafeInteger(v[4])||v[4]<0||typeof v[5]!=='string'||v[5].length>220)throw Error();
  for(const [i,w]of v[3].entries())if(!Array.isArray(w)||w.length!==4||w[0]!==tags[i]||!Number.isSafeInteger(w[1])||!Number.isSafeInteger(w[2])||w[1]<0||w[2]<w[1]||typeof w[3]!=='boolean')throw Error();
  if(!equalQueryHash(x[1],await authMac(key,'p1-health-window',JSON.stringify([actor,v]))))throw Error();
  return {windows:v[3],after:[v[4],v[5]],until:v[2]};
 }catch{throw invalid();}
}
const events=adminHandler(async(env,url,request)=>{
 const actor=await adminIdentity(request,env,ELEVATED_ROLES),opt=options(url),tags=selected(opt.type),key=await authKey(env);
 const prior=await readCursor(opt.raw,opt,tags,key,actor.member.member_id),db=authDatabase(env);
 const results=tags.length?await db.batch(tags.map((tag,i)=>eventQuery(db,tag,opt,prior?.windows[i].slice(1,3),prior?.after))):[];
 const windows=[],rows=[];
 for(const [i,r]of results.entries()){
  const m=r.results[0],initial=prior?.windows[i];windows.push(initial??[tags[i],m.lo??0,m.hi??0,m.sampled_rows>=SENTINEL]);
  rows.push(...JSON.parse(m.events_json??'[]'));
 }
 rows.sort((a,b)=>b.created_at-a.created_at||(a.id<b.id?1:a.id>b.id?-1:0));
 const page=rows.slice(0,LIMIT),last=page.at(-1),until=prior?.until??Math.floor(Date.now()/1000)+1800;
 let next=null;if(rows.length>LIMIT){const value=[1,opt.scope,until,windows,last.created_at,last.id];next=encodeCursor([value,await authMac(key,'p1-health-window',JSON.stringify([actor.member.member_id,value]))]);}
 return jsonSuccess({schema_compatibility:SCHEMA,events:page,next_cursor:next,page_size:LIMIT,count:null,
  coverage:!tags.length?'unsupported':windows.some(w=>w[3])?'partial_window':'recorded_only',window_limit:WINDOW,
  source_windows:windows.map(w=>({source:w[0],truncated:w[3]})),legacy_delete_ack:'unknown',
  message:!tags.length?'UNSUPPORTED：0028 無完整作業追蹤；舊 DELETE／ACK 為 UNKNOWN。':'僅固定來源窗口內的已記錄事件；窗口以外及未記錄歷史均非零筆證明。',
  live_status_note:'固定窗口不含後來新增紀錄；既有作業狀態仍可能正常更新，並非跨請求資料庫快照。'});
});
export function adminHealthMonitorRoute(path){
 if(path==='/api/admin/health-monitor/summary')return{method:'GET',handler:summary};
 if(path==='/api/admin/health-monitor/events')return{method:'GET',handler:events};
}
