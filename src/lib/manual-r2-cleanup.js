import {AdminError,ELEVATED_AUTH_GUARD,actorBindings} from './admin-identity.js';
import {invalidVerification} from '../api/auth-validation.js';
import {coldContext,scriptUrl,validColdSource} from './cold-storage.js';
import {verifyDriveArchive,ARCHIVE_RETENTION_DAYS,ARCHIVE_VERIFICATION_TTL} from './storage-archive.js';
import {r2VerifiedSha256} from './r2-verified-checksum.js';
import {ISOLATED_FINAL_PREFIX,isIsolatedFinalKey} from './proof-generation.js';
const at=()=>Math.floor(Date.now()/1000),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LEGACY_CUTOFF='2026-11-24T16:00:00.000Z'; // 2026-11-25 00:00 in Taipei.
const LEGACY_OPERATIONS_END='2026-11-06T18:38:36.141Z';
const noArchiveStatuses=['duplicate','rejected','revoked'];
const noArchiveStatusSql=`c.status IN('${noArchiveStatuses.join("','")}')`;
const fail=(code='MANUAL_CLEANUP_BLOCKED',status=409)=>new AdminError(status,code,'圖片清理安全條件未成立；未重送刪除。');
const message='圖片已清理，備份保存在 Google Drive';
export const CLEANED_PROOF_MESSAGE=message;
const exportMessage='圖片已清理，請從已確認下載的匯出 ZIP 取得原圖。';
export const CLEANED_R2_PROOF_MESSAGE='圖片已從 R2 清理，無法線上預覽。';
const cleanedMessage=saved=>saved?.archive_source==='none'?CLEANED_R2_PROOF_MESSAGE:saved?.archive_source==='export'?exportMessage:message;
// The prior valid=1 INSERT + DELETE cost three written rows per guard.
// A failed assertion still INSERTs valid=0 and aborts the entire D1 batch;
// success writes no guard row. Fence/Permit and all business writes remain.
async function authAtomic(db,guards,statements){
 try{return await db.batch([db.prepare(`INSERT INTO auth_atomic_guards(id,valid) SELECT ?,0 WHERE (${guards.map(g=>'('+g.sql+')').join(' AND ')}) IS NOT 1`).bind(crypto.randomUUID(),...guards.flatMap(g=>g.args)),...statements]);}
 catch(error){if(String(error?.message).includes('CHECK constraint failed: valid=1'))throw invalidVerification();throw error;}
}
const unresolvedR2="pending_r2>0 OR (state='unknown' AND r2_writes>0)";
const legacyOperationsSafe=`NOT EXISTS(SELECT 1 FROM prelaunch_reset_operations WHERE ${unresolvedR2})`;
const isolatedOperationsSafe=`NOT EXISTS(SELECT 1 FROM prelaunch_reset_operations
 WHERE isolated_r2_key IN(f.object_key,'*') AND (${unresolvedR2}))`;
// Any unresolved operation outside the reviewed historical set blocks this
// exception. Reviewing the set never modifies or settles the original rows.
const reviewedLegacyOperationsSafe=`NOT EXISTS(SELECT 1 FROM prelaunch_reset_operations o
 WHERE (${unresolvedR2}) AND (o.epoch<>1 OR o.isolated_r2_key IS NOT NULL
 OR julianday(o.started_at) IS NULL OR o.started_at>'${LEGACY_OPERATIONS_END}'
 OR NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE j.value=o.id)))`;
const capacitySafe='EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND anomaly IS NULL AND inventory_id IS NULL)';
// Match the exact server-issued key of a consumed final Intent and its original
// native PUT version. Old records and live HEAD responses cannot create a receipt.
const immutablePutReceipt=(prefix,extra='')=>`SELECT CASE WHEN count(*)=1 THEN min(r.object_version) END
 FROM proof_upload_intents i JOIN prelaunch_reset_issuance s ON s.session_id=i.session_id
 JOIN prelaunch_reset_control x ON x.id=1 AND x.epoch=s.epoch
 JOIN storage_reservations r ON r.object_key=i.object_key AND r.state='committed'
 WHERE i.proof_id=f.id AND i.consumed_case_id=c.id AND i.state='consumed' AND i.object_key=f.object_key
 AND i.size=f.size AND i.content_type=f.content_type AND s.kind IN('direct','v2') AND s.keys_json=json_array(f.object_key)
 AND s.epoch>0 AND f.object_key='${prefix}g'||s.epoch||'/'||i.session_id||'/'||i.proof_id||
 CASE f.content_type WHEN 'image/png' THEN '.png' WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/webp' THEN '.webp' END
 AND i.write_token IS NULL AND r.bytes=f.size AND r.etag=f.etag AND length(r.object_version)>0 ${extra}`;
