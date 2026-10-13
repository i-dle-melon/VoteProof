import { DriveClient, BackupError, backupReadiness, requireBackupReady, DRIVE_ID, FOLDER_MIME } from './google-drive.js';
import { claimBackup, claimBackupStatement, reserveFileId, failBackup, seconds, MAX_BACKUP_JOBS, BACKUP_LEASE_SECONDS } from './proof-backup-store.js';
import { AdminError, ELEVATED_AUTH_GUARD, actorBindings } from './admin-identity.js';
import { authAtomic } from './auth-store.js';
import { MIME_EXTENSIONS, UPLOAD_LIMITS } from '../api/upload-validation.js';
import { CASE_ID_PATTERN } from './case-keys.js';
const blocking = new Set(['CONFIG_MISSING','OAUTH_REVOKED','OAUTH_CONFIG','ROOT_INACCESSIBLE','DRIVE_ACCESS_DENIED','DRIVE_FULL']);
export function backupRoute(row) {
  if (!CASE_ID_PATTERN.test(row.case_id) || !MIME_EXTENSIONS[row.source_mime] || row.source_size <= 0 ||
      row.source_size > UPLOAD_LIMITS.maxFileBytes || !row.source_object_key.endsWith('.' + MIME_EXTENSIONS[row.source_mime])) throw new BackupError('INVALID_SOURCE');
  let day;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: row.campaign_timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(row.case_created_at));
    const p = Object.fromEntries(parts.map(x => [x.type, x.value])); day = `${p.year}-${p.month}-${p.day}`;
  } catch { throw new BackupError('INVALID_SOURCE'); }
  const clean = value => value.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 100);
  return { campaignKey: 'campaign:' + row.campaign_id, dateKey: 'date:' + row.campaign_id + ':' + day,
    campaignName: clean(row.campaign_name) + ' [' + clean(row.campaign_id) + ']', day,
    name: row.case_id + '.' + MIME_EXTENSIONS[row.source_mime] };
}
async function folder(db, drive, root, key, parent, name, row) {
  if (!row) {
    const id = await drive.generateId();
    row = await db.prepare(`INSERT INTO drive_backup_folders(root_folder_id,folder_key,drive_folder_id,parent_folder_id,display_name,created_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(root_folder_id,folder_key) DO UPDATE SET folder_key=excluded.folder_key
      RETURNING *`).bind(root, key, id, parent, name, seconds()).first();
  }
  if (row.parent_folder_id !== parent) throw new BackupError('VERIFY_FAILED');
  return drive.folder(row.drive_folder_id, row.display_name, row.parent_folder_id, key);
}
export function verifyBackup(meta, job, caseId) {
  if (!meta || meta.id !== job.drive_file_id || meta.trashed || Number(meta.size) !== job.source_size || meta.mimeType !== job.source_mime ||
      !meta.parents?.includes(job.drive_folder_id) || meta.appProperties?.voteproof_case_id !== caseId ||
      meta.appProperties?.voteproof_proof_id !== job.file_id || meta.appProperties?.source !== 'voteproof' || meta.appProperties?.storage_source !== 'r2') throw new BackupError('VERIFY_FAILED');
}
// One context lookup includes the authoritative source, without member PII.
const context = (db, id) => db.prepare(`SELECT b.*,c.case_id,c.campaign_id,c.created_at AS case_created_at,
  p.name AS campaign_name,p.campaign_timezone,f.object_key AS actual_key,f.size AS actual_size,
  f.content_type AS actual_mime,f.etag AS actual_etag FROM proof_backups b JOIN case_files f ON f.id=b.file_id
  JOIN cases c ON c.id=f.case_id JOIN campaigns p ON p.campaign_id=c.campaign_id WHERE b.id=?`).bind(id).first();
