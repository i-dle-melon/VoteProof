// Storage plan A: verified Drive archive, no synchronous Drive -> Worker image reads.
// Production stays dry-run unless a separate, explicit server-only live flag is enabled.
import { AdminError } from './admin-identity.js';
import { authAtomic } from './auth-store.js';
import { boundedJson, scriptPost, coldContext, validColdSource, shaBytes } from './cold-storage.js';
import { STORAGE, capacityRow, nowSeconds } from './storage-capacity.js';
import { r2VerifiedSha256 } from './r2-verified-checksum.js';

export const ARCHIVE_RETENTION_DAYS = 7;
export const ARCHIVE_VERIFICATION_TTL = 120;
const fail = () => new AdminError(503, 'STORAGE_ARCHIVE_UNAVAILABLE', '儲存空間清理暫時無法執行。');
const live = env => env.STORAGE_CLEANUP_LIVE_ENABLED === 'true';

export async function verifyDriveArchive(env, row, sha, { fetcher = fetch } = {}) {
  if (!validColdSource(row) || !/^[a-f0-9]{64}$/.test(sha) ||
      !/^[a-f0-9]{64}$/.test(env.DRIVE_BACKUP_RELAY_SECRET ?? '')) throw fail();
  // One request-scoped key serves both directions; native verify retains a
  // constant-time MAC check without reimporting the same secret a second time.
  const encoder=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.DRIVE_BACKUP_RELAY_SECRET),
    {name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  const nonce = crypto.randomUUID(), timestamp = nowSeconds();
  const request = {version: 1, purpose: 'archive_verify', nonce, timestamp,
    file_id: row.drive_file_id, expected_sha256: sha, expected_size: row.size};
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(
    JSON.stringify(['VoteProof/archive-verify', request.version, request.purpose,
      nonce, timestamp, request.file_id, sha, row.size]))));
  request.signature=btoa(String.fromCharCode(...mac)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  const reply = await boundedJson(await scriptPost(env.DRIVE_COLD_RELAY_URL, request, fetcher), 4096);
  if (reply.nonce !== nonce || !Number.isSafeInteger(reply.timestamp) ||
      Math.abs(nowSeconds() - reply.timestamp) > 120 ||
      typeof reply.payload !== 'string' || reply.payload.length > 2048 ||
      typeof reply.signature !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(reply.signature)) throw fail();
  const signature=Uint8Array.from(atob(reply.signature.replaceAll('-','+').replaceAll('_','/')+'='),c=>c.charCodeAt(0));
  if(!await crypto.subtle.verify('HMAC',key,signature,encoder.encode(
    JSON.stringify(['VoteProof/archive-verified-result',nonce,reply.timestamp,reply.payload]))))throw fail();
  let p;
  try { p = JSON.parse(reply.payload); } catch { throw fail(); }
  if (!p || p.file_id !== row.drive_file_id || p.sha256 !== sha ||
      p.size !== row.size || p.mime !== row.content_type ||
      p.name !== row.case_id + '.' + ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[row.content_type]) ||
      p.folder_id !== row.drive_folder_id || p.campaign_folder_id !== row.campaign_folder_id ||
      p.root_folder_id !== row.root_folder_id ||
      p.case_id !== row.case_id || p.proof_id !== row.file_id ||
      p.campaign_key_hash !== await shaBytes(new TextEncoder().encode(row.campaign_key)) ||
      p.date_key_hash !== await shaBytes(new TextEncoder().encode(row.date_key)))
    throw fail();
  return {sha256:sha, verified_at:reply.timestamp, receipt:reply};
}
const eligible = (row, at) => {
  if (!validColdSource(row) || !['completed','rejected','revoked'].includes(row.status) ||
      !row.reviewed_at || !row.closed_at) return false;
  const close = Date.parse(row.closed_at);
  return Number.isFinite(close) && close <= (at - ARCHIVE_RETENTION_DAYS * 86400) * 1000;
};
const guard = (row, token, at, expectState) => [
  {sql: "EXISTS(SELECT 1 FROM cases WHERE id=? AND version=? AND status IN('completed','rejected','revoked') AND reviewed_at IS NOT NULL AND coalesce(status_updated_at,updated_at)=?)",
    args:[row.case_internal_id,row.case_version,row.closed_at]},
  {sql: "EXISTS(SELECT 1 FROM proof_backups WHERE id=? AND version=? AND status='confirmed' AND lease_until IS NULL)",
    args:[row.backup_id,row.backup_version]},
  {sql: "NOT EXISTS(SELECT 1 FROM storage_reservations WHERE object_key=? AND state='reserved')",
    args:[row.object_key]},
  {sql: "NOT EXISTS(SELECT 1 FROM export_job_items i JOIN export_jobs j ON j.id=i.job_id WHERE i.file_id=? AND j.expires_at>?)",
    args:[row.file_id,new Date(at*1000).toISOString()]},
  {sql: "EXISTS(SELECT 1 FROM cold_proofs WHERE file_id=? AND state=? AND lease_token=? AND lease_until>?)",
    args:[row.file_id,expectState,token,at]},
  {sql: "EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND inventory_id IS NULL AND reserved_bytes=0 AND anomaly IS NULL)",
    args:[]},
];
const audit = (db, now, action, row, sha) => db.prepare(
  'INSERT INTO storage_audit(id,created_at,action,target,detail) VALUES(?,?,?,?,?)')
  .bind(crypto.randomUUID(),now,action,row.file_id,
    JSON.stringify({backup_id:row.backup_id,source_version:row.etag,verified_sha256:sha,retention_days:ARCHIVE_RETENTION_DAYS}));

