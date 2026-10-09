import {
  AUTH_LIMITS,
  AuthError,
  invalidVerification,
} from "../api/auth-validation.js";
import { authMac, authKey, authDatabase } from "./auth-session.js";
export const authNow = () => Math.floor(Date.now() / 1000);
export async function rateLimit(
  db,
  key,
  scope,
  value,
  maximum,
  windowSeconds = AUTH_LIMITS.windowSeconds,
) {
  const now = authNow(),
    start = now - (now % windowSeconds),
    hash = await authMac(key, "rate-limit:" + scope, value);
  const result = await db
    .prepare(
      `INSERT INTO auth_rate_limits(scope_hash,window_start,count,expires_at) VALUES(?,?,1,?)
 ON CONFLICT(scope_hash,window_start) DO UPDATE SET count=count+1 WHERE count < ?`,
    )
    .bind(hash, start, start + windowSeconds, maximum)
    .run();
  return result.meta.changes === 1;
}
export function rateError(seconds = AUTH_LIMITS.windowSeconds) {
  const error = new AuthError(
    429,
    "AUTH_RATE_LIMITED",
    "Too many authentication requests; try again later",
  );
  error.retryAfter = seconds;
  return error;
}
export async function throttle(
  request,
  env,
  scope,
  account,
  maximum = AUTH_LIMITS.accountAttempts,
  kdf = false,
) {
  const db = authDatabase(env),
    key = await authKey(env);
  if (
    !(await rateLimit(
      db,
      key,
      scope + ":ip",
      request.headers.get("CF-Connecting-IP") ?? "unknown",
      AUTH_LIMITS.ipAttempts,
    )) ||
    !(await rateLimit(db, key, scope + ":account", account, maximum))
  )
    throw rateError();
  if (
    kdf &&
    !(await rateLimit(
      db,
      key,
      "kdf-global",
      "all",
      AUTH_LIMITS.globalKdfs,
      3600,
    ))
  )
    throw rateError(3600);
}
export async function authAtomic(db, guards, statements) {
  const id = crypto.randomUUID();
  try {
    return await db.batch([
      db
        .prepare(
          `INSERT INTO auth_atomic_guards(id,valid) SELECT ?,CASE WHEN ${guards.map((g) => "(" + g.sql + ")").join(" AND ")} THEN 1 ELSE 0 END`,
        )
        .bind(id, ...guards.flatMap((g) => g.args)),
      ...statements,
      db.prepare("DELETE FROM auth_atomic_guards WHERE id=?").bind(id),
    ]);
  } catch (e) {
    if (String(e.message).includes("CHECK constraint failed: valid=1"))
      throw invalidVerification();
    throw e;
  }
}
export const credentialGuard = (member, version) => ({
  sql: `EXISTS(SELECT 1 FROM member_credentials c JOIN members m USING(member_id)
 WHERE c.member_id=? AND c.version=? AND m.status='active')`,
  args: [member, version],
});
export const transactionGuard = (tx) => ({
  sql: `EXISTS(SELECT 1 FROM auth_transactions WHERE id=? AND browser_hash=? AND kind=?
 AND consumed_at IS NULL AND attempts<=? AND expires_at>CAST(strftime('%s','now') AS INTEGER))`,
  args: [tx.id, tx.browser_hash, tx.kind, AUTH_LIMITS.transactionAttempts],
});
export const activeSessionGuard = (member) => ({
  sql: `EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=? AND member_id=? AND revoked_at IS NULL
 AND expires_at>CAST(strftime('%s','now') AS INTEGER))`,
  args: [member.tokenHash, member.member_id],
});
export const recentSessionGuard = (member) => ({
  sql: `EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=? AND revoked_at IS NULL
 AND reauthenticated_until>CAST(strftime('%s','now') AS INTEGER) AND expires_at>CAST(strftime('%s','now') AS INTEGER))`,
  args: [member.tokenHash],
});
