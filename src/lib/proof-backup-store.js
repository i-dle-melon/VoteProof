import { backupReadiness, requireBackupReady } from './drive-backup-relay.js';
import { BackupError } from './google-drive.js';
export const seconds = () => Math.floor(Date.now() / 1000);
export const MAX_BACKUP_JOBS = 1;
export const MAX_BACKUP_ATTEMPTS = 8;
export const BACKUP_LEASE_SECONDS = 300;
export const backupInsert = (db, fileId, now, guard = '1=1', bindings = []) => db.prepare(`INSERT INTO proof_backups
  (id,file_id,provider,source_object_key,source_size,source_mime,source_etag,created_at,next_attempt_at)
  SELECT ?,f.id,'google_drive',f.object_key,f.size,f.content_type,f.etag,?,? FROM case_files f JOIN cases c ON c.id=f.case_id
  WHERE f.id=? AND f.etag IS NOT NULL AND ${guard} ON CONFLICT(file_id,provider) DO NOTHING`)
  .bind(crypto.randomUUID(), now, now, fileId, ...bindings);
export async function ensureCaseBackups(env, caseInternalId, committedFiles) {
  if (!backupReadiness(env).ready) return;
  try {
    const files = committedFiles ?? (await env.DB.prepare('SELECT id FROM case_files WHERE case_id=?').bind(caseInternalId).all()).results;
    // Known server-generated IDs avoid a reread; SQL still binds each proof to
    // the committed case. No caller-provided file metadata is authoritative.
    if (files.length) await env.DB.batch(files.map(f => backupInsert(env.DB, f.id, seconds(),'c.id=?',[caseInternalId])));
  } catch {
    // Durable reconciliation detects every absent record; submission stays valid.
    try { console.warn('VoteProof backup scheduling unavailable', { code: 'BACKUP_SCHEDULING_FAILED' }); } catch { /* no upstream exception */ }
  }
}
export const backupRows = async (db, caseId) => (await db.prepare(`SELECT b.id,b.file_id,b.status,b.drive_file_id,
  b.completed_at,b.last_error_code,b.attempts,b.next_attempt_at,b.version FROM proof_backups b
  JOIN case_files f ON f.id=b.file_id JOIN cases c ON c.id=f.case_id WHERE c.case_id=? ORDER BY b.file_id`).bind(caseId).all()).results;
