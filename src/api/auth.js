import { jsonSuccess, jsonError } from "./response.js";
import {
  AuthError,
  AUTH_LIMITS,
  readAuthJson,
  onlyFields,
  invalidVerification,
  transactionId,
} from "./auth-validation.js";
import { UploadError } from "./upload-validation.js";
import {
  authDatabase,
  authKey,
  newAuthToken,
  browserHash,
  sessionHash,
  SESSION_COOKIE,
  LOGIN_COOKIE,
  DEVICE_COOKIE,
  loginCsrf,
  readCookie,
  cookie,
  withCookies,
  sessionCookie,
  memberSession,
  publicMember,
  csrfToken,
} from "../lib/auth-session.js";
import {
  authCryptoConfig,
  deviceHash,
  recoveryHash,
} from "../lib/auth-crypto.js";
import {
  authNow,
  authAtomic,
  transactionGuard,
  throttle,
} from "../lib/auth-store.js";
export const authHandler = (action) => async (env, url, request) => {
  try {
    return await action(env, url, request);
  } catch (e) {
    if (e instanceof AuthError || e instanceof UploadError)
      return jsonError(
        e.status,
        e.code,
        e.message,
        e.status === 429
          ? { "retry-after": String(e.retryAfter ?? AUTH_LIMITS.windowSeconds) }
          : {},
      );
    return jsonError(
      503,
      "AUTH_SERVICE_UNAVAILABLE",
      "Authentication service is unavailable",
    );
  }
};
export async function authContext(request, env) {
  loginCsrf(request, env);
  authCryptoConfig(env);
  await authKey(env);
  return authDatabase(env);
}
export async function createTransaction(db, kind, payload, memberId = null) {
  const id = crypto.randomUUID(),
    browser = newAuthToken(),
    now = authNow();
  await db.batch([
    db
      .prepare(
        "DELETE FROM auth_transactions WHERE id IN(SELECT id FROM auth_transactions WHERE expires_at<=? ORDER BY expires_at LIMIT 100)",
      )
      .bind(now),
    db
      .prepare(
        "DELETE FROM auth_rate_limits WHERE rowid IN(SELECT rowid FROM auth_rate_limits WHERE expires_at<=? LIMIT 100)",
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO auth_transactions(id,kind,member_id,browser_hash,payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`,
      )
      .bind(
        id,
        kind,
        memberId,
        await browserHash(browser),
        JSON.stringify(payload),
        now,
        now + AUTH_LIMITS.transactionSeconds,
      ),
  ]);
  return {
    id,
    browser,
    cookies: [cookie(LOGIN_COOKIE, browser, AUTH_LIMITS.transactionSeconds)],
  };
}
export async function readTransaction(request, env, body, kind) {
  const id = transactionId(body.transaction_id),
    db = authDatabase(env);
  await throttle(request, env, kind + ":verify", id);
  let browser;
  try {
    browser = readCookie(request, LOGIN_COOKIE);
  } catch {
    throw invalidVerification();
  }
  if (!browser) throw invalidVerification();
  const tx = await db
    .prepare(
      `UPDATE auth_transactions SET attempts=attempts+1 WHERE id=? AND kind=? AND browser_hash=?
 AND consumed_at IS NULL AND expires_at>CAST(strftime('%s','now') AS INTEGER) AND attempts<? RETURNING *`,
    )
    .bind(id, kind, await browserHash(browser), AUTH_LIMITS.transactionAttempts)
    .first();
  if (!tx) throw invalidVerification();
  return { ...tx, data: JSON.parse(tx.payload) };
}
export const consumeTransaction = (db, tx) =>
  db
    .prepare("UPDATE auth_transactions SET consumed_at=? WHERE id=?")
    .bind(authNow(), tx.id);
export async function credentials(db, memberId) {
  return db
    .prepare(
      `SELECT c.*,m.login_name,m.status FROM member_credentials c JOIN members m USING(member_id) WHERE c.member_id=?`,
    )
    .bind(memberId)
    .first();
}
export const totpGuard = (memberId, version, step) => ({
  sql: `EXISTS(SELECT 1 FROM member_credentials c JOIN members m USING(member_id)
 WHERE c.member_id=? AND c.version=? AND c.last_used_time_step<? AND m.status='active')`,
  args: [memberId, version, step],
});
export const advanceTotp = (db, memberId, step) =>
  db
    .prepare(
      "UPDATE member_credentials SET last_used_time_step=? WHERE member_id=?",
    )
    .bind(step, memberId);
export async function recoverySet(db, memberId, generation) {
  const codes = Array.from({ length: AUTH_LIMITS.recoveryCount }, () =>
      newAuthToken(),
    ),
    now = authNow(),
    statements = [];
  for (const code of codes)
    statements.push(
      db
        .prepare(
          `INSERT INTO recovery_codes(member_id,generation,code_hash,created_at) VALUES(?,?,?,?)`,
        )
        .bind(memberId, generation, await recoveryHash(memberId, code), now),
    );
  return { codes, statements };
}
export const revokeSessions = (db, memberId) =>
  db
    .prepare(
      "UPDATE auth_sessions SET revoked_at=? WHERE member_id=? AND revoked_at IS NULL",
    )
    .bind(authNow(), memberId);
export const revokeDevices = (db, memberId) =>
  db
    .prepare(
      "UPDATE trusted_devices SET revoked_at=? WHERE member_id=? AND revoked_at IS NULL",
    )
    .bind(authNow(), memberId);
export async function issueSession(
  request,
  env,
  memberId,
  {
    guards,
    statements = [],
    remember = false,
    mfa = false,
    trust = false,
    tx,
    recoveryCodes,
  } = {},
) {
  const db = authDatabase(env),
    now = authNow(),
    token = newAuthToken(),
    hash = await sessionHash(token);
  const ttl = remember
    ? AUTH_LIMITS.rememberSeconds
    : AUTH_LIMITS.sessionSeconds;
  let previous;
  try {
    previous = readCookie(request, SESSION_COOKIE);
  } catch {
    /* Successful login rotates damaged cookies too. */
  }
  const cookies = [sessionCookie(token, ttl), cookie(LOGIN_COOKIE, "", 0)];
  if (previous)
    statements.push(
      db
        .prepare(
          "UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL",
        )
        .bind(now, await sessionHash(previous)),
    );
  statements.push(
    db
      .prepare(
        `INSERT INTO auth_sessions(token_hash,member_id,created_at,expires_at,elevated_until,reauthenticated_until) VALUES(?,?,?,?,?,?)`,
      )
      .bind(
        hash,
        memberId,
        now,
        now + ttl,
        mfa ? now + AUTH_LIMITS.elevationSeconds : 0,
        mfa ? now + AUTH_LIMITS.securitySeconds : 0,
      ),
  );
  if (trust) {
    const device = newAuthToken();
    // Bound active device growth and remove expired trust before issuing a new one.
    statements.push(
      db
        .prepare(
          `UPDATE trusted_devices SET revoked_at=? WHERE member_id=? AND revoked_at IS NULL
   AND id NOT IN(SELECT id FROM trusted_devices WHERE member_id=? AND revoked_at IS NULL AND expires_at>?
   ORDER BY created_at DESC,id DESC LIMIT ?)`,
        )
        .bind(now, memberId, memberId, now, AUTH_LIMITS.maxDevices - 1),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO trusted_devices(id,member_id,token_hash,created_at,last_used_at,expires_at) VALUES(?,?,?,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          memberId,
          await deviceHash(device),
          now,
          now,
          now + AUTH_LIMITS.deviceSeconds,
        ),
    );
    cookies.push(cookie(DEVICE_COOKIE, device, AUTH_LIMITS.deviceSeconds));
  }
  if (tx) {
    guards.push(transactionGuard(tx));
    statements.push(consumeTransaction(db, tx));
  }
  const timestamp = new Date().toISOString();
  statements.push(
    db
      .prepare(
        "UPDATE members SET last_login_at=?,updated_at=? WHERE member_id=?",
      )
      .bind(timestamp, timestamp, memberId),
  );
  await authAtomic(db, guards, statements);
  const member = await memberSession(
    new Request(request.url, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    }),
    env,
  );
  return withCookies(
    jsonSuccess({
      member: publicMember(member),
      csrf_token: await csrfToken(member, env),
      expires_in: ttl,
      ...(recoveryCodes ? { recovery_codes: recoveryCodes } : {}),
    }),
    cookies,
  );
}
export const currentMember = authHandler(async (env, _url, request) => {
  const member = await memberSession(request, env);
  return jsonSuccess({
    member: publicMember(member),
    csrf_token: await csrfToken(member, env),
    expires_at: member.expires_at,
    elevated_until: member.elevated_until,
    reauthenticated_until: member.reauthenticated_until,
  });
});
export const logout = authHandler(async (env, _url, request) => {
  loginCsrf(request, env);
  if (request.headers.has("Content-Type"))
    onlyFields(await readAuthJson(request), []);
  else if (request.body) {
    // workerd exposes an empty stream even for an empty POST. Keep legacy
    // logout compatible, while rejecting any non-JSON bytes immediately.
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength) {
          await reader.cancel();
          throw new AuthError(400, "INVALID_JSON", "A JSON body is required");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  let token;
  try {
    token = readCookie(request, SESSION_COOKIE);
  } catch {
    /* Always discard damaged cookies. */
  }
  if (token)
    await authDatabase(env)
      .prepare(
        "UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL",
      )
      .bind(authNow(), await sessionHash(token))
      .run();
  return withCookies(jsonSuccess({ logged_out: true }), [
    cookie(SESSION_COOKIE, "", 0),
    cookie(LOGIN_COOKIE, "", 0),
  ]);
});
export const emptyBody = async (request) =>
  onlyFields(await readAuthJson(request), []);