const isolatedReceipt=immutablePutReceipt(ISOLATED_FINAL_PREFIX);
// A consumed immutable Intent excludes the orphan sweeper and admits no new
// PUT. Prior case deletion is independently blocked by the cold/audit guards.
const legacyReceipt=immutablePutReceipt('proofs/final/',`AND julianday(f.created_at)<julianday('${LEGACY_CUTOFF}')`);
export function cleanupEligibility(env){
 const isolatedProofs=env.PRELAUNCH_RESET_CONTEXT?.isolatedProofs===true;
 const raw=env.R2_MANUAL_CLEANUP_REVIEWED_LEGACY_OPERATIONS;
 let legacyOperations=null;
 if(isolatedProofs&&typeof raw==='string'&&raw.length<400){
  try{
   const ids=JSON.parse(raw);
   if(Array.isArray(ids)&&ids.length===7&&new Set(ids).size===7&&ids.every(x=>typeof x==='string'&&uuid.test(x)))legacyOperations=JSON.stringify(ids);
  }catch{/* An invalid approval does not relax the ordinary guard. */}
 }
 let legacyDriveReady=false;
 if(legacyOperations&&/^[a-f0-9]{64}$/.test(env.DRIVE_BACKUP_RELAY_SECRET??'')){
  try{scriptUrl(env.DRIVE_COLD_RELAY_URL);legacyDriveReady=true;}catch{/* The export path is independent of the Drive relay. */}
 }
 return {isolatedProofs,legacyOperations,legacyDriveReady};
}
const candidateSafety=({isolatedProofs,legacyOperations,legacyDriveReady})=>isolatedProofs
 ?`(CASE WHEN f.object_key GLOB '${ISOLATED_FINAL_PREFIX}*'
 THEN (${isolatedReceipt}) IS NOT NULL AND ${isolatedOperationsSafe}
 ELSE ${legacyOperationsSafe}${legacyOperations?` OR (${legacyDriveReady?'':`(${noArchiveStatusSql} OR d.file_id IS NOT NULL) AND `}${reviewedLegacyOperationsSafe} AND (${legacyReceipt}) IS NOT NULL)`:''} END) AND ${capacitySafe}`
 :`${legacyOperationsSafe} AND ${capacitySafe}`;
const unfinishedExport=until=>`EXISTS(SELECT 1 FROM export_job_items e JOIN export_jobs j ON j.id=e.job_id
 LEFT JOIN export_packages pkg ON pkg.job_id=e.job_id AND pkg.number=e.package_no
 WHERE e.file_id=f.id AND j.expires_at>${until} AND pkg.status IS NOT 'completed')`;
// Build the list from live jobs once, using the job_id prefix of the item index.
// Probing historical export items by file_id for each candidate scans the export history repeatedly.
const listedUnfinishedExport=until=>`f.id IN(SELECT e.file_id FROM export_jobs j
 CROSS JOIN export_job_items e ON e.job_id=j.id
 LEFT JOIN export_packages pkg ON pkg.job_id=e.job_id AND pkg.number=e.package_no
 WHERE j.expires_at>${until} AND pkg.status IS NOT 'completed')`;
const fileSafe=hasUnfinishedExport=>`NOT EXISTS(SELECT 1 FROM storage_reservations r WHERE r.object_key=f.object_key AND r.state='reserved')
 AND NOT EXISTS(SELECT 1 FROM proof_upload_intents i WHERE i.object_key=f.object_key AND i.write_token IS NOT NULL)
 AND NOT (${hasUnfinishedExport})
 AND NOT EXISTS(SELECT 1 FROM export_file_claims e WHERE e.file_id=f.id AND e.lease_until>?)`;
const backupQuiet=`NOT EXISTS(SELECT 1 FROM proof_backups busy WHERE busy.file_id=f.id AND (busy.status='processing' OR busy.lease_until IS NOT NULL))`;
const driveBound=`b.status='confirmed' AND b.lease_until IS NULL AND b.drive_file_id IS NOT NULL
 AND b.source_object_key=f.object_key AND b.source_size=f.size AND b.source_etag=f.etag AND b.source_mime=f.content_type`;