export async function backupSummary(db) {
  const counts = { pending: 0, processing: 0, confirmed: 0, failed: 0 };
  for (const row of (await db.prepare('SELECT status,count(*) AS n FROM proof_backups GROUP BY status').all()).results) counts[row.status] = row.n;
  const missing = await db.prepare(`SELECT count(*) AS n FROM case_files f WHERE NOT EXISTS
    (SELECT 1 FROM proof_backups b WHERE b.file_id=f.id AND b.provider='google_drive')`).first();
  const lock = await db.prepare('SELECT blocked_error_code FROM backup_processor_lock WHERE id=1').first();
  return { counts, missing: missing.n, blocked_error_code: lock?.blocked_error_code ?? null };
}
export async function missingBackupPage(env, { after = '', limit = 25, fileIds } = {}) {
  const rows = (await env.DB.prepare(`SELECT f.id,f.object_key,f.size,f.content_type,f.etag FROM case_files f
    WHERE f.id>? ${fileIds ? `AND f.id IN (${fileIds.map(() => '?').join(',')})` : ''} AND NOT EXISTS(SELECT 1 FROM proof_backups b WHERE b.file_id=f.id AND b.provider='google_drive')
    ORDER BY f.id LIMIT ?`).bind(after, ...(fileIds ?? []), limit + 1).all()).results;
  const selected = rows.slice(0, limit), ready = [], missing = [], changed = [];
  for (const row of selected) {
    const obj = await env.PROOFS_BUCKET.head(row.object_key);
    if (!obj) missing.push(row.id);
    else if (obj.size !== row.size || obj.etag !== row.etag || obj.httpMetadata?.contentType !== row.content_type) changed.push(row.id);
    else ready.push(row.id);
  }
  return { scanned: selected.length, ready, missing, changed, next_cursor: rows.length > limit ? selected.at(-1).id : null };
}
export async function backfillBackups(env, { dryRun = true, ...page } = {}) {
  if (!dryRun) requireBackupReady(env);
  const result = await missingBackupPage(env, page);
  let enqueued = 0;
  if (!dryRun && result.ready.length) {
    const writes = await env.DB.batch(result.ready.map(id => backupInsert(env.DB, id, seconds())));
    enqueued = writes.reduce((n, r) => n + r.meta.changes, 0);
  }
  return { ...result, dry_run: dryRun, enqueued };
}
export function claimBackupStatement(db, now = seconds(), { id, manual = false, version, root } = {}) {
  // Explicit manual ID never selects another job. Legacy global block/active lease
  // remains authoritative; current processors use an atomic per-row lease only.
  const eligible = `((attempts<? AND ((status IN('pending','failed') AND next_attempt_at IS NOT NULL ${manual ? '' : 'AND next_attempt_at<=?'} )
    OR (status='processing' AND lease_until<=?))) OR (status='processing' AND lease_until<=? AND attempts>=?))`;
  const args = [MAX_BACKUP_ATTEMPTS, ...(manual ? [] : [now]), now, now, MAX_BACKUP_ATTEMPTS];
  return db.prepare(`UPDATE proof_backups SET
    status=CASE WHEN attempts>=${MAX_BACKUP_ATTEMPTS} THEN 'failed' ELSE 'processing' END,
    attempts=attempts+CASE WHEN attempts>=${MAX_BACKUP_ATTEMPTS} THEN 0 ELSE 1 END,
    lease_token=CASE WHEN attempts>=${MAX_BACKUP_ATTEMPTS} THEN NULL ELSE ? END,
    lease_until=CASE WHEN attempts>=${MAX_BACKUP_ATTEMPTS} THEN NULL ELSE ? END,
    started_at=?,last_error_code=CASE WHEN attempts>=${MAX_BACKUP_ATTEMPTS} THEN 'INTERNAL' ELSE NULL END,
    next_attempt_at=CASE WHEN attempts>=${MAX_BACKUP_ATTEMPTS} THEN NULL ELSE next_attempt_at END,
    root_folder_id=coalesce(root_folder_id,?),version=version+1
    WHERE id=${id ? '?' : `(SELECT id FROM proof_backups WHERE ${eligible} ORDER BY created_at,id LIMIT 1)`}
    ${id ? `AND ${eligible}` : ''} ${version === undefined ? '' : 'AND version=?'}
    AND NOT EXISTS(SELECT 1 FROM backup_processor_lock WHERE id=1 AND (blocked_error_code IS NOT NULL OR lease_until>?))
    RETURNING *`).bind(crypto.randomUUID(), now + BACKUP_LEASE_SECONDS, now, root ?? null,
      ...(id ? [id] : []), ...args, ...(version === undefined ? [] : [version]), now);
}
export const claimBackup = (db, now = seconds(), options) => claimBackupStatement(db, now, options).first();
export async function reserveFileId(db, job, id) {
  const row = await db.prepare(`UPDATE proof_backups SET drive_file_id=coalesce(drive_file_id,?)
    WHERE id=? AND status='processing' AND lease_token=? AND lease_until>? RETURNING drive_file_id`)
    .bind(id, job.id, job.lease_token, seconds()).first();
  if (!row) throw new BackupError('INTERNAL', true);
  return row.drive_file_id;
}
export const backoff = (attempt, jitter = Math.random()) => Math.min(86400, 60 * 2 ** Math.min(attempt - 1, 11) + Math.floor(jitter * 30));
export async function failBackup(db, job, error) {
  const known = error instanceof BackupError ? error : new BackupError('INTERNAL', true);
  const next = known.retryable && job.attempts < MAX_BACKUP_ATTEMPTS ? seconds() + backoff(job.attempts) : null;
  await db.prepare(`UPDATE proof_backups SET status='failed',next_attempt_at=?,lease_token=NULL,lease_until=NULL,
    last_error_code=?,version=version+1 WHERE id=? AND status='processing' AND lease_token=?`)
    .bind(next, known.code, job.id, job.lease_token).run();
  return known;
}
