import { jsonSuccess, jsonError } from './response.js';
import { readUploadJson, UPLOAD_LIMITS, MIME_EXTENSIONS } from './upload-validation.js';
import { UUID_PATTERN } from './admin-validation.js';
import { authenticateRelay, RelayError } from '../lib/drive-backup-relay.js';
import { DRIVE_ID, BackupError } from '../lib/google-drive.js';
import { backupRoute } from '../lib/proof-backup-processor.js';
import { seconds, MAX_BACKUP_ATTEMPTS, backoff } from '../lib/proof-backup-store.js';
import { authAtomic } from '../lib/auth-store.js';
export const RELAY_LEASE_SECONDS = 600;
const fail = (status, code) => { throw new RelayError(status, code); };
const exact = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail(400, 'INVALID_RELAY_REQUEST'); };
const idValue = v => { if (typeof v !== 'string' || !DRIVE_ID.test(v)) fail(400, 'INVALID_RELAY_REQUEST'); };
const context = (db, id) => db.prepare(`SELECT b.*,c.case_id,c.campaign_id,c.created_at AS case_created_at,
 p.name AS campaign_name,p.campaign_timezone,f.object_key AS actual_key,f.size AS actual_size,
 f.content_type AS actual_mime,f.etag AS actual_etag FROM proof_backups b JOIN case_files f ON f.id=b.file_id
 JOIN cases c ON c.id=f.case_id JOIN campaigns p ON p.campaign_id=c.campaign_id WHERE b.id=?`).bind(id).first();
const source = row => {
  if (row.source_object_key !== row.actual_key || row.source_size !== row.actual_size || row.source_mime !== row.actual_mime || row.source_etag !== row.actual_etag ||
    !MIME_EXTENSIONS[row.source_mime] || row.source_size < 1 || row.source_size > UPLOAD_LIMITS.maxFileBytes) fail(409, 'RELAY_SOURCE_CHANGED');
  return backupRoute(row);
};
function receipt(v) {
  if (!UUID_PATTERN.test(v.lease_token ?? '') || !Number.isSafeInteger(v.attempt) || v.attempt < 1 || v.attempt > MAX_BACKUP_ATTEMPTS) fail(400, 'INVALID_RELAY_REQUEST');
}
function owned(row, v, completed = false) {
  receipt(v);
  if (!row) fail(404, 'RELAY_JOB_NOT_FOUND');
  if (row.lease_token !== v.lease_token || row.attempts !== v.attempt) fail(409, 'RELAY_LEASE_CONFLICT');
  if (!completed && (row.status !== 'processing' || row.lease_until <= seconds())) fail(409, 'RELAY_LEASE_EXPIRED');
}
const active = (id, v) => ({sql:"EXISTS(SELECT 1 FROM proof_backups WHERE id=? AND status='processing' AND lease_token=? AND attempts=? AND lease_until>?)",args:[id,v.lease_token,v.attempt,seconds()]});
const safeJob = row => { const route = source(row); return { backup_id:row.id,case_id:row.case_id,proof_id:row.file_id,filename:route.name,mime:row.source_mime,size:row.source_size,
  lease_token:row.lease_token,attempt:row.attempts,lease_until:row.lease_until,root_folder_id:row.root_folder_id,
  campaign_key:route.campaignKey,date_key:route.dateKey,campaign_name:route.campaignName,date:route.day,
  drive_file_id:row.drive_file_id,drive_folder_id:row.drive_folder_id }; };