const exportMatch=`d.file_id=f.id AND d.etag=f.etag AND d.file_size=f.size AND d.content_type=f.content_type`;
const candidateSql=eligibility=>`SELECT f.id file_id,c.id case_internal_id,c.case_id,c.campaign_id,c.status,c.created_at,c.updated_at,c.version case_version,
 f.size,f.object_key,f.created_at file_created_at,CASE WHEN NOT ${noArchiveStatusSql} AND d.file_id IS NULL THEN b.version END backup_version,b.status backup_status,
 CASE WHEN ${noArchiveStatusSql} THEN 'none' WHEN d.file_id IS NOT NULL THEN 'export' WHEN ${driveBound} THEN 'drive' END archive_source,
 p.state cleanup_state,c.reviewed_at,coalesce(c.status_updated_at,c.updated_at) closed_at,
 (${backupQuiet}) backup_quiet,
 EXISTS(SELECT 1 FROM storage_reservations r WHERE r.object_key=f.object_key AND r.state='reserved') has_reservation,
 EXISTS(SELECT 1 FROM proof_upload_intents i WHERE i.object_key=f.object_key AND i.write_token IS NOT NULL) has_pin,
 (${listedUnfinishedExport("strftime('%Y-%m-%dT%H:%M:%fZ','now')")}
 OR EXISTS(SELECT 1 FROM export_file_claims e WHERE e.file_id=f.id AND e.lease_until>CAST(strftime('%s','now') AS INTEGER))) has_export,
 (${candidateSafety(eligibility)}) r2_safe,
 CASE WHEN (${noArchiveStatusSql} OR (c.status='completed' AND c.reviewed_at IS NOT NULL
 AND (d.file_id IS NOT NULL OR (${driveBound}))
 AND julianday(coalesce(c.status_updated_at,c.updated_at))<=julianday(?,
  CASE WHEN ?=1 AND d.file_id IS NOT NULL THEN '0 days' ELSE '-${ARCHIVE_RETENTION_DAYS} days' END)))
 AND ${backupQuiet} AND f.size BETWEEN 1 AND 5242880
 AND (p.file_id IS NULL OR p.state IN('blocked','dry_run')) AND ${fileSafe(listedUnfinishedExport('?'))} AND ${candidateSafety(eligibility)}
 AND NOT EXISTS(SELECT 1 FROM storage_audit a WHERE a.id='manual-cleanup:dispatch:'||f.id) THEN 1 ELSE 0 END eligible
 FROM case_files f JOIN cases c ON c.id=f.case_id LEFT JOIN proof_backups b ON b.file_id=f.id AND b.provider='google_drive'
 LEFT JOIN export_completed_files d ON ${exportMatch}
 LEFT JOIN cold_proofs p ON p.file_id=f.id`;
