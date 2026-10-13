// Server-side only. Never surface upstream text, headers, token responses or URLs.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export class BackupError extends Error {
  constructor(code, retryable = false) { super(code); this.code = code; this.retryable = retryable; }
}
export const backupEnabled = env => env.GOOGLE_DRIVE_BACKUP_ENABLED === 'true';
const validCredentials = env => [env.GOOGLE_DRIVE_CLIENT_ID, env.GOOGLE_DRIVE_CLIENT_SECRET, env.GOOGLE_DRIVE_REFRESH_TOKEN]
  .every(value => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u0020\u007f]/.test(value));
export function backupReadiness(env) {
  const enabled = backupEnabled(env);
  const configured = validCredentials(env) &&
    typeof env.GOOGLE_DRIVE_ROOT_FOLDER_ID === 'string' && env.GOOGLE_DRIVE_ROOT_FOLDER_ID === env.GOOGLE_DRIVE_ROOT_FOLDER_ID.trim() && DRIVE_ID.test(env.GOOGLE_DRIVE_ROOT_FOLDER_ID);
  return { enabled, configured, ready: enabled && configured, state: !enabled ? 'disabled' : configured ? 'ready' : 'not_configured' };
}
export function requireBackupReady(env) {
  const readiness = backupReadiness(env);
  if (!readiness.ready) throw new BackupError(readiness.enabled ? 'DRIVE_BACKUP_NOT_CONFIGURED' : 'DRIVE_BACKUP_DISABLED');
  return readiness;
}
export function driveConfig(env) {
  // The offline OAuth/root-creation helper has no root yet. Operational paths
  // require all four settings through requireBackupReady before any mutation.
  if (!validCredentials(env)) throw new BackupError('CONFIG_MISSING');
  return env;
}
const metadataFields = 'id,name,mimeType,size,parents,trashed,appProperties';
const classify = async (response, oauth) => {
  let reason;
  try {
    const body = await response.json();
    // Only allowlisted categories escape; Google error descriptions never do.
    reason = oauth ? body.error : body.error?.errors?.[0]?.reason;
  } catch { /* HTTP status remains sufficient. */ }
  if (response.status === 429 || ['rateLimitExceeded','userRateLimitExceeded'].includes(reason)) return new BackupError('RATE_LIMIT', true);
  if (response.status >= 500) return new BackupError('GOOGLE_UNAVAILABLE', true);
  if (oauth) return new BackupError(reason === 'invalid_grant' ? 'OAUTH_REVOKED' : 'OAUTH_CONFIG');
  if (reason === 'storageQuotaExceeded') return new BackupError('DRIVE_FULL');
  return new BackupError('DRIVE_ACCESS_DENIED');
};
export class DriveClient {
  constructor(env, fetcher = fetch) { this.env = driveConfig(env); this.fetcher = fetcher; this.expires = 0; }
  async send(url, init = {}) {
    // Workers supports manual/follow. Never forward credentials to a redirect.
    try { return await this.fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
    catch (error) { if (error instanceof BackupError) throw error; throw new BackupError('NETWORK', true); }
  }
  async access() {
    if (this.expires > Date.now()) return this.accessValue;
    const response = await this.send('https://oauth2.googleapis.com/token', { method: 'POST',
      body: new URLSearchParams({ client_id: this.env.GOOGLE_DRIVE_CLIENT_ID, client_secret: this.env.GOOGLE_DRIVE_CLIENT_SECRET,
        refresh_token: this.env.GOOGLE_DRIVE_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
    if (!response.ok) throw await classify(response, true);
    let body; try { body = await response.json(); } catch { throw new BackupError('OAUTH_CONFIG'); }
    if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(body.expires_in) || body.expires_in <= 60 ||
        (body.scope && !body.scope.split(' ').includes(DRIVE_SCOPE))) throw new BackupError('OAUTH_CONFIG');
    this.accessValue = body.access_token; this.expires = Date.now() + Math.min(body.expires_in - 60, 3500) * 1000;
    return this.accessValue;
  }
  async request(path, init = {}, missing = false) {
    const response = await this.send('https://www.googleapis.com' + path, { ...init,
      headers: { ...init.headers, Authorization: 'Bearer ' + await this.access() } });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw await classify(response, false);
    return response;
  }
  async metadata(id) {
    if (!DRIVE_ID.test(id ?? '')) throw new BackupError('VERIFY_FAILED');
    const r = await this.request('/drive/v3/files/' + id + '?fields=' + metadataFields, {}, true);
    if (!r) return null;
    try { return await r.json(); } catch { throw new BackupError('VERIFY_FAILED'); }
  }
  async generateId() {
    const r = await this.request('/drive/v3/files/generateIds?count=1&space=drive&type=files');
    let data; try { data = await r.json(); } catch { throw new BackupError('VERIFY_FAILED'); }
    if (!DRIVE_ID.test(data.ids?.[0] ?? '')) throw new BackupError('VERIFY_FAILED');
    return data.ids[0];
  }
  async folder(id, name, parent, key) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    key = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
    let meta = await this.metadata(id);
    if (!meta) {
      const r = await this.send('https://www.googleapis.com/drive/v3/files?fields=' + metadataFields, { method: 'POST',
        headers: { Authorization: 'Bearer ' + await this.access(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, mimeType: FOLDER_MIME, parents: [parent], appProperties: { source: 'voteproof', folder_key: key } }) });
      if (!r.ok && r.status !== 409) throw await classify(r, false);
      meta = await this.metadata(id);
    }
    if (meta?.id !== id || meta.trashed || meta.mimeType !== FOLDER_MIME || !meta.parents?.includes(parent) ||
        meta.appProperties?.source !== 'voteproof' || meta.appProperties?.folder_key !== key) throw new BackupError('VERIFY_FAILED');
    return id;
  }
  async upload(job, name, folder, caseId, object) {
    const metadata = { id: job.drive_file_id, name, mimeType: job.source_mime, parents: [folder],
      appProperties: { voteproof_case_id: caseId, voteproof_proof_id: job.file_id, source: 'voteproof', storage_source: 'r2' } };
    const r = await this.send('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=' + metadataFields, { method: 'POST',
      headers: { Authorization: 'Bearer ' + await this.access(), 'Content-Type': 'application/json', 'X-Upload-Content-Type': job.source_mime, 'X-Upload-Content-Length': String(job.source_size) }, body: JSON.stringify(metadata) });
    if (r.status === 409) throw new BackupError('UPLOAD_INCOMPLETE', true);
    if (!r.ok) throw await classify(r, false);
    let uri; try { uri = new URL(r.headers.get('Location')); } catch { throw new BackupError('VERIFY_FAILED'); }
    // The URI is a capability: keep it in memory, never log/store it. No redirects.
    if (uri.origin !== 'https://www.googleapis.com' || uri.pathname !== '/upload/drive/v3/files' || uri.username || uri.password || uri.hash) throw new BackupError('VERIFY_FAILED');
    // Workers ignores a manually supplied Content-Length on a generic stream.
    // FixedLengthStream provides that header without buffering the proof.
    const fixed = typeof FixedLengthStream === 'function' ? new FixedLengthStream(job.source_size) : null;
    const cancel = new AbortController();
    let transferError;
    const transfer = fixed ? object.body.pipeTo(fixed.writable, { signal: cancel.signal }).catch(() => { transferError = true; }) : Promise.resolve();
    let result;
    try {
      result = await this.send(uri.href, { method: 'PUT', headers: { Authorization: 'Bearer ' + await this.access(),
        'Content-Type': job.source_mime, 'Content-Length': String(job.source_size) }, body: fixed?.readable ?? object.body, duplex: 'half' });
      if (result.ok) { await transfer; if (transferError) throw new BackupError('SOURCE_CHANGED'); }
    } finally { cancel.abort(); await transfer; }
    if (result.status === 308) throw new BackupError('UPLOAD_INCOMPLETE', true);
    if (!result.ok) throw await classify(result, false);
    // Independent files.get readback is authoritative, not a lost/partial PUT ack.
  }
}
