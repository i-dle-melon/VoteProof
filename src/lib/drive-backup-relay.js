// Default production transport: Apps Script pulls; the Worker never needs Google credentials.
import { backupReadiness as legacyReadiness } from './google-drive.js';
export const legacyBackupTransport = env => env.DRIVE_BACKUP_TRANSPORT === 'worker_oauth_legacy';
export function backupReadiness(env) {
  if (legacyBackupTransport(env)) return { ...legacyReadiness(env), transport: 'deprecated_worker_oauth' };
  const enabled = env.GOOGLE_DRIVE_BACKUP_ENABLED === 'true';
  const configured = /^[a-f0-9]{64}$/.test(env.DRIVE_BACKUP_RELAY_SECRET ?? '');
  return { enabled, configured, ready: enabled && configured, state: !enabled ? 'disabled' : configured ? 'ready' : 'not_configured', transport: 'apps_script_pull' };
}
export class RelayError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function requireBackupReady(env) {
  const r = backupReadiness(env);
  if (!r.ready) throw new RelayError(r.enabled ? 503 : 409, r.enabled ? 'DRIVE_BACKUP_NOT_CONFIGURED' : 'DRIVE_BACKUP_DISABLED');
  return r;
}
export async function authenticateRelay(request, env) {
  if (request.headers.has('origin')) throw new RelayError(403, 'RELAY_SERVER_ONLY');
  if (legacyBackupTransport(env) || !/^[a-f0-9]{64}$/.test(env.DRIVE_BACKUP_RELAY_SECRET ?? '')) throw new RelayError(503, 'DRIVE_BACKUP_NOT_CONFIGURED');
  const value = request.headers.get('authorization');
  if (!/^Bearer [a-f0-9]{64}$/.test(value ?? '')) throw new RelayError(401, 'RELAY_AUTH_REQUIRED');
  const [a, b] = await Promise.all([env.DRIVE_BACKUP_RELAY_SECRET, value.slice(7)].map(s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  let equal;
  if (typeof crypto.subtle.timingSafeEqual === 'function') equal = crypto.subtle.timingSafeEqual(a, b);
  else { const x = new Uint8Array(a), y = new Uint8Array(b); let diff = 0; for (let i = 0; i < 32; i++) diff |= x[i] ^ y[i]; equal = diff === 0; }
  if (!equal) throw new RelayError(401, 'RELAY_AUTH_REQUIRED');
  requireBackupReady(env);
}