function filters(url){
 const p=url.searchParams,allowed=['campaign_id','from','to','status','backup','eligible','cutoff','cursor','allow_early_export','summary'];
 if([...p.keys()].some(k=>!allowed.includes(k)||p.getAll(k).length!==1))throw fail('INVALID_CLEANUP_QUERY',400);
 if(p.has('summary')&&p.get('summary')!=='0')throw fail('INVALID_CLEANUP_QUERY',400);
 const allowEarlyExport=p.has('allow_early_export');
 if(allowEarlyExport&&p.get('allow_early_export')!=='1')throw fail('INVALID_CLEANUP_QUERY',400);
 const day=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
 const from=p.get('from'),to=p.get('to'),cutoff=p.get('cutoff')??new Date().toISOString();
 if((from&&!day(from))||(to&&!day(to))||(from&&to&&from>to)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff)||!Number.isFinite(Date.parse(cutoff))||Date.parse(cutoff)>Date.now()+1000)throw fail('INVALID_CLEANUP_QUERY',400);
 const clauses=['created_at<=?','updated_at<=?'],args=[cutoff,cutoff];
 for(const[k,values,column]of[['status',['pending','approved','completed','rejected','duplicate','revoked'],'status'],['backup',['pending','processing','confirmed','failed'],'backup_status']]){
  const v=p.get(k);if(v){if(!values.includes(v))throw fail('INVALID_CLEANUP_QUERY',400);clauses.push(column+'=?');args.push(v);}}
 const eligible=p.get('eligible');
 if(eligible&&!['yes','no'].includes(eligible))throw fail('INVALID_CLEANUP_QUERY',400);
 const campaign=p.get('campaign_id');if(campaign){if(!/^[A-Za-z0-9_-]{1,100}$/.test(campaign))throw fail('INVALID_CLEANUP_QUERY',400);clauses.push('campaign_id=?');args.push(campaign);}
 if(from){clauses.push('created_at>=?');args.push(new Date(from+'T00:00:00+08:00').toISOString());}
 if(to){clauses.push('created_at<?');args.push(new Date(Date.parse(to+'T00:00:00+08:00')+86400000).toISOString());}
 const scope=JSON.stringify([campaign,from,to,p.get('status'),p.get('backup'),p.get('eligible'),cutoff,...(allowEarlyExport?[1]:[])]);
 if(p.has('cursor')){let v;try{const raw=p.get('cursor');if(raw.length>1500)throw Error();v=JSON.parse(atob(raw));}catch{throw fail('INVALID_CLEANUP_QUERY',400);}
  if(!Array.isArray(v)||v.length!==3||v[0]!==scope||typeof v[1]!=='string'||!Number.isFinite(Date.parse(v[1]))||!uuid.test(v[2]))throw fail('INVALID_CLEANUP_QUERY',400);
  clauses.push('(created_at>? OR (created_at=? AND file_id>?))');args.push(v[1],v[1],v[2]);}
 return{p,cutoff,allowEarlyExport,scope,where:clauses.join(' AND '),args,eligible};
}
export async function cleanupCandidates(db,url,eligibility={}){
 const f=filters(url),cutoffMs=Date.parse(f.cutoff),time=Math.floor(cutoffMs/1000);
 const legacyArgs=eligibility.isolatedProofs&&eligibility.legacyOperations?[eligibility.legacyOperations]:[];
 const base=[...legacyArgs,f.cutoff,Number(f.allowEarlyExport),f.cutoff,time,...legacyArgs];
 const candidates=`FROM (${candidateSql(eligibility)}) WHERE (cleanup_state IS NULL OR cleanup_state<>'cold') AND ${f.where}`;
 const eligibleArgs=f.eligible?[Number(f.eligible==='yes')]:[];
 const page=(await db.prepare(`SELECT * ${candidates}${f.eligible?' AND eligible=?':''} ORDER BY created_at,file_id LIMIT 21`)
  .bind(...base,...f.args,...eligibleArgs).all()).results;
 let summary=null;
 if(!f.p.has('cursor')&&!f.p.has('summary')){
  // Classify each matching row once for both totals and the eligibility filter.
  summary=await db.prepare(`WITH classified AS MATERIALIZED (SELECT size,eligible ${candidates})
   SELECT COUNT(*) total,COALESCE(SUM(eligible),0) eligible_count,COALESCE(SUM(eligible*size),0) eligible_bytes
   FROM classified${f.eligible?' WHERE eligible=?':''}`).bind(...base,...f.args,...eligibleArgs).first();
 }
 const rows=page.slice(0,20),last=rows.at(-1);
 return{...summary,cutoff:f.cutoff,retention_days:ARCHIVE_RETENTION_DAYS,items:rows.map(({object_key,file_created_at,case_internal_id,has_reservation,has_pin,has_export,r2_safe,backup_quiet,...r})=>{
  const withoutArchive=r.archive_source==='none';
  const reasons=[];if(!r.archive_source)reasons.push('尚無符合目前圖片版本的 Drive 備份或已確認下載的匯出');
  if(!backup_quiet)reasons.push('Drive 備份作業尚未結束');
  if(!withoutArchive&&(r.status!=='completed'||!r.reviewed_at))reasons.push('案件尚未完成可清理審核');
  const closedAt=Date.parse(r.closed_at);
  const withinRetention=closedAt>cutoffMs-86400000*ARCHIVE_RETENTION_DAYS;
  const earlyExport=f.allowEarlyExport&&r.archive_source==='export'&&withinRetention;
  if(!withoutArchive){
   if(!Number.isFinite(closedAt)||closedAt>cutoffMs)reasons.push('無法確認結案時間');
   else if(withinRetention&&!earlyExport)reasons.push('結案後尚未滿7天');
  }
  if(has_reservation)reasons.push('有未完成的儲存空間預留');if(has_pin)reasons.push('圖片仍有寫入鎖定');if(has_export)reasons.push('匯出或下載作業尚未結束');
  if(!r2_safe){
   const needsDriveRelay=eligibility.legacyOperations&&!eligibility.legacyDriveReady&&r.archive_source==='drive'
    &&object_key.startsWith('proofs/final/g')&&Date.parse(file_created_at)<Date.parse(LEGACY_CUTOFF);
   reasons.push(needsDriveRelay?'已有 Drive 備份，需設定即時驗證入口才能清理':'未決 R2 操作、原始版本收據不足、盤點或容量異常尚未排除');
  }
  if(r.cleanup_state==='verifying')reasons.push('已有驗證作業，逾時也不會接管');if(r.cleanup_state==='deleting')reasons.push('刪除結果待人工核對，不會重送');
  const archiveReason=withoutArchive?'依案件狀態可清理 R2，無需備份、下載或等待 7 天':r.archive_source==='export'
   ?(earlyExport?'結案未滿 7 天，已確認下載；清理前會重新核對匯出紀錄及 R2':'已確認下載；清理前會重新核對匯出紀錄及 R2')
   :'清理前會即時驗證 Drive 和 R2';
  return{...r,eligible:!!r.eligible,reason:r.eligible?archiveReason:reasons.join('；')||'清理狀態需人工確認'};
 }),next_cursor:page.length>20?btoa(JSON.stringify([f.scope,last.created_at,last.file_id])):null};
}
export function cleanupInput(body){
 const version=v=>Number.isSafeInteger(v)&&v>=0;
 if(!body||Object.keys(body).filter(k=>k!=='allow_early_export'&&k!=='without_archive').sort().join(',')!=='attempt_id,backup_version,case_version,file_id'
  ||(Object.hasOwn(body,'allow_early_export')&&typeof body.allow_early_export!=='boolean')
  ||(Object.hasOwn(body,'without_archive')&&(body.without_archive!==true||body.backup_version!==null||Object.hasOwn(body,'allow_early_export')))
  ||!uuid.test(body.file_id??'')||!uuid.test(body.attempt_id??'')||!version(body.case_version)||(body.backup_version!==null&&!version(body.backup_version)))throw fail('INVALID_CLEANUP_REQUEST',400);
 return body;
}
async function readiness(env){
 if(env.R2_MANUAL_CLEANUP_ENABLED!=='true'||env.PRELAUNCH_RESET_FENCE_ENABLED!=='true'||env.R2_EXCLUSIVE_WRITER_CONFIRMED!=='true'||env.STORAGE_CLEANUP_LIVE_ENABLED==='true')throw fail('MANUAL_CLEANUP_DISABLED',503);
 const row=await env.DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name IN('manual_cleanup_cold_owner','manual_cleanup_backup_pin','manual_cleanup_file_pin','manual_cleanup_inventory_pin','manual_cleanup_export_claim_insert','manual_cleanup_export_claim_update','manual_cleanup_dispatch_guard','manual_cleanup_terminal_guard')").first();
 if(row.n!==8)throw fail('MANUAL_CLEANUP_SCHEMA_REQUIRED',503);
}
async function source(env,input){
 const db=env.DB;
 const withoutArchive=input.without_archive===true,exportSource=input.backup_version===null&&!withoutArchive;
 let r;
 if(withoutArchive||exportSource){
  r=await db.prepare(`SELECT f.id file_id,f.object_key,f.size,f.etag,f.content_type,c.id case_internal_id,c.status,c.version case_version,
   c.reviewed_at,coalesce(c.status_updated_at,c.updated_at) closed_at,${exportSource?'d.job_id,d.package_no,d.confirmed_at,d.confirmed_by,':''}
   (SELECT sha256 FROM proof_exact_hashes h WHERE h.file_id=f.id AND h.source_etag=f.etag AND h.source_size=f.size) known_sha
   FROM case_files f JOIN cases c ON c.id=f.case_id ${exportSource?`JOIN export_completed_files d ON ${exportMatch}`:''}
   WHERE f.id=? AND ${backupQuiet}`).bind(input.file_id).first();
  if(r)r={...r,archive_source:withoutArchive?'none':'export',backup_version:null};
 }else{
  const f=await db.prepare('SELECT object_key FROM case_files WHERE id=?').bind(input.file_id).first();
  const drive=f?await coldContext(db,f.object_key):null;
  if(validColdSource(drive))r={...drive,archive_source:'drive'};
 }
 const closedAt=Date.parse(r?.closed_at);
 const allowEarlyExport=exportSource&&input.allow_early_export===true;
 const latestAllowed=(at()-(allowEarlyExport?0:86400*ARCHIVE_RETENTION_DAYS))*1000;
 if(!r||r.file_id!==input.file_id||r.case_version!==input.case_version||r.backup_version!==input.backup_version||r.size<1||r.size>5242880)throw fail();
 const noArchiveStatus=noArchiveStatuses.includes(r.status);
 const canUseArchive=(r.status==='completed'||noArchiveStatus)&&r.reviewed_at&&Number.isFinite(closedAt)&&closedAt<=latestAllowed;
 if(!(withoutArchive?noArchiveStatus:canUseArchive))throw fail();
 if(env.PRELAUNCH_RESET_CONTEXT?.isolatedProofs&&isIsolatedFinalKey(r.object_key)){
  const version=await db.prepare(`SELECT (${isolatedReceipt}) AS version
   FROM case_files f JOIN cases c ON c.id=f.case_id WHERE f.id=?`).bind(r.file_id).first('version');
  if(!version)throw fail('MANUAL_CLEANUP_ISOLATION_RECEIPT_REQUIRED');
  r.isolated_r2_version=version;
 }else{
  const {legacyOperations,legacyDriveReady}=cleanupEligibility(env);
  if(legacyOperations&&(withoutArchive||r.archive_source==='export'||legacyDriveReady)&&r.object_key.startsWith('proofs/final/g')){
   const version=await db.prepare(`SELECT (${legacyReceipt}) AS version
    FROM case_files f JOIN cases c ON c.id=f.case_id WHERE f.id=?`).bind(r.file_id).first('version');
   if(version){r.legacy_r2_version=version;r.legacy_operations=legacyOperations;}
  }
 }
 return {...r,allow_early_export:allowEarlyExport};
}
function guards(row,actor){
 const operations=row.isolated_r2_version
  ?{sql:`${isolatedOperationsSafe} AND (${isolatedReceipt})=?`,args:[row.isolated_r2_version]}
  :row.legacy_r2_version
   ?{sql:`(${legacyOperationsSafe} OR (${reviewedLegacyOperationsSafe} AND (${legacyReceipt})=?))`,
     args:[row.legacy_operations,row.legacy_r2_version]}
   :{sql:legacyOperationsSafe,args:[]};
 const durableSource=row.archive_source==='none'?{sql:'1',args:[]}:row.archive_source==='export'
  ?{sql:`EXISTS(SELECT 1 FROM export_completed_files d WHERE ${exportMatch} AND d.job_id=? AND d.package_no=? AND d.confirmed_at=? AND d.confirmed_by=?)`,
    args:[row.job_id,row.package_no,row.confirmed_at,row.confirmed_by]}
  :{sql:`EXISTS(SELECT 1 FROM proof_backups b WHERE b.file_id=f.id AND b.provider='google_drive' AND b.id=? AND b.version=?
    AND ${driveBound} AND b.drive_file_id=? AND b.drive_folder_id=? AND b.root_folder_id=?)`,
    args:[row.backup_id,row.backup_version,row.drive_file_id,row.drive_folder_id,row.root_folder_id]};
 return[
 {sql:ELEVATED_AUTH_GUARD,args:actorBindings(actor)},
 {sql:capacitySafe,args:[]},
 {sql:`EXISTS(SELECT 1 FROM cases c JOIN case_files f ON f.case_id=c.id
 WHERE f.id=? AND c.id=? AND c.version=? AND c.status=? AND coalesce(c.status_updated_at,c.updated_at)=?
 AND f.object_key=? AND f.etag=? AND f.size=? AND f.content_type=? AND ${durableSource.sql} AND ${backupQuiet} AND ${fileSafe(unfinishedExport('?'))} AND ${operations.sql})`,
 args:[row.file_id,row.case_internal_id,row.case_version,row.status,row.closed_at,row.object_key,row.etag,row.size,row.content_type,...durableSource.args,new Date().toISOString(),at(),...operations.args]},
 ];}
