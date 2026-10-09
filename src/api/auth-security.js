import { jsonSuccess } from "./response.js";
import {
  AUTH_LIMITS,
  AuthError,
  readAuthJson,
  onlyFields,
  passwordInput,
  invalidVerification,
  transactionId,
} from "./auth-validation.js";
import {
  authDatabase,
  memberSession,
  memberCsrf,
  withCookies,
  cookie,
  SESSION_COOKIE,
  DEVICE_COOKIE,
  LOGIN_COOKIE,
  readCookie,
} from "../lib/auth-session.js";
import {
  authCryptoConfig,
  verifyPassword,
  passwordRecord,
  totpStep,
  newTotp,
  encryptTotp,
  deviceHash,
} from "../lib/auth-crypto.js";
import {
  authNow,
  throttle,
  authAtomic,
  credentialGuard,
  activeSessionGuard,
  recentSessionGuard,
  transactionGuard,
} from "../lib/auth-store.js";
import {
  authHandler,
  credentials,
  totpGuard,
  advanceTotp,
  recoverySet,
  revokeSessions,
  revokeDevices,
  emptyBody,
  createTransaction,
  readTransaction,
  consumeTransaction,
} from "./auth.js";
export async function securityContext(request, env, recent = true) {
  const member = await memberSession(request, env);
  await memberCsrf(request, env, member);
  authCryptoConfig(env);
  if (recent && member.reauthenticated_until <= authNow())
    throw new AuthError(
      403,
      "AUTH_STEP_UP_REQUIRED",
      "Recent password and multi-factor authentication is required",
    );
  await throttle(request, env, "security", member.member_id);
  return { member, db: authDatabase(env) };
}
export const stepUp = authHandler(async (env, _url, request) => {
  const { member, db } = await securityContext(request, env, false),
    body = await readAuthJson(request);
  onlyFields(body, ["password", "code"]);
  const password = passwordInput(body.password);
  await throttle(
    request,
    env,
    "step-up",
    member.member_id,
    AUTH_LIMITS.accountAttempts,
    true,
  );
  const record = await credentials(db, member.member_id);
  if (!record || !(await verifyPassword(password, record.password_record, env)))
    throw invalidVerification();
  const step = await totpStep(record, member.member_id, body.code, env),
    now = authNow();
  await authAtomic(
    db,
    [
      activeSessionGuard(member),
      totpGuard(member.member_id, record.version, step),
    ],
    [
      advanceTotp(db, member.member_id, step),
      db
        .prepare(
          "UPDATE auth_sessions SET elevated_until=?,reauthenticated_until=? WHERE token_hash=?",
        )
        .bind(
          now + AUTH_LIMITS.elevationSeconds,
          now + AUTH_LIMITS.securitySeconds,
          member.tokenHash,
        ),
    ],
  );
  return jsonSuccess({
    elevated_until: now + AUTH_LIMITS.elevationSeconds,
    reauthenticated_until: now + AUTH_LIMITS.securitySeconds,
  });
});
export const passwordChange = authHandler(async (env, _url, request) => {
  const { member, db } = await securityContext(request, env),
    body = await readAuthJson(request);
  onlyFields(body, ["new_password"]);
  const password = passwordInput(body.new_password);
  await throttle(
    request,
    env,
    "password-change",
    member.member_id,
    AUTH_LIMITS.accountAttempts,
    true,
  );
  const record = await credentials(db, member.member_id),
    next = await passwordRecord(password, env);
  await authAtomic(
    db,
    [
      credentialGuard(member.member_id, record.version),
      recentSessionGuard(member),
    ],
    [
      db
        .prepare(
          "UPDATE member_credentials SET password_record=?,version=version+1,updated_at=? WHERE member_id=?",
        )
        .bind(next, authNow(), member.member_id),
      revokeSessions(db, member.member_id),
      revokeDevices(db, member.member_id),
    ],
  );
  return withCookies(
    jsonSuccess({ password_changed: true, logged_out: true }),
    [
      cookie(SESSION_COOKIE, "", 0),
      cookie(DEVICE_COOKIE, "", 0),
      cookie(LOGIN_COOKIE, "", 0),
    ],
  );
});
export const regenerateRecovery = authHandler(async (env, _url, request) => {
  const { member, db } = await securityContext(request, env);
  await emptyBody(request);
  const record = await credentials(db, member.member_id),
    generation = record.recovery_generation + 1,
    set = await recoverySet(db, member.member_id, generation);
  await authAtomic(
    db,
    [
      credentialGuard(member.member_id, record.version),
      recentSessionGuard(member),
      {
        sql: "EXISTS(SELECT 1 FROM member_credentials WHERE member_id=? AND recovery_generation=?)",
        args: [member.member_id, record.recovery_generation],
      },
    ],
    [
      db
        .prepare(
          "UPDATE member_credentials SET recovery_generation=?,version=version+1,updated_at=? WHERE member_id=?",
        )
        .bind(generation, authNow(), member.member_id),
      db
        .prepare("DELETE FROM recovery_codes WHERE member_id=?")
        .bind(member.member_id),
      ...set.statements,
    ],
  );
  return jsonSuccess({ recovery_codes: set.codes });
});
export const listDevices = authHandler(async (env, _url, request) => {
  const member = await memberSession(request, env),
    db = authDatabase(env);
  const devices = (
    await db
      .prepare(
        `SELECT id,created_at,last_used_at,expires_at,label FROM trusted_devices
 WHERE member_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .bind(member.member_id, authNow(), AUTH_LIMITS.maxDevices)
      .all()
  ).results;
  return jsonSuccess({ devices });
});
export const revokeDevice = authHandler(async (env, url, request) => {
  const { member, db } = await securityContext(request, env);
  await emptyBody(request);
  const id = transactionId(url.pathname.split("/").at(-2));
  await authAtomic(
    db,
    [
      recentSessionGuard(member),
      {
        sql: "EXISTS(SELECT 1 FROM members WHERE member_id=? AND status='active')",
        args: [member.member_id],
      },
    ],
    [
      db
        .prepare(
          "UPDATE trusted_devices SET revoked_at=? WHERE id=? AND member_id=? AND revoked_at IS NULL",
        )
        .bind(authNow(), id, member.member_id),
    ],
  );
  return jsonSuccess({ revoked: true }); // Does not reveal another member's devices.
});
export const revokeOtherDevices = authHandler(async (env, _url, request) => {
  const { member, db } = await securityContext(request, env);
  await emptyBody(request);
  let token;
  try {
    token = readCookie(request, DEVICE_COOKIE);
  } catch {
    /* No retained device. */
  }
  const hash = token ? await deviceHash(token) : "";
  await authAtomic(
    db,
    [
      recentSessionGuard(member),
      {
        sql: "EXISTS(SELECT 1 FROM members WHERE member_id=? AND status='active')",
        args: [member.member_id],
      },
    ],
    [
      db
        .prepare(
          "UPDATE trusted_devices SET revoked_at=? WHERE member_id=? AND token_hash<>? AND revoked_at IS NULL",
        )
        .bind(authNow(), member.member_id, hash),
    ],
  );
  return jsonSuccess({ revoked: true });
});
export const totpResetStart = authHandler(async (env, _url, request) => {
  const { member, db } = await securityContext(request, env);
  await emptyBody(request);
  await throttle(request, env, "totp-reset", member.member_id);
  const record = await credentials(db, member.member_id),
    setup = newTotp(record.login_name);
  const tx = await createTransaction(
    db,
    "totp_reset",
    {
      version: record.version,
      session_hash: member.tokenHash,
      ...(await encryptTotp(setup.secret, member.member_id, env)),
    },
    member.member_id,
  );
  return withCookies(
    jsonSuccess(
      {
        transaction_id: tx.id,
        expires_in: AUTH_LIMITS.transactionSeconds,
        otpauth_uri: setup.otpauth_uri,
      },
      "no-store",
      202,
    ),
    tx.cookies,
  );
});
export const totpResetVerify = authHandler(async (env, _url, request) => {
  const { member, db } = await securityContext(request, env),
    body = await readAuthJson(request);
  onlyFields(body, ["transaction_id", "code"]);
  const tx = await readTransaction(request, env, body, "totp_reset");
  if (
    tx.member_id !== member.member_id ||
    tx.data.session_hash !== member.tokenHash
  )
    throw invalidVerification();
  const step = await totpStep(tx.data, member.member_id, body.code, env),
    record = await credentials(db, member.member_id);
  const recovery = await recoverySet(
    db,
    member.member_id,
    record.recovery_generation + 1,
  );
  await authAtomic(
    db,
    [
      transactionGuard(tx),
      credentialGuard(member.member_id, tx.data.version),
      recentSessionGuard(member),
    ],
    [
      db
        .prepare(
          `UPDATE member_credentials SET totp_ciphertext=?,totp_iv=?,totp_key_version=?,last_used_time_step=?,
 version=version+1,recovery_generation=recovery_generation+1,updated_at=? WHERE member_id=?`,
        )
        .bind(
          tx.data.totp_ciphertext,
          tx.data.totp_iv,
          tx.data.totp_key_version,
          step,
          authNow(),
          member.member_id,
        ),
      db
        .prepare("DELETE FROM recovery_codes WHERE member_id=?")
        .bind(member.member_id),
      ...recovery.statements,
      consumeTransaction(db, tx),
      revokeSessions(db, member.member_id),
      revokeDevices(db, member.member_id),
    ],
  );
  return withCookies(
    jsonSuccess({
      totp_reset: true,
      logged_out: true,
      recovery_codes: recovery.codes,
    }),
    [
      cookie(SESSION_COOKIE, "", 0),
      cookie(DEVICE_COOKIE, "", 0),
      cookie(LOGIN_COOKIE, "", 0),
    ],
  );
});
