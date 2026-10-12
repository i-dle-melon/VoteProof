import { DriveClient, BackupError, backupEnabled, DRIVE_ID, FOLDER_MIME } from './google-drive.js';
import { claimBackup, reserveFileId, failBackup, seconds, MAX_BACKUP_JOBS, BACKUP_LEASE_SECONDS } from './proof-backup-store.js';
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
async function folder(db, drive, root, key, parent, name) {
  let row = await db.prepare('SELECT * FROM drive_backup_folders WHERE root_folder_id=? AND folder_key=?').bind(root, key).first();
  if (!row) {
    const id = await drive.generateId();
    await db.prepare(`INSERT INTO drive_backup_folders(root_folder_id,folder_key,drive_folder_id,parent_folder_id,display_name,created_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(root_folder_id,folder_key) DO NOTHING`).bind(root, key, id, parent, name, seconds()).run();
    row = await db.prepare('SELECT * FROM drive_backup_folders WHERE root_folder_id=? AND folder_key=?').bind(root, key).first();
  }
  return drive.folder(row.drive_folder_id, row.display_name, row.parent_folder_id, key);
}
export function verifyBackup(meta, job, caseId) {
  if (!meta || meta.id !== job.drive_file_id || meta.trashed || Number(meta.size) !== job.source_size || meta.mimeType !== job.source_mime ||
      !meta.parents?.includes(job.drive_folder_id) || meta.appProperties?.voteproof_case_id !== caseId ||
      meta.appProperties?.voteproof_proof_id !== job.file_id || meta.appProperties?.source !== 'voteproof' || meta.appProperties?.storage_source !== 'r2') throw new BackupError('VERIFY_FAILED');
}
export async function processBackups(env, { fetcher = fetch, maxJobs = MAX_BACKUP_JOBS } = {}) {
  if (!backupEnabled(env)) return { processed: 0, state: 'disabled' };
  const db = env.DB, token = crypto.randomUUID(), start = seconds();
  let processed = 0, confirmed = 0, job, googleRequests = 0, heldLock = false;
  try {
    // No network/token refresh and no lock write when there is no due work.
    const due = await db.prepare(`SELECT id FROM proof_backups WHERE (status IN('pending','failed') AND next_attempt_at<=?)
      OR (status='processing' AND lease_until<=?) LIMIT 1`).bind(start, start).first();
    if (!due) return { processed: 0, state: 'idle' };
    const lock = await db.prepare(`INSERT INTO backup_processor_lock(id,lease_token,lease_until) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until
      WHERE backup_processor_lock.lease_until<=? AND backup_processor_lock.blocked_error_code IS NULL RETURNING id`)
      .bind(token, start + BACKUP_LEASE_SECONDS, start).first();
    if (!lock) return { processed: 0, state: 'locked_or_blocked' };
    heldLock = true;
    // If a Worker dies on its final attempt, retain a terminal failed record.
    await db.prepare(`UPDATE proof_backups SET status='failed',next_attempt_at=NULL,last_error_code='INTERNAL',
      lease_token=NULL,lease_until=NULL,version=version+1 WHERE status='processing' AND lease_until<=? AND attempts>=8`).bind(start).run();
    const guardedFetch = async (url, init) => {
      // Reserve headroom for R2/D1 and the current proof on free-plan limits.
      if (++googleRequests > 35) throw new BackupError('NETWORK',true);
      const now = seconds(); if (now - start >= 240) throw new BackupError('NETWORK', true);
      const held = await db.prepare('UPDATE backup_processor_lock SET lease_until=? WHERE id=1 AND lease_token=? AND lease_until>? RETURNING id')
        .bind(now + BACKUP_LEASE_SECONDS, token, now).first();
      const owned = await db.prepare(`UPDATE proof_backups SET lease_until=? WHERE id=? AND lease_token=? AND status='processing' AND lease_until>? RETURNING id`)
        .bind(now + BACKUP_LEASE_SECONDS, job.id, job.lease_token, now).first();
      if (!held || !owned) throw new BackupError('INTERNAL', true);
      return fetcher(url, init);
    };
    let drive;
    for (let n = 0; n < Math.min(MAX_BACKUP_JOBS, Math.max(0, maxJobs)); n++) {
      if (seconds() - start >= 240 || googleRequests + 15 > 35) break;
      job = await claimBackup(db); if (!job) break; processed++;
      let object;
      try {
        drive ??= new DriveClient(env, guardedFetch);
        const row = await db.prepare(`SELECT b.*,c.case_id,c.campaign_id,c.created_at AS case_created_at,
          p.name AS campaign_name,p.campaign_timezone FROM proof_backups b JOIN case_files f ON f.id=b.file_id
          JOIN cases c ON c.id=f.case_id JOIN campaigns p ON p.campaign_id=c.campaign_id WHERE b.id=?`).bind(job.id).first();
        const route = backupRoute(row);
        const head = await env.PROOFS_BUCKET.head(job.source_object_key);
        if (!head) throw new BackupError('SOURCE_MISSING');
        if (head.etag !== job.source_etag || head.size !== job.source_size || head.httpMetadata?.contentType !== job.source_mime) throw new BackupError('SOURCE_CHANGED');
        const root = job.root_folder_id ?? env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
        if (!DRIVE_ID.test(root ?? '')) throw new BackupError('CONFIG_MISSING');
        const pinned = await db.prepare(`UPDATE proof_backups SET root_folder_id=coalesce(root_folder_id,?)
          WHERE id=? AND lease_token=? AND status='processing' AND lease_until>? RETURNING root_folder_id`)
          .bind(root,job.id,job.lease_token,seconds()).first();
        if (pinned?.root_folder_id !== root) throw new BackupError('INTERNAL',true);
        const rootMeta = await drive.metadata(root);
        if (rootMeta?.id !== root || rootMeta.trashed || rootMeta.mimeType !== FOLDER_MIME) throw new BackupError('ROOT_INACCESSIBLE');
        const campaignFolder = await folder(db, drive, root, route.campaignKey, root, route.campaignName);
        job.drive_folder_id = await folder(db, drive, root, route.dateKey, campaignFolder, route.day);
        await db.prepare(`UPDATE proof_backups SET root_folder_id=?,drive_folder_id=? WHERE id=? AND lease_token=?`)
          .bind(root, job.drive_folder_id, job.id, job.lease_token).run();
        job.drive_file_id = job.drive_file_id ?? await reserveFileId(db, job, await drive.generateId());
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
          lease_token=NULL,lease_until=NULL,last_error_code=NULL,version=version+1 WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?`)
          .bind(seconds(), job.id, job.lease_token, seconds()).run();
        if (result.meta.changes === 1) confirmed++;
      } catch (e) {
        const error = await failBackup(db, job, e);
        if (blocking.has(error.code)) {
          await db.prepare('UPDATE backup_processor_lock SET blocked_error_code=? WHERE id=1 AND lease_token=?').bind(error.code, token).run(); break;
        }
      } finally { try { await object?.body?.cancel(); } catch { /* consumed stream */ } }
    }
    return { processed, confirmed, state: 'complete' };
  } catch {
    // Missing 0010/unavailable D1 fails safely. No raw SQL/exception/credentials.
    return { processed, confirmed, state: 'unavailable' };
  } finally {
    if (heldLock) try { await db.prepare('UPDATE backup_processor_lock SET lease_until=0 WHERE id=1 AND lease_token=?').bind(token).run(); } catch { /* unavailable D1 */ }
  }
}