const audit=(db,row,actor,action,detail,id=crypto.randomUUID())=>db.prepare('INSERT INTO storage_audit(id,created_at,action,target,detail) VALUES(?,?,?,?,?)').bind(id,at(),action,row.file_id,JSON.stringify({admin_member_id:actor.member.member_id,case_version:row.case_version,backup_version:row.backup_version,archive_source:row.archive_source,...(row.archive_source==='none'?{case_status:row.status}:{}),...(row.allow_early_export?{allow_early_export:true}:{}),...(row.legacy_r2_version?{reviewed_legacy_candidate:true}:{}),...detail}));
function context(p){try{return JSON.parse(p?.verification_context??'null');}catch{return null;}}
const sameObject=(o,row,sha,version)=>o&&o.etag===row.etag&&o.size===row.size&&o.httpMetadata?.contentType===row.content_type&&o.version&&(!version||o.version===version)&&r2VerifiedSha256(o)===sha;
export async function verifyCleanup(env,actor,input,{verify=verifyDriveArchive}={}){
 await readiness(env);const db=env.DB,row=await source(env,input),prior=await db.prepare('SELECT * FROM cold_proofs WHERE file_id=?').bind(row.file_id).first();
 if(prior&&['verifying','deleting','cold'].includes(prior.state))throw fail('MANUAL_CLEANUP_PENDING');
 if(await db.prepare('SELECT id FROM storage_audit WHERE id=?').bind('manual-cleanup:dispatch:'+row.file_id).first())throw fail('MANUAL_CLEANUP_PENDING');
 const data={manual:true,attempt_id:input.attempt_id,owner:actor.member.member_id,epoch:env.PRELAUNCH_RESET_CONTEXT?.epoch,archive_source:row.archive_source,
  ...(row.allow_early_export?{allow_early_export:true}:{})};
 await authAtomic(db,guards(row,actor),[db.prepare(`INSERT INTO cold_proofs(file_id,state,lease_token,lease_until,attempts,updated_at,verification_context)
 SELECT ?,'verifying',operation_id,?,1,?,? FROM prelaunch_reset_permit WHERE id=1 AND purpose='normal'
 ON CONFLICT(file_id) DO UPDATE SET state='verifying',lease_token=excluded.lease_token,lease_until=excluded.lease_until,attempts=attempts+1,updated_at=excluded.updated_at,verification_context=excluded.verification_context
 WHERE cold_proofs.state IN('blocked','dry_run') RETURNING file_id`).bind(row.file_id,at()+300,at(),JSON.stringify(data)),audit(db,row,actor,'manual_cleanup_verify',{attempt_id:input.attempt_id})]);
 const claim=await db.prepare('SELECT * FROM cold_proofs WHERE file_id=?').bind(row.file_id).first();
 if(context(claim)?.attempt_id!==input.attempt_id)throw fail('MANUAL_CLEANUP_PENDING');
 try{
  const object=await env.PROOFS_BUCKET.head(row.object_key),sha=r2VerifiedSha256(object);
  if(!sha||!sameObject(object,row,sha,row.isolated_r2_version??row.legacy_r2_version)||row.known_sha&&row.known_sha!==sha)throw fail('MANUAL_CLEANUP_R2_MISMATCH');
  const v=row.archive_source==='drive'?await verify(env,row,sha)
   :{sha256:sha,verified_at:at(),receipt:row.archive_source==='export'
     ?{job_id:row.job_id,package_no:row.package_no,confirmed_at:row.confirmed_at,confirmed_by:row.confirmed_by}
     :null};
  const verifiedAt=v.verified_at;
  if(v.sha256!==sha||!Number.isSafeInteger(verifiedAt)||verifiedAt>at()||at()-verifiedAt>ARCHIVE_VERIFICATION_TTL)throw fail('MANUAL_CLEANUP_DRIVE_MISMATCH');
  if(!sameObject(await env.PROOFS_BUCKET.head(row.object_key),row,sha,object.version))throw fail('MANUAL_CLEANUP_R2_MISMATCH');
  await authAtomic(db,[...guards(row,actor),{sql:"EXISTS(SELECT 1 FROM cold_proofs WHERE file_id=? AND state='verifying' AND lease_token=?)",args:[row.file_id,claim.lease_token]}],[
   db.prepare("UPDATE cold_proofs SET sha256=?,r2_version=?,etag=?,size=?,case_version=?,backup_version=?,verified_at=?,verification_context=?,updated_at=? WHERE file_id=? AND lease_token=?")
    .bind(sha,object.version,row.etag,row.size,row.case_version,row.backup_version,verifiedAt,JSON.stringify({...data,receipt:v.receipt}),at(),row.file_id,claim.lease_token),audit(db,row,actor,'manual_cleanup_verified',{attempt_id:input.attempt_id,sha256:sha})]);
  return{file_id:row.file_id,state:'verified',attempt_id:input.attempt_id,expires_at:verifiedAt+ARCHIVE_VERIFICATION_TTL};
 }catch(error){
  // An uncertain D1 result retains the verifying lock; never reclaim by timeout.
  if(error instanceof AdminError)try{await db.prepare("UPDATE cold_proofs SET state='blocked',lease_token=NULL,lease_until=NULL,error_code=?,updated_at=? WHERE file_id=? AND lease_token=? AND state='verifying'").bind(error.code,at(),row.file_id,claim.lease_token).run();}catch{}
  throw error instanceof AdminError?error:fail('MANUAL_CLEANUP_VERIFY_UNKNOWN',503);
 }
}
export async function deleteCleanup(env,actor,input){
 await readiness(env);const db=env.DB,row=await source(env,input),p=await db.prepare('SELECT * FROM cold_proofs WHERE file_id=?').bind(row.file_id).first(),saved=context(p);
 const receiptVersion=row.isolated_r2_version??row.legacy_r2_version;
 if(p?.state==='cold')return{file_id:row.file_id,state:'deleted',message:cleanedMessage(saved)};
 if(p?.state!=='verifying'||saved?.manual!==true||saved.attempt_id!==input.attempt_id||saved.owner!==actor.member.member_id
  ||saved.epoch!==env.PRELAUNCH_RESET_CONTEXT?.epoch||!Number.isSafeInteger(p.verified_at)
  ||p.verified_at>at()||at()-p.verified_at>ARCHIVE_VERIFICATION_TTL
  ||(receiptVersion&&p.r2_version!==receiptVersion))throw fail('MANUAL_CLEANUP_VERIFICATION_REQUIRED');
 if((saved.archive_source??'drive')!==row.archive_source||(saved.allow_early_export===true)!==row.allow_early_export||p.case_version!==row.case_version||p.backup_version!==row.backup_version
  ||(row.archive_source==='export'&&(saved.receipt?.job_id!==row.job_id||saved.receipt?.package_no!==row.package_no||
   saved.receipt?.confirmed_at!==row.confirmed_at||saved.receipt?.confirmed_by!==row.confirmed_by)))throw fail('MANUAL_CLEANUP_VERIFICATION_REQUIRED');
 if(await db.prepare('SELECT id FROM storage_audit WHERE id=?').bind('manual-cleanup:dispatch:'+row.file_id).first())throw fail('MANUAL_CLEANUP_PENDING');
 if(!sameObject(await env.PROOFS_BUCKET.head(row.object_key),row,p.sha256,p.r2_version))throw fail('MANUAL_CLEANUP_R2_MISMATCH');
 await authAtomic(db,[...guards(row,actor),{sql:"EXISTS(SELECT 1 FROM cold_proofs WHERE file_id=? AND state='verifying' AND lease_token=? AND verified_at=? AND sha256=? AND r2_version=?)",args:[row.file_id,p.lease_token,p.verified_at,p.sha256,p.r2_version]}],[
  db.prepare("UPDATE cold_proofs SET state='deleting',lease_token=(SELECT operation_id FROM prelaunch_reset_permit WHERE id=1),updated_at=? WHERE file_id=? AND lease_token=?").bind(at(),row.file_id,p.lease_token),
  audit(db,row,actor,'manual_cleanup_dispatch',{attempt_id:input.attempt_id,sha256:p.sha256,r2_version:p.r2_version},'manual-cleanup:dispatch:'+row.file_id)]);
 // Dispatch is durable before native DELETE; it is never retried, even after lease expiry.
 try{
  await env.PROOFS_BUCKET.delete(row.object_key);
  if(await env.PROOFS_BUCKET.head(row.object_key))throw fail('MANUAL_CLEANUP_DELETE_UNCONFIRMED',503);
  await authAtomic(db,[...guards(row,actor),{sql:"EXISTS(SELECT 1 FROM cold_proofs WHERE file_id=? AND state='deleting' AND lease_token=(SELECT operation_id FROM prelaunch_reset_permit WHERE id=1))",args:[row.file_id]},
   {sql:'EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND used_bytes>=?)',args:[row.size]}],[
   audit(db,row,actor,'manual_cleanup_deleted',{attempt_id:input.attempt_id,sha256:p.sha256,r2_version:p.r2_version},'manual-cleanup:deleted:'+row.file_id),
   db.prepare('UPDATE storage_capacity SET used_bytes=used_bytes-?,inventory_dirty=1,inventory_version=inventory_version+1 WHERE id=1').bind(row.size),
   db.prepare("UPDATE cold_proofs SET state='cold',lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=? WHERE file_id=? AND state='deleting'").bind(at(),row.file_id)]);
  return{file_id:row.file_id,state:'deleted',message:cleanedMessage(saved),released_bytes:row.size};
 }catch{return{file_id:row.file_id,state:'unknown',code:'MANUAL_CLEANUP_DELETE_UNCONFIRMED',message:'刪除結果待人工核對；已保留鎖及不可變Dispatch，不會重送。'};}
}
export async function cleanupStatus(db,fileId){
 const row=await db.prepare('SELECT state,verification_context FROM cold_proofs WHERE file_id=?').bind(fileId).first();
 return{file_id:fileId,state:row?.state==='cold'?'deleted':row?.state==='deleting'?'unknown':row?.state??'not_started',message:row?.state==='cold'?cleanedMessage(context(row)):undefined};
}
// One file per authenticated HTTP request, never an unbounded DELETE batch.
// One Operation covers verification and dispatch; uncertain writes stop here.
export async function cleanCleanup(env,actor,input,options){
 const status=await cleanupStatus(env.DB,input.file_id);
 if(status.state==='deleted')return status;
 await verifyCleanup(env,actor,input,options);
 return deleteCleanup(env,actor,input);
}
