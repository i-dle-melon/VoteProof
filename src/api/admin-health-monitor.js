// Metadata-only monitoring. No R2 or Google Drive calls, mutations or timers.
import {adminHandler} from './admin-response.js';
import {jsonSuccess} from './response.js';
import {adminIdentity,ELEVATED_ROLES,AdminError} from '../lib/admin-identity.js';
import {authDatabase} from '../lib/auth-session.js';
import {storageSummary} from '../lib/storage-capacity.js';
import {encodeCursor} from './admin-validation.js';

const invalid=()=>new AdminError(400,'INVALID_HEALTH_QUERY','監控篩選或分頁參數無效。');
const LIMIT=20;
const allowedType=['all','backup','capacity','cleanup','operation'];
const allowedStatus=['all','pending','manual','resolved'];
function args(url){
  const p=url.searchParams;
  if([...p.keys()].some(k=>!['type','status','cursor'].includes(k)||p.getAll(k).length!==1))throw invalid();
  const type=p.get('type')??'all',status=p.get('status')??'all';
  if(!allowedType.includes(type)||!allowedStatus.includes(status))throw invalid();
  let after=null;const raw=p.get('cursor');
  if(raw!==null){
    try{
      if(raw.length>500||!/^[A-Za-z0-9_-]+$/.test(raw))throw Error();
      const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(
        Uint8Array.from(atob(raw.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));
      if(!Array.isArray(v)||v.length!==4||v[0]!==type||v[1]!==status||
        !Number.isSafeInteger(v[2])||v[2]<0||typeof v[3]!=='string'||v[3].length>140)throw Error();
      after=[v[2],v[3]];
    }catch{throw invalid();}
  }
  return {type,status,after};
}
const normalizeStatus=s=>s==='unknown'||s==='ambiguous'?'manual':s==='pending'||s==='claimed'||s==='active'||s==='failed'?'pending':'resolved';
const event=(type,id,created_at,code,state)=>({type,id,created_at,code,status:normalizeStatus(state)});
// Per-source bounded indexed reads: never UNION ALL entire historical tables.
async function fetchEvents(db,{type,status,after}) {
  const sources=[];
  const source=async(name,sql,params,format)=>{
    const r=(await db.prepare(sql).bind(...params,LIMIT+1).all()).results;
    sources.push(...r.map(format));
  };
  const filter=(prefix,column='created_at')=>after?`AND (${column}<? OR (${column}=? AND ('${prefix}'||id)<?))`:'';
  const argsAfter=()=>after?[after[0],after[0],after[1]]:[];
  if(type==='all'||type==='backup'){
    // Current failed backup rows. State is not a count of all historic failures.
    if(status==='all'||status==='pending'){
      await source('backup',`SELECT id,created_at,last_error_code,status FROM proof_backups
        WHERE provider='google_drive' AND status='failed' ${filter('backup:')}
        ORDER BY created_at DESC,id DESC LIMIT ?`,argsAfter(),
        r=>event('backup','backup:'+r.id,r.created_at,r.last_error_code??'BACKUP_FAILED',r.status));
    }
  }
  if(type==='all'||type==='capacity'||type==='cleanup'){
    const kind=type==='cleanup'?"AND kind='cleanup_failed'":type==='capacity'?"AND kind!='cleanup_failed'":'';
    const stateFilter=status==='pending'?"AND state IN ('pending','claimed')":
      status==='manual'?"AND state='ambiguous'":status==='resolved'?"AND state IN ('sent','disabled')":'';
    await source('capacity',`SELECT id,created_at,kind,state FROM storage_alerts WHERE 1=1 ${kind} ${stateFilter}
      ${filter('alert:')} ORDER BY created_at DESC,id DESC LIMIT ?`,argsAfter(),
      r=>event(r.kind==='cleanup_failed'?'cleanup':'capacity','alert:'+r.id,r.created_at,r.kind,r.state));
  }
  if(type==='all'||type==='operation'){
    const kindFilter=status==='resolved'?"AND state NOT IN ('active','unknown')":
      status==='manual'?"AND state='unknown'":status==='pending'?"AND state='active'":'';
    await source('operation',`SELECT id,created_at,kind,state FROM image_mutation_operations
      WHERE kind!='inventory' ${kindFilter} ${filter('operation:')}
      ORDER BY created_at DESC,id DESC LIMIT ?`,argsAfter(),
      r=>event('operation','operation:'+r.id,r.created_at,r.kind,r.state));
  }
  if(type==='all'||type==='capacity'){
    const actionFilter=status==='resolved'?"AND 0":status==='manual'?
      "AND action='alert_ambiguous'":status==='pending'?
      "AND action IN ('alert_rejected','alert_recipient_unavailable')":
      "AND action IN ('alert_ambiguous','alert_rejected','alert_recipient_unavailable')";
    await source('audit',`SELECT id,created_at,action FROM storage_audit WHERE 1=1 ${actionFilter}
      ${filter('audit:')} ORDER BY created_at DESC,id DESC LIMIT ?`,argsAfter(),
      r=>event('capacity','audit:'+r.id,r.created_at,r.action,
        r.action==='alert_ambiguous'?'unknown':'pending'));
  }
  return sources.filter(x=>status==='all'||x.status===status)
    .sort((a,b)=>b.created_at-a.created_at||b.id.localeCompare(a.id));
}
const summary=adminHandler(async(env,url,request)=>{
  await adminIdentity(request,env,ELEVATED_ROLES);
  if(url.search)throw invalid();
  const db=authDatabase(env);
  const [backup,cleanup,pending,unknown,reservations,pins,dispatches,legacy]=await db.batch([
    db.prepare("SELECT count(*) n FROM proof_backups WHERE provider='google_drive' AND status='failed'"),
    db.prepare("SELECT count(*) n FROM storage_alerts WHERE kind='cleanup_failed' AND created_at>=?").bind(Math.floor(Date.now()/1000)-86400),
    db.prepare("SELECT count(*) n FROM image_mutation_operations WHERE state='active' AND kind!='inventory'"),
    db.prepare("SELECT count(*) n FROM image_mutation_operations WHERE state='unknown'"),
    db.prepare("SELECT count(*) n FROM storage_reservations WHERE state='reserved'"),
    db.prepare("SELECT count(*) n FROM proof_upload_intents WHERE write_token IS NOT NULL"),
    db.prepare("SELECT count(*) n FROM storage_archive_dispatches WHERE state!='completed'"),
    db.prepare('SELECT legacy_status FROM image_maintenance_control WHERE id=1'),
  ]);
  const [cap]=await Promise.all([storageSummary(db,{live:env.STORAGE_CLEANUP_LIVE_ENABLED==='true'})]);
  return jsonSuccess({checked_at:Math.floor(Date.now()/1000),
    upload_failures:{count:null,coverage:'incomplete',message:'目前無法完整統計所有上傳失敗，不能視為 0。'},
    backup_failures:{count:backup.results[0].n,scope:'current_failed'},
    cleanup_failures:{count:cleanup.results[0].n,scope:'last_24_hours',mode:cap.cleanup_mode},
    pending_operations:{count:pending.results[0].n+unknown.results[0].n+reservations.results[0].n+pins.results[0].n+dispatches.results[0].n,
      active:pending.results[0].n,unknown:unknown.results[0].n,reservations:reservations.results[0].n,
      write_pins:pins.results[0].n,archive_dispatches:dispatches.results[0].n,
      legacy_ack_unverified:legacy.results[0]?.legacy_status==='unknown'},
    storage:{used_bytes:cap.used_bytes,budget_bytes:cap.budget.budget,blocked:cap.blocked,
      observed_at:cap.observed_at,trusted_until:cap.trusted_until,anomaly:cap.anomaly,cleanup_mode:cap.cleanup_mode},
    coverage:{upload:'partial',backup:'current_failed',cleanup:'recorded_alerts',operation:'recorded_operations'}});
});
const events=adminHandler(async(env,url,request)=>{
  await adminIdentity(request,env,ELEVATED_ROLES);
  const options=args(url),rows=await fetchEvents(authDatabase(env),options);
  const selected=rows.slice(0,LIMIT),last=selected.at(-1);
  return jsonSuccess({events:selected,next_cursor:rows.length>LIMIT?
    encodeCursor([options.type,options.status,last.created_at,last.id]):null,page_size:LIMIT,
    coverage:'Existing recorded events only; unknown historical failures may not appear.'});
});
export function adminHealthMonitorRoute(path){
  if(path==='/api/admin/health-monitor/summary')return{method:'GET',handler:summary};
  if(path==='/api/admin/health-monitor/events')return{method:'GET',handler:events};
}
