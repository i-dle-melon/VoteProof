import { jsonSuccess } from "./response.js";
import { AUTH_LIMITS, AuthError, readAuthJson, onlyFields, normalizeEmail, passwordInput, invalidVerification } from "./auth-validation.js";
import { authContext, authHandler, createTransaction, readTransaction, credentials, consumeTransaction, revokeSessions, revokeDevices, recoverySet, totpGuard, advanceTotp } from "./auth.js";
import { withCookies, cookie, SESSION_COOKIE, LOGIN_COOKIE, DEVICE_COOKIE } from "../lib/auth-session.js";
import { authNow, throttle, authAtomic, credentialGuard, transactionGuard } from "../lib/auth-store.js";
import { recoveryHash, newTotp, encryptTotp, totpStep } from "../lib/auth-crypto.js";
import { findIdentity } from "../lib/auth-identity.js";
import { verifyPassword, supabaseConfig } from "../lib/supabase-auth.js";
import { updatePassword } from "../lib/password-operation.js";
const recoveryGuard = (memberId, payload) => ({ sql: `EXISTS(SELECT 1 FROM recovery_codes r JOIN member_credentials c USING(member_id)
 WHERE r.member_id=? AND r.generation=c.recovery_generation AND r.code_hash=? AND r.used_at IS NULL)`, args: [memberId, payload.code_hash] });
const recoveryStart = kind => authHandler(async (env, _url, request) => {
  const db = await authContext(request, env); supabaseConfig(env);
  const body = await readAuthJson(request); onlyFields(body, kind === "totp_recovery" ? ["email", "recovery_code", "password"] : ["email", "recovery_code", "code"]);
  const email = normalizeEmail(body.email);
  await throttle(request, env, kind + ":start", email);
  const record = await findIdentity(db, env, email), hash = await recoveryHash(record?.member_id ?? "missing", typeof body.recovery_code === "string" ? body.recovery_code : "invalid");
  const code = record && /^[A-Za-z0-9_-]{43}$/.test(body.recovery_code ?? "") ? await db.prepare("SELECT code_hash FROM recovery_codes WHERE member_id=? AND generation=? AND code_hash=? AND used_at IS NULL")
    .bind(record.member_id, record.recovery_generation, hash).first() : null;
  let valid = !!code && record.status === "active" && Boolean(record.password_enabled), step;
  if (kind === "totp_recovery") {
    const verified = await verifyPassword(env, email, passwordInput(body.password));
    valid = valid && verified?.id === record.provider_subject;
  } else if (valid) {
    try { step = await totpStep(record, record.member_id, body.code, env); }
    catch (e) { if (!(e instanceof AuthError)) throw e; valid = false; }
  }
  const data = valid ? { version: record.version, code_hash: hash } : { invalid: true };
  let setup;
  if (kind === "totp_recovery") {
    setup = newTotp(email);
    Object.assign(data, await encryptTotp(setup.secret, valid ? record.member_id : "M-" + crypto.randomUUID(), env));
  }
  if (valid && kind === "password_recovery") {
    // A fresh TOTP + unused recovery code may recover a pending password update.
    // It never grants a session or trusts the provider's previous outcome.
    const proofGuard = { sql: "EXISTS(SELECT 1 FROM member_credentials c JOIN members m USING(member_id) WHERE c.member_id=? AND c.version=? AND c.last_used_time_step<? AND m.status='active')", args: [record.member_id, record.version, step] };
    try { await authAtomic(db, [proofGuard, recoveryGuard(record.member_id, data)], [advanceTotp(db, record.member_id, step)]); }
    catch (e) { if (!(e instanceof AuthError)) throw e; valid = false; data.invalid = true; }
  }
  const tx = await createTransaction(db, kind, data, valid ? record.member_id : null);
  return withCookies(jsonSuccess({ transaction_id: tx.id, expires_in: AUTH_LIMITS.transactionSeconds,
    ...(setup ? { otpauth_uri: setup.otpauth_uri } : {}) }, "no-store", 202), tx.cookies);
});
export const passwordRecoveryStart = recoveryStart("password_recovery"), totpRecoveryStart = recoveryStart("totp_recovery");
const recoveryFinish = kind => authHandler(async (env, _url, request) => {
  const db = await authContext(request, env), body = await readAuthJson(request);
  onlyFields(body, kind === "password_recovery" ? ["transaction_id", "new_password"] : ["transaction_id", "code"]);
  const tx = await readTransaction(request, env, body, kind);
  if (!tx.member_id || tx.data.invalid) throw invalidVerification();
  let recovery;
  if (kind === "password_recovery") {
    await updatePassword(db, env, tx, passwordInput(body.new_password), "recovery");
  } else {
    const record = await credentials(db, tx.member_id);
    if (!record || record.status !== "active" || record.version !== tx.data.version) throw invalidVerification();
    const step = await totpStep(tx.data, tx.member_id, body.code, env);
    recovery = await recoverySet(db, tx.member_id, record.recovery_generation + 1);
    await authAtomic(db, [transactionGuard(tx), credentialGuard(tx.member_id, tx.data.version), recoveryGuard(tx.member_id, tx.data)], [
      db.prepare("UPDATE recovery_codes SET used_at=? WHERE member_id=? AND code_hash=? AND used_at IS NULL").bind(authNow(), tx.member_id, tx.data.code_hash),
      db.prepare(`UPDATE member_credentials SET totp_ciphertext=?,totp_iv=?,totp_key_version=?,last_used_time_step=?,version=version+1,recovery_generation=recovery_generation+1,updated_at=? WHERE member_id=?`)
        .bind(tx.data.totp_ciphertext, tx.data.totp_iv, tx.data.totp_key_version, step, authNow(), tx.member_id),
      ...recovery.statements, consumeTransaction(db, tx), revokeSessions(db, tx.member_id), revokeDevices(db, tx.member_id) ]);
  }
  return withCookies(jsonSuccess({ recovered: true, login_required: true, ...(recovery ? { recovery_codes: recovery.codes } : {}) }),
    [cookie(SESSION_COOKIE, "", 0), cookie(DEVICE_COOKIE, "", 0), cookie(LOGIN_COOKIE, "", 0)]);
});
export const passwordRecoveryFinish = recoveryFinish("password_recovery"), totpRecoveryFinish = recoveryFinish("totp_recovery");
