import { AUTH_LIMITS, AuthError } from "../api/auth-validation.js";
import { authMac } from "./auth-session.js";

export async function rateLimit(db, key, scope, value, maximum, windowSeconds = AUTH_LIMITS.windowSeconds) {
  const now = Math.floor(Date.now() / 1000), start = now - now % windowSeconds;
  const hash = await authMac(key, "rate-limit:" + scope, value);
  // Atomic cap across Workers, including concurrent requests. No raw IP in D1.
  const result = await db.prepare(`INSERT INTO auth_rate_limits (scope_hash, window_start, count, expires_at)
    VALUES (?, ?, 1, ?) ON CONFLICT(scope_hash, window_start) DO UPDATE SET count = count + 1
    WHERE count < ?`).bind(hash, start, start + windowSeconds, maximum).run();
  return result.meta.changes === 1;
}
export function rateError(seconds = AUTH_LIMITS.windowSeconds) {
  const error = new AuthError(429, "AUTH_RATE_LIMITED", "Too many authentication requests; try again later");
  error.retryAfter = seconds;
  return error;
}

export async function establishSession(db, challenge, tokenHash, previousHash) {
  const now = Math.floor(Date.now() / 1000), timestamp = new Date().toISOString();
  const condition = `id = ? AND browser_hash = ? AND otp_hash = ? AND delivered = 1 AND consumed_at IS NULL
    AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) AND attempts <= ?`;
  const guards = [challenge.id, challenge.browser_hash, challenge.otp_hash, AUTH_LIMITS.otpAttempts];
  // Challenge consumption, identity creation, session issue and previous-session
  // revocation commit together. A competing verification cannot issue a session.
  const result = await db.batch([
    db.prepare(`INSERT INTO members (id, member_id, email, created_at, updated_at, last_login_at)
      SELECT ?, ?, email, ?, ?, ? FROM auth_challenges WHERE ${condition}
      ON CONFLICT(email) DO NOTHING`).bind(crypto.randomUUID(), "M-" + crypto.randomUUID(), timestamp, timestamp, timestamp, ...guards),
    db.prepare(`INSERT INTO auth_sessions (token_hash, member_id, created_at, expires_at)
      SELECT ?, m.member_id, ?, ? FROM auth_challenges a JOIN members m ON m.email = a.email
      WHERE a.id = ? AND a.browser_hash = ? AND a.otp_hash = ? AND a.delivered = 1 AND a.consumed_at IS NULL
      AND a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) AND a.attempts <= ? AND m.status = 'active'`)
      .bind(tokenHash, now, now + AUTH_LIMITS.sessionSeconds, ...guards),
    db.prepare(`UPDATE auth_challenges SET consumed_at = ? WHERE ${condition}
      AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ?)`)
      .bind(now, ...guards, tokenHash),
    db.prepare(`UPDATE members SET last_login_at = ?, updated_at = ?
      WHERE member_id = (SELECT member_id FROM auth_sessions WHERE token_hash = ?)`)
      .bind(timestamp, timestamp, tokenHash),
    db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ?)`)
      .bind(now, previousHash ?? "", tokenHash),
  ]);
  return result[1].meta.changes === 1 && result[2].meta.changes === 1;
}