async function claim(env, _url, request) {
  const v=await readUploadJson(request);exact(v,['request_id','root_folder_id']);if(!UUID_PATTERN.test(v.request_id??''))fail(400,'INVALID_RELAY_REQUEST');idValue(v.root_folder_id);
  const db=env.DB,now=seconds();
  // Only the genuinely empty path is read-only. Include all existing request
  // IDs (root/replay checks still apply) and expired exhausted leases. A job
  // arriving after this read is picked up by the next poll; no lease is lost.
  const work=await db.prepare(`SELECT b.id,b.status,b.attempts,b.next_attempt_at,b.lease_until,b.root_folder_id
    FROM (SELECT 1) anchor LEFT JOIN proof_backups b ON b.lease_token=? WHERE b.id IS NOT NULL OR
    EXISTS(SELECT 1 FROM proof_backups WHERE status='processing' AND lease_until<=? AND attempts>=?) OR
    EXISTS(SELECT 1 FROM proof_backups WHERE attempts<? AND
      ((status IN('pending','failed') AND next_attempt_at IS NOT NULL AND next_attempt_at<=?)
       OR (status='processing' AND lease_until<=?)) AND (root_folder_id IS NULL OR root_folder_id=?))`)
    .bind(v.request_id,now,MAX_BACKUP_ATTEMPTS,MAX_BACKUP_ATTEMPTS,now,now,v.root_folder_id).first();
  if(!work)return jsonSuccess({state:'idle'});
  // Bound maintenance to one exhausted lease per tick. Same terminal policy as
  // claimBackupStatement: no ninth attempt, no retry, sanitized INTERNAL fallback.
  await db.prepare(`UPDATE proof_backups SET status='failed',next_attempt_at=NULL,
    lease_token=NULL,lease_until=NULL,last_error_code=coalesce(last_error_code,'INTERNAL'),version=version+1
    WHERE id IN (SELECT id FROM proof_backups WHERE status='processing' AND lease_until<=?
      AND attempts>=? ORDER BY lease_until,id LIMIT 1)`).bind(now,MAX_BACKUP_ATTEMPTS).run();
  let row=work.id?work:null;
  if(row){
    if(row.root_folder_id!==v.root_folder_id)fail(409,'RELAY_ROOT_CONFLICT');
    if(row.status==='confirmed')return jsonSuccess({state:'already_confirmed',backup_id:row.id});
    if(row.status==='failed')return jsonSuccess({state:'failed',backup_id:row.id,next_attempt_at:row.next_attempt_at});
    if(row.status==='processing'&&row.lease_until>now)return jsonSuccess({state:'claimed',job:safeJob(await context(db,row.id))});
  }
  const selected=row?.id;
  const eligible=`attempts<${MAX_BACKUP_ATTEMPTS} AND ((status IN('pending','failed') AND next_attempt_at IS NOT NULL AND next_attempt_at<=?) OR (status='processing' AND lease_until<=?))`;
  const sql=`UPDATE proof_backups SET status='processing',attempts=attempts+1,lease_token=?,lease_until=?,started_at=?,last_error_code=NULL,
    root_folder_id=coalesce(root_folder_id,?),version=version+1 WHERE id=${selected?'?':`(SELECT id FROM proof_backups WHERE ${eligible} AND (root_folder_id IS NULL OR root_folder_id=?) ORDER BY created_at,id LIMIT 1)`}
    ${selected?`AND ${eligible}`:''} AND (root_folder_id IS NULL OR root_folder_id=?)
    AND NOT EXISTS(SELECT 1 FROM proof_backups WHERE lease_token=? ${selected?'AND id!=?':''})
    AND NOT EXISTS(SELECT 1 FROM backup_processor_lock WHERE id=1 AND (blocked_error_code IS NOT NULL OR lease_until>?)) RETURNING id`;
  const claimed=await db.prepare(sql).bind(v.request_id,now+RELAY_LEASE_SECONDS,now,v.root_folder_id,...(selected?[selected]:[]),now,now,...(selected?[]:[v.root_folder_id]),v.root_folder_id,v.request_id,...(selected?[selected]:[]),now).first();
  if(!claimed){const same=await db.prepare("SELECT id FROM proof_backups WHERE lease_token=? AND status='processing' AND lease_until>?").bind(v.request_id,now).first();if(!same)return jsonSuccess({state:'idle'});return jsonSuccess({state:'claimed',job:safeJob(await context(db,same.id))});}
  return jsonSuccess({state:'claimed',job:safeJob(await context(db,claimed.id))});
}
async function identity(env,url,request){
  const id=url.pathname.split('/')[4],v=await readUploadJson(request);exact(v,['lease_token','attempt','drive_file_id','campaign_folder_id','date_folder_id']);receipt(v);
  for(const k of ['drive_file_id','campaign_folder_id','date_folder_id'])idValue(v[k]);
  const row=await context(env.DB,id);owned(row,v);const route=source(row);if(new Set([row.root_folder_id,v.drive_file_id,v.campaign_folder_id,v.date_folder_id]).size!==4)fail(400,'INVALID_RELAY_REQUEST');
  const root=row.root_folder_id,now=seconds(),db=env.DB;
  const result=await authAtomic(db,[active(id,v)],[
    db.prepare(`INSERT INTO drive_backup_folders(root_folder_id,folder_key,drive_folder_id,parent_folder_id,display_name,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(root_folder_id,folder_key) DO UPDATE SET folder_key=excluded.folder_key RETURNING *`).bind(root,route.campaignKey,v.campaign_folder_id,root,route.campaignName,now),
    db.prepare(`INSERT INTO drive_backup_folders(root_folder_id,folder_key,drive_folder_id,parent_folder_id,display_name,created_at)
      SELECT ?,?,?,drive_folder_id,?,? FROM drive_backup_folders WHERE root_folder_id=? AND folder_key=?
      ON CONFLICT(root_folder_id,folder_key) DO UPDATE SET folder_key=excluded.folder_key RETURNING *`).bind(root,route.dateKey,v.date_folder_id,route.day,now,root,route.campaignKey),
    db.prepare(`UPDATE proof_backups SET drive_file_id=coalesce(drive_file_id,?),drive_folder_id=(SELECT drive_folder_id FROM drive_backup_folders WHERE root_folder_id=? AND folder_key=?),version=version+1 WHERE id=? RETURNING drive_file_id,drive_folder_id`).bind(v.drive_file_id,root,route.dateKey,id)
  ]);
  const campaign=result[1].results[0],day=result[2].results[0],file=result[3].results[0];
  return jsonSuccess({...file,campaign_folder_id:campaign.drive_folder_id,date_folder_id:day.drive_folder_id});
}
async function content(env,url,request){
  const id=url.pathname.split('/')[4],v={lease_token:request.headers.get('x-voteproof-backup-lease'),attempt:Number(request.headers.get('x-voteproof-backup-attempt'))},row=await context(env.DB,id);owned(row,v);source(row);
  const object=await env.PROOFS_BUCKET.get(row.source_object_key,{onlyIf:{etagMatches:row.source_etag}});
  if(!object?.body||object.size!==row.source_size||object.etag!==row.source_etag||object.httpMetadata?.contentType!==row.source_mime){await object?.body?.cancel();fail(409,'RELAY_SOURCE_CHANGED');}
  return new Response(object.body,{headers:{'Content-Type':row.source_mime,'Content-Length':String(row.source_size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'attachment; filename="'+backupRoute(row).name+'"'}});
}
async function complete(env,url,request){
  const id=url.pathname.split('/')[4],v=await readUploadJson(request);exact(v,['lease_token','attempt','drive_file_id','drive_folder_id','verification']);receipt(v);
  const row=await context(env.DB,id);owned(row,v,row?.status==='confirmed');const route=source(row),m=v.verification;
  exact(m,['name','size','mime','parents','appProperties']);exact(m.appProperties,['source','storage_source','voteproof_case_id','voteproof_proof_id']);
  if(!row.drive_file_id||!row.drive_folder_id||v.drive_file_id!==row.drive_file_id||v.drive_folder_id!==row.drive_folder_id||m.name!==route.name||m.size!==row.source_size||m.mime!==row.source_mime||
    !Array.isArray(m.parents)||m.parents.length!==1||m.parents[0]!==row.drive_folder_id||m.appProperties.source!=='voteproof'||m.appProperties.storage_source!=='r2'||m.appProperties.voteproof_case_id!==row.case_id||m.appProperties.voteproof_proof_id!==row.file_id)fail(409,'RELAY_VERIFICATION_FAILED');
  if(row.status==='confirmed')return jsonSuccess({state:'already_confirmed',backup_id:id});
  const write=await env.DB.prepare(`UPDATE proof_backups SET status='confirmed',completed_at=?,next_attempt_at=NULL,lease_until=NULL,last_error_code=NULL,version=version+1
    WHERE id=? AND status='processing' AND lease_token=? AND attempts=? AND lease_until>?`).bind(seconds(),id,v.lease_token,v.attempt,seconds()).run();
  if(write.meta.changes!==1)fail(409,'RELAY_LEASE_EXPIRED');return jsonSuccess({state:'confirmed',backup_id:id});
}
const retryable=new Set(['NETWORK','RATE_LIMIT','GOOGLE_UNAVAILABLE','UPLOAD_INCOMPLETE']),permanent=new Set(['DRIVE_ACCESS_DENIED','DRIVE_FULL','ROOT_INACCESSIBLE','CONFIG_MISSING','VERIFY_FAILED','SOURCE_MISSING','SOURCE_CHANGED','INVALID_SOURCE','INTERNAL']);
async function failed(env,url,request){
  const id=url.pathname.split('/')[4],v=await readUploadJson(request);exact(v,['lease_token','attempt','error_code']);receipt(v);
  if(!retryable.has(v.error_code)&&!permanent.has(v.error_code))fail(400,'INVALID_RELAY_REQUEST');
  const row=await context(env.DB,id);owned(row,v,row?.status==='failed');if(row.status==='failed'){if(row.last_error_code!==v.error_code)fail(409,'RELAY_FAILURE_CONFLICT');return jsonSuccess({state:'already_failed',backup_id:id});}
  const next=retryable.has(v.error_code)&&row.attempts<MAX_BACKUP_ATTEMPTS?seconds()+backoff(row.attempts):null;
  const writes=[env.DB.prepare(`UPDATE proof_backups SET status='failed',next_attempt_at=?,lease_until=NULL,last_error_code=?,version=version+1 WHERE id=?`).bind(next,v.error_code,id)];
  if(['DRIVE_ACCESS_DENIED','DRIVE_FULL','ROOT_INACCESSIBLE','CONFIG_MISSING'].includes(v.error_code))writes.push(env.DB.prepare(`INSERT INTO backup_processor_lock(id,lease_token,lease_until,blocked_error_code) VALUES(1,'apps-script-relay',0,?) ON CONFLICT(id) DO UPDATE SET blocked_error_code=excluded.blocked_error_code`).bind(v.error_code));
  await authAtomic(env.DB,[active(id,v)],writes);return jsonSuccess({state:'failed',backup_id:id,next_attempt_at:next});
}
const handlers={content,identity,complete,failed};
const wrap=handler=>async(env,url,request)=>{try{await authenticateRelay(request,env);if(url.search)fail(400,'INVALID_RELAY_REQUEST');if(handler!==claim&&!UUID_PATTERN.test(url.pathname.split('/')[4]??''))fail(400,'INVALID_RELAY_REQUEST');return await handler(env,url,request);}catch(e){
  if(e instanceof RelayError)return jsonError(e.status,e.code,'Backup relay request rejected');if(e instanceof BackupError)return jsonError(409,'RELAY_SOURCE_CHANGED','Backup source unavailable');
  if(e?.status&&e?.code)return jsonError(e.status,'INVALID_RELAY_REQUEST','Backup relay request rejected');return jsonError(503,'RELAY_SERVICE_UNAVAILABLE','Backup relay unavailable');}};
export function internalBackupRoute(path){if(path==='/api/internal/drive-backup/claim')return {method:'POST',handler:wrap(claim)};
 const m=/^\/api\/internal\/drive-backup\/[^/]+\/(content|identity|complete|failed)$/.exec(path);if(m)return {method:m[1]==='content'?'GET':'POST',handler:wrap(handlers[m[1]])};}
