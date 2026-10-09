import { verifyPassword } from "../lib/supabase-auth.js";
import { findIdentity } from "../lib/auth-identity.js";
import { jsonSuccess } from "./response.js";
import {
  AUTH_LIMITS,
  AuthError,
  readAuthJson,
  onlyFields,
  normalizeEmail,
  passwordInput,
  booleanInput,
  invalidVerification,
} from "./auth-validation.js";
import {
  withCookies,
  readCookie,
  DEVICE_COOKIE,
  authDatabase,
} from "../lib/auth-session.js";
import {
  totpStep,
  deviceHash,
} from "../lib/auth-crypto.js";
import { authNow, throttle, credentialGuard } from "../lib/auth-store.js";
import {
  authHandler,
  authContext,
  createTransaction,
  readTransaction,
  issueSession,
  recoverySet,
  credentials,
  totpGuard,
  advanceTotp,
} from "./auth.js";
export { registrationStart } from "./auth-registration.js";
export const registrationVerify = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env),
    body = await readAuthJson(request);
  onlyFields(body, [
    "transaction_id",
    "code",
    "trust_this_device",
    "remember_me",
  ]);
  const trust = booleanInput(body.trust_this_device),
    remember = booleanInput(body.remember_me),
    tx = await readTransaction(request, env, body, "register"),
    data = tx.data;
  const step = await totpStep(data, data.member_id, body.code, env),
    now = authNow(),
    timestamp = new Date().toISOString();
  const recovery = await recoverySet(db, data.member_id, 1);
  return issueSession(request, env, data.member_id, {
    remember,
    mfa: true,
    trust,
    tx,
    recoveryCodes: recovery.codes,
    guards: [
      {sql: "EXISTS(SELECT 1 FROM auth_enrollments WHERE id=? AND state='pending' AND provider_subject=? AND totp_transaction_id=? AND expires_at>CAST(strftime('%s','now') AS INTEGER))", args:[data.enrollment_id,data.provider_subject,tx.id]},
      {
        sql: "NOT EXISTS(SELECT 1 FROM members WHERE login_name=?)",
        args: [data.login_name],
      },
    ],
    statements: [
      db.prepare("UPDATE auth_enrollments SET state='active' WHERE id=?").bind(data.enrollment_id),
      db
        .prepare(
          "INSERT INTO members(id,member_id,login_name,nickname,player_id,created_at,updated_at,last_login_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          data.member_id,
          data.login_name,
          data.nickname,
          data.player_id ?? null,
          timestamp,
          timestamp,
          timestamp,
        ),
      db
        .prepare(
          `INSERT INTO member_credentials(member_id,totp_ciphertext,totp_iv,totp_key_version,last_used_time_step,updated_at) VALUES(?,?,?,?,?,?)`,
        )
        .bind(
          data.member_id,
          data.totp_ciphertext,
          data.totp_iv,
          data.totp_key_version,
          step,
          now,
        ),
      db.prepare("INSERT INTO auth_identities(provider,provider_subject,member_id,email_lookup_hash,email_ciphertext,email_iv,email_key_version,created_at) VALUES('supabase',?,?,?,?,?,?,?)").bind(data.provider_subject,data.member_id,data.email_lookup_hash,data.email_ciphertext,data.email_iv,data.email_key_version,now),
      ...recovery.statements,
    ],
  });
});
const loginFailure = () =>
  new AuthError(
    401,
    "AUTH_LOGIN_FAILED",
    "Account or authentication is invalid",
  );
export const passwordLogin = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env),
    body = await readAuthJson(request);
  onlyFields(body, ["email", "password", "remember_me"]);
  const name = normalizeEmail(body.email),
    password = passwordInput(body.password),
    remember = booleanInput(body.remember_me);
  await throttle(
    request,
    env,
    "password-login",
    name,
    AUTH_LIMITS.accountAttempts,
  );
  const record = await findIdentity(db, env, name);
  const verified = await verifyPassword(env, name, password);
  const locked = record ? await db.prepare("SELECT id FROM auth_password_operations WHERE member_id=? AND status='pending'").bind(record.member_id).first() : null;
  if (!verified || !record || !record.password_enabled || !record.version || verified.id !== record.provider_subject || record.status !== "active" || locked) throw loginFailure();
  const member = { member_id: record.member_id };
  let token;
  try {
    token = readCookie(request, DEVICE_COOKIE);
  } catch {
    /* Invalid trust cannot grant authentication. */
  }
  const hash = token ? await deviceHash(token) : null;
  const device = hash
    ? await db
        .prepare(
          `SELECT id FROM trusted_devices WHERE token_hash=? AND member_id=? AND revoked_at IS NULL AND expires_at>?`,
        )
        .bind(hash, member.member_id, authNow())
        .first()
    : null;
  if (device)
    return issueSession(request, env, member.member_id, {
      remember,
      guards: [
        credentialGuard(member.member_id, record.version),
        {
          sql: `EXISTS(SELECT 1 FROM trusted_devices WHERE id=? AND member_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>CAST(strftime('%s','now') AS INTEGER))`,
          args: [device.id, member.member_id, hash],
        },
      ],
      statements: [
        db
          .prepare("UPDATE trusted_devices SET last_used_at=? WHERE id=?")
          .bind(authNow(), device.id),
      ],
    });
  const tx = await createTransaction(
    db,
    "login",
    { version: record.version, remember_me: remember },
    member.member_id,
  );
  return withCookies(
    jsonSuccess(
      {
        status: "MFA_REQUIRED",
        transaction_id: tx.id,
        expires_in: AUTH_LIMITS.transactionSeconds,
      },
      "no-store",
      202,
    ),
    tx.cookies,
  );
});
export const loginTotp = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env),
    body = await readAuthJson(request);
  onlyFields(body, ["transaction_id", "code", "trust_this_device"]);
  const trust = booleanInput(body.trust_this_device),
    tx = await readTransaction(request, env, body, "login"),
    record = await credentials(db, tx.member_id);
  if (
    !record ||
    record.status !== "active" ||
    record.version !== tx.data.version
  )
    throw invalidVerification();
  const step = await totpStep(record, tx.member_id, body.code, env);
  return issueSession(request, env, tx.member_id, {
    remember: tx.data.remember_me,
    mfa: true,
    trust,
    tx,
    guards: [totpGuard(tx.member_id, record.version, step)],
    statements: [advanceTotp(db, tx.member_id, step)],
  });
});