async function markCold(db, row, token, sha, at) {
  const statements = [
    db.prepare("UPDATE cold_proofs SET state='cold',lease_token=NULL,lease_until=NULL,updated_at=?,error_code=NULL WHERE file_id=? AND state='deleting' AND lease_token=?")
      .bind(at,row.file_id,token),
    audit(db,at,'archive_r2_deleted',row,sha),
  ];
  await authAtomic(db,guard(row,token,at,'deleting'),statements);
}
// Canonical, server-owned binding. A receipt is never a client deletion token.
const verificationContext = row => JSON.stringify([
  row.file_id,row.object_key,row.size,row.content_type,row.etag,row.case_internal_id,
  row.case_id,row.status,row.reviewed_at,row.closed_at,row.case_version,row.backup_id,
  row.backup_status,row.backup_version,row.drive_file_id,row.drive_folder_id,
  row.root_folder_id,row.source_object_key,row.source_size,row.source_mime,
  row.source_etag,row.campaign_folder_id,row.campaign_key,row.date_key,row.known_sha
]);
async function archiveOne(env, {previewOnly = false, read = verifyDriveArchive} = {}) {
  const db=env.DB,at=nowSeconds();
  if(env.R2_EXCLUSIVE_WRITER_CONFIRMED !== 'true') throw fail();
  const cap=await capacityRow(db);
  if (!cap || cap.anomaly || cap.inventory_id || cap.reserved_bytes || cap.trusted_until <= at) throw fail();
  if (cap.used_bytes < STORAGE.cleanupStart && !cap.cleanup_requested) return {state:'idle',deleted:0};
  if (cap.used_bytes <= STORAGE.target) return {state:'target_reached',deleted:0};
  const rowKey=await db.prepare(
    "SELECT f.object_key FROM case_files f JOIN cases c ON c.id=f.case_id JOIN proof_backups b ON b.file_id=f.id AND b.provider='google_drive' AND b.status='confirmed' LEFT JOIN cold_proofs p ON p.file_id=f.id "+
    "WHERE c.status IN('completed','rejected','revoked') AND c.reviewed_at IS NOT NULL AND julianday(coalesce(c.status_updated_at,c.updated_at))<=julianday('now','-7 days') "+
    "AND (p.file_id IS NULL OR p.state='dry_run' OR (p.state='blocked' AND p.updated_at<?) OR (p.state IN('verifying','deleting') AND p.lease_until<?)) "+
    "ORDER BY CASE WHEN p.verification_context IS NOT NULL THEN 0 ELSE 1 END,coalesce(c.status_updated_at,c.updated_at),f.id LIMIT 1")
    .bind(at-86400,at).first();
  if(!rowKey) return {state:'no_eligible_proofs',deleted:0};
  const row=await coldContext(db,rowKey.object_key);
  if(!eligible(row,at)) throw fail();
  const prev=await db.prepare('SELECT * FROM cold_proofs WHERE file_id=?').bind(row.file_id).first();
  const oldDeleting=prev?.state==='deleting',context=verificationContext(row);
  let saved;try{saved=JSON.parse(prev?.verification_context??'null');}catch{}
  const ready=prev && ['verifying','deleting'].includes(prev.state) && saved?.source===context &&
    Number.isSafeInteger(prev.verified_at) && prev.verified_at<=at && at-prev.verified_at<=ARCHIVE_VERIFICATION_TTL &&
    /^[a-f0-9]{64}$/.test(prev.sha256??'') && prev.etag===row.etag && prev.size===row.size && prev.r2_version &&
    prev.case_version===row.case_version && prev.backup_version===row.backup_version;
  const phase=ready?'delete':'verify',token=crypto.randomUUID();
  const claim=await db.prepare(
    "INSERT INTO cold_proofs(file_id,state,lease_token,lease_until,attempts,updated_at) VALUES(?,'verifying',?,?,1,?) "+
    "ON CONFLICT(file_id) DO UPDATE SET state=CASE WHEN cold_proofs.state='deleting' THEN 'deleting' ELSE 'verifying' END,lease_token=excluded.lease_token,lease_until=excluded.lease_until,attempts=attempts+1,updated_at=excluded.updated_at "+
    "WHERE state='dry_run' OR (state='blocked' AND updated_at<?) OR (state IN('verifying','deleting') AND lease_until<?) RETURNING file_id,state")
    .bind(row.file_id,token,at+300,at,at-86400,at).first();
  if(!claim) return {state:'busy',deleted:0,phase};
  let destructive=false,stage='head';
  try {
    let obj=await env.PROOFS_BUCKET.head(row.object_key);
    const missingRecovery=!obj&&oldDeleting&&prev?.sha256&&prev.etag===row.etag&&prev.size===row.size&&prev.r2_version&&
      prev.case_version===row.case_version&&prev.backup_version===row.backup_version;
    const sha=missingRecovery?prev.sha256:r2VerifiedSha256(obj),version=missingRecovery?prev.r2_version:obj?.version;
    if(!missingRecovery&&(!obj||obj.etag!==row.etag||obj.size!==row.size||obj.httpMetadata?.contentType!==row.content_type||
      !version||!sha||(row.known_sha&&row.known_sha!==sha)))throw fail();
    if(oldDeleting&&(prev.r2_version!==version||prev.sha256!==sha||prev.etag!==row.etag||prev.size!==row.size||
      prev.case_version!==row.case_version||prev.backup_version!==row.backup_version))throw fail();
    if(phase==='verify'){
      stage='drive_verify';const verified=await read(env,row,sha);
      const verifiedAt=verified.verified_at??nowSeconds();
      if(!Number.isSafeInteger(verifiedAt)||verifiedAt>nowSeconds()||nowSeconds()-verifiedAt>ARCHIVE_VERIFICATION_TTL||verified.sha256!==sha)throw fail();
      stage='recheck';obj=await env.PROOFS_BUCKET.head(row.object_key);
      if(missingRecovery?!!obj:(!obj||obj.version!==version||obj.etag!==row.etag||obj.size!==row.size||
        obj.httpMetadata?.contentType!==row.content_type||r2VerifiedSha256(obj)!==sha))throw fail();
      const dry=!live(env)||previewOnly;
      await authAtomic(db,guard(row,token,nowSeconds(),claim.state),[
        db.prepare("UPDATE cold_proofs SET state=?,sha256=?,r2_version=?,etag=?,size=?,case_version=?,backup_version=?,verified_at=?,verification_context=?,lease_until=0,updated_at=?,error_code=NULL WHERE file_id=? AND lease_token=?")
          .bind(oldDeleting?'deleting':dry?'dry_run':'verifying',sha,version,row.etag,row.size,row.case_version,row.backup_version,verifiedAt,
            JSON.stringify({source:context,receipt:verified.receipt??null}),nowSeconds(),row.file_id,token),
        audit(db,nowSeconds(),dry?'archive_dry_run':'archive_verified',row,sha)
      ]);
      return {state:dry?'dry_run':'verification_ready',would_delete:dry?1:0,deleted:0,size:row.size,file_id:row.file_id,phase};
    }
    // B consumes only the durable evidence verified by A; no Drive round trip.
    if(sha!==prev.sha256||version!==prev.r2_version)throw fail();
    if(!live(env)||previewOnly)return {state:'delete_pending',deleted:0,phase};
    if(missingRecovery){await markCold(db,row,token,sha,nowSeconds());return {state:'cold_reconciled',deleted:0,size:row.size,file_id:row.file_id,phase};}
    stage='claim';
    await authAtomic(db,guard(row,token,nowSeconds(),claim.state),[
      db.prepare("UPDATE cold_proofs SET state='deleting',updated_at=? WHERE file_id=? AND lease_token=?").bind(nowSeconds(),row.file_id,token),
      audit(db,nowSeconds(),'archive_delete_claim',row,sha)
    ]);
    stage='last_head';const last=await env.PROOFS_BUCKET.head(row.object_key);
    if(!last||last.version!==version||last.etag!==row.etag||last.size!==row.size||
      last.httpMetadata?.contentType!==row.content_type||r2VerifiedSha256(last)!==sha||nowSeconds()-prev.verified_at>ARCHIVE_VERIFICATION_TTL)throw fail();
    stage='delete';destructive=true;await env.PROOFS_BUCKET.delete(row.object_key);
    stage='confirm';if(await env.PROOFS_BUCKET.head(row.object_key))throw fail();
    stage='commit';await markCold(db,row,token,sha,nowSeconds());
    return {state:'cold',deleted:1,size:row.size,file_id:row.file_id,phase};
  }catch{
    if(!destructive){
      const old=await db.prepare("SELECT state FROM cold_proofs WHERE file_id=? AND lease_token=?").bind(row.file_id,token).first();
      if(old?.state==='verifying')await db.prepare("UPDATE cold_proofs SET state='blocked',lease_token=NULL,lease_until=NULL,verification_context=NULL,error_code=?,updated_at=? WHERE file_id=? AND lease_token=?")
        .bind('VERIFY_'+stage.toUpperCase(),nowSeconds(),row.file_id,token).run();
    }
    await db.prepare("INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,?,'cleanup_failed',?) ON CONFLICT(episode,kind) DO NOTHING")
      .bind(crypto.randomUUID(),cap.episode,nowSeconds()).run().catch(()=>{});
    return {state:destructive?'delete_ambiguous':'blocked',deleted:0,phase};
  }
}
export async function cleanupArchive(env,options={}) {
  try{return {...await archiveOne(env,options),retention_days:ARCHIVE_RETENTION_DAYS,mode:live(env)&&!options.previewOnly?'live':'dry-run'};}
  catch{return {state:'unavailable',deleted:0,retention_days:ARCHIVE_RETENTION_DAYS,mode:'dry-run'};}
}