export const MAX_GOOGLE_REQUESTS = 16;
export async function processBackups(env, { fetcher = fetch, maxJobs = MAX_BACKUP_JOBS, backupId, actor } = {}) {
  const readiness = backupReadiness(env);
  if (!readiness.ready) {
    if (backupId) requireBackupReady(env);
    return { processed: 0, state: readiness.state };
  }
  const db = env.DB, start = seconds();
  let job, row, object, googleRequests = 0;
  if (backupId) {
    // Caller supplies only an ID, and a server-authenticated actor. Never scan.
    if (!actor) throw new AdminError(403, 'ADMIN_FORBIDDEN', 'Administrative access is not allowed');
    row = await context(db, backupId);
    if (!row) throw new AdminError(404, 'BACKUP_NOT_FOUND', 'Backup not found');
    const guards = [{ sql: ELEVATED_AUTH_GUARD, args: actorBindings(actor) }];
    const audit = count => db.prepare(`INSERT INTO backup_admin_audit(id,created_at,admin_member_id,action,target_id,affected_count)
      VALUES(?,?,?,'retry',?,${count})`).bind(crypto.randomUUID(), start, actor.member.member_id, 'process:' + backupId);
    // 0010's immutable retry audit category also records explicit processing.
    // The process: target prefix distinguishes execution from reset/re-enqueue.
    if (row.status === 'confirmed') {
      guards.push({ sql: "EXISTS(SELECT 1 FROM proof_backups WHERE id=? AND status='confirmed')", args: [backupId] });
      await authAtomic(db, guards, [audit('0')]);
      return { id: backupId, processed: 0, confirmed: 1, state: 'already_confirmed' };
    }
    const result = await authAtomic(db, guards, [
      claimBackupStatement(db, start, { id: backupId, manual: true, version: row.version, root: env.GOOGLE_DRIVE_ROOT_FOLDER_ID }),
      // changes() is from the claim in this same atomic transaction.
      audit('changes()'),
    ]);
    job = result[1].results[0];
    if (!job) throw new AdminError(409, 'BACKUP_CONFLICT', 'Backup state changed or is not eligible');
    row = { ...row, ...job };
  } else {
    if (!(maxJobs > 0)) return { processed: 0, state: 'idle' };
    try { job = await claimBackup(db, start, { root: env.GOOGLE_DRIVE_ROOT_FOLDER_ID }); }
    catch { return { processed: 0, state: 'unavailable' }; }
    if (!job) return { processed: 0, state: 'idle' };
  }
  if (job.status !== 'processing') return { id: job.id, processed: 0, state: 'exhausted' };
  try {
    const guardedFetch = async (url, init) => {
      // Each external call renews exactly one row lease. A strict network cap
      // also bounds token-refresh storms and all failure paths' D1 queries.
      if (++googleRequests > MAX_GOOGLE_REQUESTS || seconds() - start >= 240) throw new BackupError('NETWORK', true);
      const now = seconds();
      const owned = await db.prepare(`UPDATE proof_backups SET lease_until=?
        WHERE id=? AND lease_token=? AND status='processing' AND lease_until>?
        ${actor ? 'AND ' + ELEVATED_AUTH_GUARD : ''} RETURNING id`)
        .bind(now + BACKUP_LEASE_SECONDS, job.id, job.lease_token, now, ...(actor ? actorBindings(actor) : [])).first();
      if (!owned) throw new BackupError('INTERNAL', true);
      return fetcher(url, init);
    };
    const drive = new DriveClient(env, guardedFetch);
    row ??= await context(db, job.id);
    if (!row || row.source_object_key !== row.actual_key || row.source_size !== row.actual_size ||
        row.source_mime !== row.actual_mime || row.source_etag !== row.actual_etag) throw new BackupError('SOURCE_CHANGED');
    const route = backupRoute(row);
    const head = await env.PROOFS_BUCKET.head(job.source_object_key);
    if (!head) throw new BackupError('SOURCE_MISSING');
    if (head.etag !== job.source_etag || head.size !== job.source_size || head.httpMetadata?.contentType !== job.source_mime) throw new BackupError('SOURCE_CHANGED');
    const root = job.root_folder_id;
    if (!DRIVE_ID.test(root ?? '')) throw new BackupError('CONFIG_MISSING');
    const mappings = (await db.prepare('SELECT * FROM drive_backup_folders WHERE root_folder_id=? AND folder_key IN (?,?)')
      .bind(root, route.campaignKey, route.dateKey).all()).results;
    const rootMeta = await drive.metadata(root);
    if (rootMeta?.id !== root || rootMeta.trashed || rootMeta.mimeType !== FOLDER_MIME) throw new BackupError('ROOT_INACCESSIBLE');
    const campaignFolder = await folder(db, drive, root, route.campaignKey, root, route.campaignName, mappings.find(x => x.folder_key === route.campaignKey));
    job.drive_folder_id = await folder(db, drive, root, route.dateKey, campaignFolder, route.day, mappings.find(x => x.folder_key === route.dateKey));
    const pinned = await db.prepare(`UPDATE proof_backups SET drive_folder_id=? WHERE id=? AND lease_token=?
      AND status='processing' AND lease_until>? RETURNING id`).bind(job.drive_folder_id, job.id, job.lease_token, seconds()).first();
    if (!pinned) throw new BackupError('INTERNAL', true);
    job.drive_file_id ??= await reserveFileId(db, job, await drive.generateId());
    const existing = await drive.metadata(job.drive_file_id);
    if (existing) verifyBackup(existing, job, row.case_id);
    else {
      object = await env.PROOFS_BUCKET.get(job.source_object_key, { onlyIf: { etagMatches: job.source_etag } });
      if (!object) throw new BackupError('SOURCE_MISSING');
      if (!object.body || object.etag !== job.source_etag || object.size !== job.source_size || object.httpMetadata?.contentType !== job.source_mime) throw new BackupError('SOURCE_CHANGED');
      await drive.upload(job, route.name, job.drive_folder_id, row.case_id, object);
      verifyBackup(await drive.metadata(job.drive_file_id), job, row.case_id);
    }
    const result = await db.prepare(`UPDATE proof_backups SET status='confirmed',completed_at=?,next_attempt_at=NULL,
      lease_token=NULL,lease_until=NULL,last_error_code=NULL,version=version+1 WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?
      ${actor ? 'AND ' + ELEVATED_AUTH_GUARD : ''}`).bind(seconds(), job.id, job.lease_token, seconds(), ...(actor ? actorBindings(actor) : [])).run();
    if (result.meta.changes !== 1) throw new BackupError('INTERNAL', true);
    return { id: job.id, processed: 1, confirmed: 1, state: 'complete' };
  } catch (e) {
    try {
      const error = await failBackup(db, job, e);
      if (blocking.has(error.code)) await db.prepare(`INSERT INTO backup_processor_lock(id,lease_token,lease_until,blocked_error_code)
        VALUES(1,?,0,?) ON CONFLICT(id) DO UPDATE SET blocked_error_code=excluded.blocked_error_code`).bind(crypto.randomUUID(), error.code).run();
      return { id: job.id, processed: 1, confirmed: 0, state: 'failed', error_code: error.code };
    } catch { return { id: job.id, processed: 1, confirmed: 0, state: 'unavailable' }; }
  } finally { try { await object?.body?.cancel(); } catch { /* consumed stream */ } }
}
