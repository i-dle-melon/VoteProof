import {AdminError,REVIEW_AUTH_GUARD,actorBindings} from './admin-identity.js';
import {authAtomic} from './auth-store.js';
export const EXPORT_LEASE_SECONDS=1800;
const now=()=>Math.floor(Date.now()/1000);
const guard=actor=>({sql:REVIEW_AUTH_GUARD,args:actorBindings(actor)});
const readyDatabases=new WeakSet();
export const exportConflict=()=>new AdminError(409,'EXPORT_PACKAGE_CONFLICT','其他管理員正在處理；請稍後重新讀取工作。');
export function exportAudit(db,actor,job,number,action,attempt=null){
 return db.prepare('INSERT INTO export_operation_audit VALUES(?,?,?,?,?,?,?)')
  .bind(crypto.randomUUID(),new Date().toISOString(),actor.member.member_id,job.id,number,action,attempt);
}
export async function requireExportV2(db){
 if(readyDatabases.has(db))return;
 if(!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='export_completed_files'").first())
  throw new AdminError(503,'EXPORT_SCHEMA_NOT_READY','共用匯出尚未完成資料庫更新。');
 // Schema capability only, never identity/roles/leases. Negative results are not
 // cached, allowing an additive migration without waiting for an isolate reset.
 readyDatabases.add(db);
}
export async function startExportPackage(db,actor,job,number,b){
 const p=await db.prepare('SELECT * FROM export_packages WHERE job_id=? AND number=?').bind(job.id,number).first();
 if(!p)throw exportConflict();
 if(p.status==='completed'){
  if(p.attempt_id!==b.expected_attempt_id)throw exportConflict();
  const t=now(),member=actor.member.member_id;
  const free={sql:`NOT EXISTS(SELECT 1 FROM export_job_items i JOIN export_file_claims l ON l.file_id=i.file_id
    WHERE i.job_id=? AND i.package_no=? AND l.lease_until>? AND NOT(l.job_id=? AND l.package_no=? AND l.attempt_id=? AND l.member_id=?))`,
    args:[job.id,number,t,job.id,number,b.attempt_id,member]};
  try{await authAtomic(db,[guard(actor),free],[db.prepare(`INSERT INTO export_file_claims
    SELECT file_id,job_id,package_no,?,?,? FROM export_job_items WHERE job_id=? AND package_no=?
    ON CONFLICT(file_id) DO UPDATE SET job_id=excluded.job_id,package_no=excluded.package_no,attempt_id=excluded.attempt_id,member_id=excluded.member_id,lease_until=excluded.lease_until`)
    .bind(b.attempt_id,member,t+EXPORT_LEASE_SECONDS,job.id,number),exportAudit(db,actor,job,number,'redownload',b.attempt_id)]);}catch{throw exportConflict();}
  return {package:p,read_only:true,download_attempt_id:b.attempt_id};
 }
 const t=now(),member=actor.member.member_id;
 const available={sql:`EXISTS(SELECT 1 FROM export_packages WHERE job_id=? AND number=? AND status!='completed'
  AND (attempt_id IS ? OR attempt_id=?) AND (status!='in_progress' OR lease_until<=? OR (attempt_id=? AND claim_member_id=?)))
  AND NOT EXISTS(SELECT 1 FROM export_job_items i JOIN export_file_claims l ON l.file_id=i.file_id
    WHERE i.job_id=? AND i.package_no=? AND l.lease_until>? AND NOT(l.job_id=? AND l.package_no=? AND l.attempt_id=? AND l.member_id=?))`,
 args:[job.id,number,b.expected_attempt_id,b.attempt_id,t,b.attempt_id,member,job.id,number,t,job.id,number,b.attempt_id,member]};
 try{await authAtomic(db,[guard(actor),available],[
  db.prepare(`INSERT INTO export_file_claims(file_id,job_id,package_no,attempt_id,member_id,lease_until)
   SELECT file_id,job_id,package_no,?,?,? FROM export_job_items WHERE job_id=? AND package_no=?
   ON CONFLICT(file_id) DO UPDATE SET job_id=excluded.job_id,package_no=excluded.package_no,attempt_id=excluded.attempt_id,
   member_id=excluded.member_id,lease_until=excluded.lease_until`).bind(b.attempt_id,member,t+EXPORT_LEASE_SECONDS,job.id,number),
  db.prepare("UPDATE export_packages SET status='in_progress',attempt_id=?,claim_member_id=?,lease_until=?,started_at=?,error_code=NULL WHERE job_id=? AND number=?")
   .bind(b.attempt_id,member,t+EXPORT_LEASE_SECONDS,new Date().toISOString(),job.id,number),
  exportAudit(db,actor,job,number,'start',b.attempt_id),
 ]);}catch{throw exportConflict();}
 return {package:await db.prepare('SELECT * FROM export_packages WHERE job_id=? AND number=?').bind(job.id,number).first(),read_only:false};
}
export async function finishExportPackage(db,actor,job,number,b){
 const p=await db.prepare('SELECT * FROM export_packages WHERE job_id=? AND number=?').bind(job.id,number).first();
 if(p?.status==='completed'&&p.attempt_id!==b.attempt_id){
  const member=actor.member.member_id;
  const prior=await db.prepare('SELECT 1 FROM export_operation_audit WHERE job_id=? AND package_no=? AND member_id=? AND attempt_id=? AND action=?')
    .bind(job.id,number,member,b.attempt_id,b.status).first();if(prior)return p;
  const owns={sql:`NOT EXISTS(SELECT 1 FROM export_job_items i LEFT JOIN export_file_claims l ON l.file_id=i.file_id
    WHERE i.job_id=? AND i.package_no=? AND (l.file_id IS NULL OR l.job_id!=? OR l.package_no!=? OR l.member_id!=? OR l.attempt_id!=? OR l.lease_until<=?))`,
    args:[job.id,number,job.id,number,member,b.attempt_id,now()]};
  try{await authAtomic(db,[guard(actor),owns],[db.prepare('DELETE FROM export_file_claims WHERE job_id=? AND package_no=? AND attempt_id=? AND member_id=?')
    .bind(job.id,number,b.attempt_id,member),exportAudit(db,actor,job,number,b.status,b.attempt_id)]);}catch{throw exportConflict();}
  return p; // Re-download never downgrades the immutable completed package.
 }
 if(!p||p.attempt_id!==b.attempt_id||p.claim_member_id!==actor.member.member_id)throw exportConflict();
 // A repeated completion ACK is a read-only replay, never another award/record.
 if(p.status===b.status)return p;
 const member=actor.member.member_id,t=now();
 const valid={sql:`EXISTS(SELECT 1 FROM export_packages WHERE job_id=? AND number=? AND status='in_progress'
   AND attempt_id=? AND claim_member_id=? AND lease_until>?)
   AND NOT EXISTS(SELECT 1 FROM export_job_items i LEFT JOIN case_files f ON f.id=i.file_id
   LEFT JOIN export_file_claims l ON l.file_id=i.file_id WHERE i.job_id=? AND i.package_no=? AND
    (f.id IS NULL OR f.size!=i.file_size OR f.etag IS NOT i.etag OR f.content_type!=i.content_type OR
     l.file_id IS NULL OR l.job_id!=? OR l.package_no!=? OR l.attempt_id!=? OR l.member_id!=? OR l.lease_until<=?))`,
 args:[job.id,number,b.attempt_id,member,t,job.id,number,job.id,number,b.attempt_id,member,t]};
 const writes=[];
 if(b.status==='completed')writes.push(db.prepare(`INSERT INTO export_completed_files
  SELECT i.file_id,i.etag,i.file_size,i.content_type,i.job_id,i.package_no,?,? FROM export_job_items i WHERE i.job_id=? AND i.package_no=?
   AND NOT EXISTS(SELECT 1 FROM export_completed_files d WHERE d.file_id=i.file_id AND d.etag=i.etag AND d.file_size=i.file_size AND d.content_type=i.content_type)`)
   .bind(member,new Date().toISOString(),job.id,number));
 writes.push(db.prepare("UPDATE export_packages SET status=?,completed_at=CASE WHEN ?='completed' THEN ? ELSE NULL END,error_code=?,lease_until=NULL WHERE job_id=? AND number=?")
  .bind(b.status,b.status,new Date().toISOString(),b.status==='failed'?(b.error_code??'EXPORT_DOWNLOAD_FAILED'):null,job.id,number),
  db.prepare('DELETE FROM export_file_claims WHERE job_id=? AND package_no=? AND attempt_id=? AND member_id=?').bind(job.id,number,b.attempt_id,member),
  exportAudit(db,actor,job,number,b.status,b.attempt_id));
 try{await authAtomic(db,[guard(actor),valid],writes);}catch{throw exportConflict();}
 return {...p,status:b.status};
}
