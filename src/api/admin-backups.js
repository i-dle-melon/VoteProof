import {storageSummary} from '../lib/storage-capacity.js';
import { jsonSuccess } from './response.js';
import { adminHandler } from './admin-response.js';
import { AdminError, adminIdentity, adminCsrf, ELEVATED_ROLES, ELEVATED_AUTH_GUARD, actorBindings } from '../lib/admin-identity.js';
import { authAtomic } from '../lib/auth-store.js';
import { readReviewJson, UUID_PATTERN } from './admin-validation.js';
import { backupRows, backupSummary, missingBackupPage, seconds } from '../lib/proof-backup-store.js';
import { backupReadiness, legacyBackupTransport } from '../lib/drive-backup-relay.js';
import { processBackups } from '../lib/proof-backup-processor.js';
import { CASE_ID_PATTERN } from '../lib/case-keys.js';
const invalid = () => { throw new AdminError(400, 'INVALID_BACKUP_REQUEST', 'Invalid backup request'); };
const actorGuard = actor => ({ sql: ELEVATED_AUTH_GUARD, args: actorBindings(actor) });
const requireReady = env => {
  const r = backupReadiness(env);
  if (!r.ready) throw new AdminError(r.enabled ? 503 : 409, r.enabled ? 'DRIVE_BACKUP_NOT_CONFIGURED' : 'DRIVE_BACKUP_DISABLED', 'Drive backup is not ready');
};
const summary = adminHandler(async (env, _url, request) => {
  await adminIdentity(request, env, ELEVATED_ROLES);
  const audit = (await env.DB.prepare('SELECT created_at,action,target_id,affected_count FROM backup_admin_audit ORDER BY created_at DESC,id DESC LIMIT 10').all()).results;
  return jsonSuccess({ ...backupReadiness(env), ...await backupSummary(env.DB), storage:await storageSummary(env.DB), audit });
});
const missingList = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env, ELEVATED_ROLES);
  const raw = url.searchParams.get('page') ?? '1', page = Number(raw);
  if ([...url.searchParams.keys()].some(key => key !== 'page') || url.searchParams.getAll('page').length > 1 ||
      !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(page) || !Number.isSafeInteger(page * 10)) invalid();
  // Metadata only. Listing must not HEAD/download R2 objects or enqueue backups.
  const missing = "NOT EXISTS(SELECT 1 FROM proof_backups b WHERE b.file_id=f.id AND b.provider='google_drive')";
  const [count, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT count(*) AS total FROM case_files f WHERE ${missing}`),
    env.DB.prepare(`SELECT f.id AS file_id,c.case_id,c.created_at,f.size,f.content_type
      FROM case_files f JOIN cases c ON c.id=f.case_id WHERE ${missing} ORDER BY f.id LIMIT 10 OFFSET ?`)
      .bind((page - 1) * 10),
  ]);
  const total = count.results[0].total;
  return jsonSuccess({ files: rows.results, page, page_size: 10, total, total_pages: Math.max(1, Math.ceil(total / 10)) });
});
const jobsList = adminHandler(async(env,url,request)=>{
  await adminIdentity(request,env,ELEVATED_ROLES);
  const p=url.searchParams,raw=p.get('page')??'1',page=Number(raw),status=p.get('status')??'pending';
  if([...p.keys()].some(k=>!['status','page'].includes(k))||['status','page'].some(k=>p.getAll(k).length>1)||
    !['pending','processing','confirmed','failed'].includes(status)||!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(page*10))invalid();
  const [count,rows]=await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) total FROM proof_backups WHERE provider='google_drive' AND status=?").bind(status),
    env.DB.prepare(`SELECT b.file_id,c.case_id,b.status,b.created_at,b.started_at,b.completed_at,b.next_attempt_at,b.attempts,b.last_error_code,
      CASE WHEN b.lease_until>? THEN 1 ELSE 0 END lease_active FROM proof_backups b
      JOIN case_files f ON f.id=b.file_id JOIN cases c ON c.id=f.case_id
      WHERE b.provider='google_drive' AND b.status=? ORDER BY b.created_at,b.id LIMIT 10 OFFSET ?`).bind(seconds(),status,(page-1)*10),
  ]);
  const total=count.results[0].total;
  return jsonSuccess({files:rows.results,page,page_size:10,total,total_pages:Math.max(1,Math.ceil(total/10))});
});
const caseBackups = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env);
  const id = url.pathname.split('/')[4]; if (!CASE_ID_PATTERN.test(id)) invalid();
  return jsonSuccess({ ...backupReadiness(env), backups: await backupRows(env.DB, id) });
});
const retry = adminHandler(async (env, url, request) => {
  const actor = await adminIdentity(request, env, ELEVATED_ROLES); await adminCsrf(request, env, actor);
  requireReady(env);
  const id = url.pathname.split('/')[4], input = await readReviewJson(request);
  if (!UUID_PATTERN.test(id) || !Number.isSafeInteger(input.expected_version) || input.expected_version < 0 || Object.keys(input).length !== 1) invalid();
  const row = await env.DB.prepare('SELECT status,version FROM proof_backups WHERE id=?').bind(id).first();
  if (!row) throw new AdminError(404, 'BACKUP_NOT_FOUND', 'Backup not found');
  if (row.status !== 'failed' || row.version !== input.expected_version) throw new AdminError(409, 'BACKUP_CONFLICT', 'Backup state changed');
  await authAtomic(env.DB, [actorGuard(actor), { sql: "EXISTS(SELECT 1 FROM proof_backups WHERE id=? AND status='failed' AND version=?)", args: [id, input.expected_version] }], [
    env.DB.prepare(`UPDATE proof_backups SET status='pending',attempts=0,next_attempt_at=?,lease_token=NULL,lease_until=NULL,last_error_code=NULL,version=version+1 WHERE id=?`).bind(seconds(), id),
    env.DB.prepare('UPDATE backup_processor_lock SET blocked_error_code=NULL WHERE id=1'),
    env.DB.prepare("INSERT INTO backup_admin_audit(id,created_at,admin_member_id,action,target_id,affected_count) VALUES(?,?,?,'retry',?,1)")
      .bind(crypto.randomUUID(), seconds(), actor.member.member_id, id),
  ]);
  return jsonSuccess({ id, status: 'pending' });
});
const backfill = adminHandler(async (env, _url, request) => {
  const actor = await adminIdentity(request, env, ELEVATED_ROLES); await adminCsrf(request, env, actor);
  const input = await readReviewJson(request);
  if (Object.keys(input).some(k => !['dry_run','limit','after','file_ids'].includes(k)) || typeof input.dry_run !== 'boolean' ||
      (input.limit != null && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25)) ||
      (input.after != null && !UUID_PATTERN.test(input.after))) invalid();
  if (!input.dry_run) requireReady(env);
  if (input.file_ids != null && (!Array.isArray(input.file_ids) || input.file_ids.length < 1 || input.file_ids.length > 25 ||
      input.file_ids.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id)) || new Set(input.file_ids).size !== input.file_ids.length || input.after != null)) invalid();
  const result = await missingBackupPage(env, { limit: input.limit ?? 25, after: input.after ?? '', fileIds: input.file_ids });
  let enqueued = 0;
  if (!input.dry_run) {
    const ids = result.ready, marker = crypto.randomUUID(), now = seconds();
    // One INSERT and its changes() audit in the same guarded transaction.
    const writes = await authAtomic(env.DB, [actorGuard(actor)], [
      env.DB.prepare(`INSERT INTO proof_backups(id,file_id,provider,source_object_key,source_size,source_mime,source_etag,created_at,next_attempt_at)
        SELECT id,id,'google_drive',object_key,size,content_type,etag,?,? FROM case_files
        WHERE id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'}) AND etag IS NOT NULL
        ON CONFLICT(file_id,provider) DO NOTHING`).bind(now, now, ...ids),
      env.DB.prepare(`INSERT INTO backup_admin_audit(id,created_at,admin_member_id,action,target_id,affected_count)
        VALUES(?,?,?,'backfill',?,changes())`).bind(marker, now, actor.member.member_id, marker),
    ]);
    enqueued = writes[1].meta.changes;
  }
  return jsonSuccess({ ...result, dry_run: input.dry_run, enqueued });
});
const processOne = adminHandler(async (env, url, request) => {
  const actor = await adminIdentity(request, env, ELEVATED_ROLES); await adminCsrf(request, env, actor);
  requireReady(env);
  const id = url.pathname.split('/')[4], input = await readReviewJson(request);
  if (!UUID_PATTERN.test(id) || input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) invalid();
  if (!legacyBackupTransport(env)) throw new AdminError(410,'DIRECT_BACKUP_PROCESSING_RETIRED','Backup execution is performed by the relay');
  return jsonSuccess(await processBackups(env, { backupId: id, actor }));
});
const routes = new Map([
  ['/api/admin/backups', { method: 'GET', handler: summary }],
  ['/api/admin/backups/missing', { method: 'GET', handler: missingList }],
  ['/api/admin/backups/jobs', { method: 'GET', handler: jobsList }],
  ['/api/admin/backups/backfill', { method: 'POST', handler: backfill }],
]);
export function backupAdminRoute(path) {
  if (routes.has(path)) return routes.get(path);
  if (/^\/api\/admin\/backups\/[^/]+\/retry$/.test(path)) return { method: 'POST', handler: retry };
  if (/^\/api\/admin\/backups\/[^/]+\/process$/.test(path)) return { method: 'POST', handler: processOne };
  if (/^\/api\/admin\/cases\/[^/]+\/backups$/.test(path)) return { method: 'GET', handler: caseBackups };
}
