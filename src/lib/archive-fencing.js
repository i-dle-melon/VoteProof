import {AdminError} from './admin-identity.js';
import {authAtomic} from './auth-store.js';
import {nowSeconds} from './storage-capacity.js';
export const WRITER_POLICY='create_only_v1';
const denied=()=>new AdminError(409,'STORAGE_ARCHIVE_PAUSED','清理已暫停、正在排空，或寫入安全證據無效。');
export function archiveFenceGuard(epoch){return{
  sql:"EXISTS(SELECT 1 FROM storage_archive_control WHERE id=1 AND mode='running' AND epoch=? AND writer_policy=? AND verified_until>CAST(strftime('%s','now') AS INTEGER) AND length(evidence_hash)=64) AND NOT EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed')",args:[epoch,WRITER_POLICY]};}
export async function archiveAdmission(env){
  if(env.R2_EXCLUSIVE_WRITER_CONFIRMED!=='true')throw denied();
  const row=await env.DB.prepare("SELECT epoch,mode,writer_policy,evidence_hash,verified_until FROM storage_archive_control WHERE id=1 AND NOT EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed') AND NOT EXISTS(SELECT 1 FROM cold_proofs WHERE state='deleting')").first();
  if(!row||row.mode!=='running'||row.writer_policy!==WRITER_POLICY||!/^[a-f0-9]{64}$/.test(row.evidence_hash??'')||row.verified_until<=nowSeconds())throw denied();
  return row.epoch;
}
const audit=(db,action,detail)=>db.prepare('INSERT INTO storage_audit VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),nowSeconds(),action,'archive-control',JSON.stringify(detail));
export function validateWriterEvidence(e){
  const now=nowSeconds(),keys=['bindings','s3_credentials','multipart','presigned','inflight_puts','external_tools','other_workers'];
  if(!e||Object.keys(e).some(k=>!['sha256','verified_until','checks'].includes(k))||!/^[a-f0-9]{64}$/.test(e.sha256??'')||
     !Number.isSafeInteger(e.verified_until)||e.verified_until<=now||e.verified_until>now+3600||!e.checks||Object.keys(e.checks).length!==keys.length||keys.some(k=>e.checks[k]!==true))throw denied();
  return e;
}
export async function archiveControlStatus(db){
  const row=await db.prepare('SELECT epoch,mode,writer_policy,verified_until,updated_at FROM storage_archive_control WHERE id=1').first();
  if(!row)throw denied();
  const pending=await db.prepare("SELECT (SELECT count(*) FROM storage_archive_dispatches WHERE state!='completed') AS dispatches,(SELECT count(*) FROM cold_proofs WHERE state='deleting') AS deleting").first();
  return{...row,...pending,drained:row.mode==='paused'&&pending.dispatches===0&&pending.deleting===0};
}
export async function changeArchiveControl(db,input,authGuards=[],actor=null){
  const {action,expected_epoch,confirmed}=input??{};
  if(!['pause','resume','settle'].includes(action)||!Number.isSafeInteger(expected_epoch)||expected_epoch<1||confirmed!==true)throw denied();
  const now=nowSeconds(),guards=[...authGuards,{sql:'EXISTS(SELECT 1 FROM storage_archive_control WHERE id=1 AND epoch=?)',args:[expected_epoch]}];
  let statement,detail={action,previous_epoch:expected_epoch,actor:actor??{kind:'system'}};
  if(action==='pause'){
    statement=db.prepare("UPDATE storage_archive_control SET mode=CASE WHEN EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed') OR EXISTS(SELECT 1 FROM cold_proofs WHERE state='deleting') THEN 'draining' ELSE 'paused' END,epoch=epoch+1,updated_at=? WHERE id=1").bind(now);
  }else if(action==='settle'){
    guards.push({sql:"NOT EXISTS(SELECT 1 FROM storage_archive_control WHERE mode='running') AND NOT EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed') AND NOT EXISTS(SELECT 1 FROM cold_proofs WHERE state='deleting')",args:[]});
    statement=db.prepare("UPDATE storage_archive_control SET mode='paused',epoch=epoch+1,updated_at=? WHERE id=1").bind(now);
  }else{
    // A reviewed evidence-document hash, NOT an automated proof of Cloudflare
    // account configuration. Operator must independently obtain every check.
    const e=validateWriterEvidence(input.writer_evidence);
    guards.push({sql:"NOT EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed') AND NOT EXISTS(SELECT 1 FROM cold_proofs WHERE state='deleting') AND EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND reserved_bytes=0 AND inventory_id IS NULL AND anomaly IS NULL AND trusted_until>CAST(strftime('%s','now') AS INTEGER)) AND NOT EXISTS(SELECT 1 FROM proof_upload_intents WHERE write_token IS NOT NULL)",args:[]});
    statement=db.prepare("UPDATE storage_archive_control SET mode='running',epoch=epoch+1,writer_policy=?,evidence_hash=?,verified_until=?,updated_at=? WHERE id=1").bind(WRITER_POLICY,e.sha256,e.verified_until,now);
    detail={...detail,writer_policy:WRITER_POLICY,evidence_hash:e.sha256,verified_until:e.verified_until};
  }
  await authAtomic(db,guards,[statement,audit(db,'archive_control_'+action,detail)]);
  return archiveControlStatus(db);
}
export const dispatchStatement=(db,row,token,epoch)=>db.prepare("INSERT INTO storage_archive_dispatches(token,file_id,epoch,state,created_at) VALUES(?,?,?,'reserved',?)").bind(token,row.file_id,epoch,nowSeconds());
export const dispatchComplete=(db,token)=>db.prepare("UPDATE storage_archive_dispatches SET state='completed',completed_at=? WHERE token=? AND state IN('reserved','ambiguous')").bind(nowSeconds(),token);
export async function ambiguousDispatch(db,token){
  // A failed write here leaves 'reserved', which is equally blocking.
  await db.prepare("UPDATE storage_archive_dispatches SET state='ambiguous' WHERE token=? AND state='reserved'").bind(token).run().catch(()=>{});
}
