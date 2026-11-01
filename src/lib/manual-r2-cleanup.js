import {AdminError,ELEVATED_AUTH_GUARD,actorBindings} from './admin-identity.js';
import {invalidVerification} from '../api/auth-validation.js';
import {coldContext,validColdSource} from './cold-storage.js';
import {verifyDriveArchive,ARCHIVE_RETENTION_DAYS,ARCHIVE_VERIFICATION_TTL} from './storage-archive.js';
import {r2VerifiedSha256} from './r2-verified-checksum.js';
const at=()=>Math.floor(Date.now()/1000),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(code='MANUAL_CLEANUP_BLOCKED',status=409)=>new AdminError(status,code,'圖片清理安全條件未成立；未重送刪除。');
const message='圖片已清理，備份保存在 Google Drive';
export const CLEANED_PROOF_MESSAGE=message;
// The prior valid=1 INSERT + DELETE cost three written rows per guard.
// A failed assertion still INSERTs valid=0 and aborts the entire D1 batch;
// success writes no guard row. Fence/Permit and all business writes remain.
async function authAtomic(db,guards,statements){
 try{return await db.batch([db.prepare(`INSERT INTO auth_atomic_guards(id,valid) SELECT ?,0 WHERE (${guards.map(g=>'('+g.sql+')').join(' AND ')}) IS NOT 1`).bind(crypto.randomUUID(),...guards.flatMap(g=>g.args)),...statements]);}
 catch(error){if(String(error?.message).includes('CHECK constraint failed: valid=1'))throw invalidVerification();throw error;}
}
// A legacy native operation without per-key terminal evidence blocks cleanup.
// Read-only historical UNKNOWN (r2_writes=0) is not invented into an R2 write.
const globalSafe=`NOT EXISTS(SELECT 1 FROM prelaunch_reset_operations WHERE pending_r2>0 OR (state='unknown' AND r2_writes>0))
 AND EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND anomaly IS NULL AND inventory_id IS NULL)`;
const fileSafe=`NOT EXISTS(SELECT 1 FROM storage_reservations r WHERE r.object_key=f.object_key AND r.state='reserved')
 AND NOT EXISTS(SELECT 1 FROM proof_upload_intents i WHERE i.object_key=f.object_key AND i.write_token IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM export_job_items e JOIN export_jobs j ON j.id=e.job_id WHERE e.file_id=f.id AND j.expires_at>?)
 AND NOT EXISTS(SELECT 1 FROM export_file_claims e WHERE e.file_id=f.id AND e.lease_until>?)`;
const candidateSql=`SELECT f.id file_id,c.id case_internal_id,c.case_id,c.campaign_id,c.status,c.created_at,c.updated_at,c.version case_version,
 f.size,f.object_key,b.version backup_version,b.status backup_status,p.state cleanup_state,c.reviewed_at,coalesce(c.status_updated_at,c.updated_at) closed_at,
 (b.source_object_key=f.object_key AND b.source_size=f.size AND b.source_etag=f.etag AND b.source_mime=f.content_type AND b.lease_until IS NULL AND b.drive_file_id IS NOT NULL) backup_bound,
 EXISTS(SELECT 1 FROM storage_reservations r WHERE r.object_key=f.object_key AND r.state='reserved') has_reservation,
 EXISTS(SELECT 1 FROM proof_upload_intents i WHERE i.object_key=f.object_key AND i.write_token IS NOT NULL) has_pin,
 (EXISTS(SELECT 1 FROM export_job_items e JOIN export_jobs j ON j.id=e.job_id WHERE e.file_id=f.id AND j.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR EXISTS(SELECT 1 FROM export_file_claims e WHERE e.file_id=f.id AND e.lease_until>CAST(strftime('%s','now') AS INTEGER))) has_export,
 (${globalSafe}) global_safe,
 CASE WHEN b.status='confirmed' AND b.lease_until IS NULL AND b.drive_file_id IS NOT NULL
 AND b.source_object_key=f.object_key AND b.source_size=f.size AND b.source_etag=f.etag AND b.source_mime=f.content_type
 AND c.status IN('completed','rejected','duplicate','revoked') AND c.reviewed_at IS NOT NULL
 AND julianday(coalesce(c.status_updated_at,c.updated_at))<=julianday(?,'-7 days')
 AND (p.file_id IS NULL OR p.state IN('blocked','dry_run')) AND ${fileSafe} AND ${globalSafe}
 AND NOT EXISTS(SELECT 1 FROM storage_audit a WHERE a.id='manual-cleanup:dispatch:'||f.id) THEN 1 ELSE 0 END eligible
 FROM case_files f JOIN cases c ON c.id=f.case_id LEFT JOIN proof_backups b ON b.file_id=f.id AND b.provider='google_drive'
 LEFT JOIN cold_proofs p ON p.file_id=f.id`;
function filters(url){
 const p=url.searchParams,allowed=['campaign_id','from','to','status','backup','eligible','cutoff','cursor'];
 if([...p.keys()].some(k=>!allowed.includes(k)||p.getAll(k).length!==1))throw fail('INVALID_CLEANUP_QUERY',400);
 const day=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
 const from=p.get('from'),to=p.get('to'),cutoff=p.get('cutoff')??new Date().toISOString();
 if((from&&!day(from))||(to&&!day(to))||(from&&to&&from>to)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff)||!Number.isFinite(Date.parse(cutoff))||Date.parse(cutoff)>Date.now()+1000)throw fail('INVALID_CLEANUP_QUERY',400);
 const clauses=['created_at<=?','updated_at<=?'],args=[cutoff,cutoff];
 for(const[k,values,column]of[['status',['pending','approved','completed','rejected','duplicate','revoked'],'status'],['backup',['pending','processing','confirmed','failed'],'backup_status'],['eligible',['yes','no'],'eligible']]){
  const v=p.get(k);if(v){if(!values.includes(v))throw fail('INVALID_CLEANUP_QUERY',400);clauses.push(column+'=?');args.push(k==='eligible'?Number(v==='yes'):v);}}
 const campaign=p.get('campaign_id');if(campaign){if(!/^[A-Za-z0-9_-]{1,100}$/.test(campaign))throw fail('INVALID_CLEANUP_QUERY',400);clauses.push('campaign_id=?');args.push(campaign);}
 if(from){clauses.push('created_at>=?');args.push(new Date(from+'T00:00:00+08:00').toISOString());}
 if(to){clauses.push('created_at<?');args.push(new Date(Date.parse(to+'T00:00:00+08:00')+86400000).toISOString());}
 const scope=JSON.stringify([campaign,from,to,p.get('status'),p.get('backup'),p.get('eligible'),cutoff]);
 if(p.has('cursor')){let v;try{const raw=p.get('cursor');if(raw.length>1500)throw Error();v=JSON.parse(atob(raw));}catch{throw fail('INVALID_CLEANUP_QUERY',400);}
  if(!Array.isArray(v)||v.length!==3||v[0]!==scope||typeof v[1]!=='string'||!Number.isFinite(Date.parse(v[1]))||!uuid.test(v[2]))throw fail('INVALID_CLEANUP_QUERY',400);
  clauses.push('(created_at>? OR (created_at=? AND file_id>?))');args.push(v[1],v[1],v[2]);}
 return{p,cutoff,scope,where:clauses.join(' AND '),args};
}
export async function cleanupCandidates(db,url){
 const f=filters(url),time=Math.floor(Date.parse(f.cutoff)/1000),base=[f.cutoff,f.cutoff,time];
 const query=`SELECT * FROM (${candidateSql}) WHERE ${f.where}`;
 const page=(await db.prepare(query+' ORDER BY created_at,file_id LIMIT 21').bind(...base,...f.args).all()).results;
 let summary=null;if(!f.p.has('cursor'))summary=await db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN eligible=1 THEN 1 ELSE 0 END),0) eligible_count,COALESCE(SUM(CASE WHEN eligible=1 THEN size ELSE 0 END),0) eligible_bytes FROM (${query})`).bind(...base,...f.args).first();
 const rows=page.slice(0,20),last=rows.at(-1);
 return{...summary,cutoff:f.cutoff,retention_days:ARCHIVE_RETENTION_DAYS,items:rows.map(({object_key,case_internal_id,has_reservation,has_pin,has_export,global_safe,backup_bound,...r})=>{
  const reasons=[];if(r.backup_status!=='confirmed')reasons.push('Drive備份尚未confirmed');if(!backup_bound)reasons.push('備份來源綁定不符或仍有lease');
  if(!['completed','rejected','duplicate','revoked'].includes(r.status)||!r.reviewed_at)reasons.push('案件尚未完成可清理審核');
  if(!Number.isFinite(Date.parse(r.closed_at))||Date.parse(r.closed_at)>Date.parse(f.cutoff)-86400000*ARCHIVE_RETENTION_DAYS)reasons.push('結案後尚未滿7天');
  if(has_reservation)reasons.push('有未決Reservation');if(has_pin)reasons.push('有Write Pin');if(has_export)reasons.push('有效匯出或下載lease尚未結束');
  if(!global_safe)reasons.push('未決原生R2／UNKNOWN、Inventory或容量異常尚未排除');
  if(r.cleanup_state==='verifying')reasons.push('已有驗證作業；不按逾時接管');if(r.cleanup_state==='deleting')reasons.push('DELETE結果待人工核對，不會重送');if(r.cleanup_state==='cold')reasons.push(message);
  return{...r,eligible:!!r.eligible,reason:r.eligible?'執行時仍須即時驗證Drive及R2':reasons.join('；')||'清理狀態需人工確認'};
 }),next_cursor:page.length>20?btoa(JSON.stringify([f.scope,last.created_at,last.file_id])):null};
}
export function cleanupInput(body){
 if(!body||Object.keys(body).sort().join(',')!=='attempt_id,backup_version,case_version,file_id'||!uuid.test(body.file_id??'')||!uuid.test(body.attempt_id??'')||![body.case_version,body.backup_version].every(x=>Number.isSafeInteger(x)&&x>=0))throw fail('INVALID_CLEANUP_REQUEST',400);
 return body;
}
async function readiness(env){
 if(env.R2_MANUAL_CLEANUP_ENABLED!=='true'||env.PRELAUNCH_RESET_FENCE_ENABLED!=='true'||env.R2_EXCLUSIVE_WRITER_CONFIRMED!=='true'||env.STORAGE_CLEANUP_LIVE_ENABLED==='true')throw fail('MANUAL_CLEANUP_DISABLED',503);
 const row=await env.DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name IN('manual_cleanup_cold_owner','manual_cleanup_backup_pin','manual_cleanup_file_pin','manual_cleanup_inventory_pin','manual_cleanup_export_claim_insert','manual_cleanup_export_claim_update','manual_cleanup_dispatch_guard','manual_cleanup_terminal_guard')").first();
 if(row.n!==8)throw fail('MANUAL_CLEANUP_SCHEMA_REQUIRED',503);
}
async function source(db,input){
 const f=await db.prepare('SELECT object_key FROM case_files WHERE id=?').bind(input.file_id).first();
 const r=f?await coldContext(db,f.object_key):null;
 if(!validColdSource(r)||r.file_id!==input.file_id||r.case_version!==input.case_version||r.backup_version!==input.backup_version||!['completed','rejected','duplicate','revoked'].includes(r.status)||!r.reviewed_at||!r.closed_at||Date.parse(r.closed_at)>(at()-86400*ARCHIVE_RETENTION_DAYS)*1000)throw fail();
 return r;
}
function guards(row,actor){return[
 {sql:ELEVATED_AUTH_GUARD,args:actorBindings(actor)},
 {sql:globalSafe,args:[]},
 {sql:`EXISTS(SELECT 1 FROM cases c JOIN case_files f ON f.case_id=c.id JOIN proof_backups b ON b.file_id=f.id AND b.provider='google_drive'
 WHERE f.id=? AND c.id=? AND c.version=? AND c.status=? AND coalesce(c.status_updated_at,c.updated_at)=?
 AND f.object_key=? AND f.etag=? AND f.size=? AND f.content_type=? AND b.id=? AND b.version=? AND b.status='confirmed' AND b.lease_until IS NULL
 AND b.drive_file_id=? AND b.drive_folder_id=? AND b.root_folder_id=? AND b.source_object_key=f.object_key AND b.source_size=f.size AND b.source_etag=f.etag AND b.source_mime=f.content_type AND ${fileSafe})`,
 args:[row.file_id,row.case_internal_id,row.case_version,row.status,row.closed_at,row.object_key,row.etag,row.size,row.content_type,row.backup_id,row.backup_version,row.drive_file_id,row.drive_folder_id,row.root_folder_id,new Date().toISOString(),at()]},
 ];}
const audit=(db,row,actor,action,detail,id=crypto.randomUUID())=>db.prepare('INSERT INTO storage_audit(id,created_at,action,target,detail) VALUES(?,?,?,?,?)').bind(id,at(),action,row.file_id,JSON.stringify({admin_member_id:actor.member.member_id,case_version:row.case_version,backup_version:row.backup_version,...detail}));
function context(p){try{return JSON.parse(p?.verification_context??'null');}catch{return null;}}
const sameObject=(o,row,sha,version)=>o&&o.etag===row.etag&&o.size===row.size&&o.httpMetadata?.contentType===row.content_type&&o.version&&(!version||o.version===version)&&r2VerifiedSha256(o)===sha;
export async function verifyCleanup(env,actor,input,{verify=verifyDriveArchive}={}){
 await readiness(env);const db=env.DB,row=await source(db,input),prior=await db.prepare('SELECT * FROM cold_proofs WHERE file_id=?').bind(row.file_id).first();
 if(prior&&['verifying','deleting','cold'].includes(prior.state))throw fail('MANUAL_CLEANUP_PENDING');
 if(await db.prepare('SELECT id FROM storage_audit WHERE id=?').bind('manual-cleanup:dispatch:'+row.file_id).first())throw fail('MANUAL_CLEANUP_PENDING');
 const data={manual:true,attempt_id:input.attempt_id,owner:actor.member.member_id,epoch:env.PRELAUNCH_RESET_CONTEXT?.epoch};
 await authAtomic(db,guards(row,actor),[db.prepare(`INSERT INTO cold_proofs(file_id,state,lease_token,lease_until,attempts,updated_at,verification_context)
 SELECT ?,'verifying',operation_id,?,1,?,? FROM prelaunch_reset_permit WHERE id=1 AND purpose='normal'
 ON CONFLICT(file_id) DO UPDATE SET state='verifying',lease_token=excluded.lease_token,lease_until=excluded.lease_until,attempts=attempts+1,updated_at=excluded.updated_at,verification_context=excluded.verification_context
 WHERE cold_proofs.state IN('blocked','dry_run') RETURNING file_id`).bind(row.file_id,at()+300,at(),JSON.stringify(data)),audit(db,row,actor,'manual_cleanup_verify',{attempt_id:input.attempt_id})]);
 const claim=await db.prepare('SELECT * FROM cold_proofs WHERE file_id=?').bind(row.file_id).first();
 if(context(claim)?.attempt_id!==input.attempt_id)throw fail('MANUAL_CLEANUP_PENDING');
 try{
  const object=await env.PROOFS_BUCKET.head(row.object_key),sha=r2VerifiedSha256(object);
  if(!sha||!sameObject(object,row,sha)||row.known_sha&&row.known_sha!==sha)throw fail('MANUAL_CLEANUP_R2_MISMATCH');
  const v=await verify(env,row,sha),verifiedAt=v.verified_at;
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
 await readiness(env);const db=env.DB,row=await source(db,input),p=await db.prepare('SELECT * FROM cold_proofs WHERE file_id=?').bind(row.file_id).first(),saved=context(p);
 if(p?.state==='cold')return{file_id:row.file_id,state:'deleted',message};
 if(p?.state!=='verifying'||saved?.manual!==true||saved.attempt_id!==input.attempt_id||saved.owner!==actor.member.member_id||saved.epoch!==env.PRELAUNCH_RESET_CONTEXT?.epoch||!p.verified_at||at()-p.verified_at>ARCHIVE_VERIFICATION_TTL)throw fail('MANUAL_CLEANUP_VERIFICATION_REQUIRED');
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
  return{file_id:row.file_id,state:'deleted',message,released_bytes:row.size};
 }catch{return{file_id:row.file_id,state:'unknown',code:'MANUAL_CLEANUP_DELETE_UNCONFIRMED',message:'刪除結果待人工核對；已保留鎖及不可變Dispatch，不會重送。'};}
}
export async function cleanupStatus(db,fileId){
 const row=await db.prepare('SELECT state,error_code,verified_at,updated_at FROM cold_proofs WHERE file_id=?').bind(fileId).first();
 return{file_id:fileId,state:row?.state==='cold'?'deleted':row?.state==='deleting'?'unknown':row?.state??'not_started',message:row?.state==='cold'?message:undefined};
}
// One file per authenticated HTTP request, never an unbounded DELETE batch.
// One Operation covers verification and dispatch; uncertain writes stop here.
export async function cleanCleanup(env,actor,input,options){
 const status=await cleanupStatus(env.DB,input.file_id);
 if(status.state==='deleted')return{...status,message};
 await verifyCleanup(env,actor,input,options);
 return deleteCleanup(env,actor,input);
}
