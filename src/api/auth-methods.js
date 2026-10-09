import { authHandler, authContext, createTransaction, readTransaction, consumeTransaction, issueSession, credentials, recoverySet, advanceTotp, totpGuard } from "./auth.js";
import { AuthError, AUTH_LIMITS, readAuthJson, onlyFields, passwordInput, invalidVerification } from "./auth-validation.js";
import { authDatabase, memberSession, memberCsrf, withCookies, authKey, authMac } from "../lib/auth-session.js";
import { authNow, authAtomic, transactionGuard, activeSessionGuard, throttle } from "../lib/auth-store.js";
import { newTotp, encryptTotp, totpStep } from "../lib/auth-crypto.js";
import { decryptEmail } from "../lib/auth-identity.js";
import { adminUpdatePassword } from "../lib/supabase-auth.js";
import { jsonSuccess } from "./response.js";
import { activeIdentity, identityEvent, googleProof } from "./auth-google.js";

const methodUnavailable = () => new AuthError(409, "AUTH_METHOD_CONFLICT", "Login method setup cannot be completed; restart or contact support");
async function freshGoogle(request, env) {
  const member = await memberSession(request, env); await memberCsrf(request, env, member);
  if (member.auth_method !== "google" || member.google_authenticated_until <= authNow()) throw new AuthError(403, "AUTH_GOOGLE_REAUTH_REQUIRED", "Authenticate with Google again before changing login security");
  return member;
}
export const addPasswordStart = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env), body = await readAuthJson(request); onlyFields(body, ["confirmed", "transaction_id"]);
  if (body.confirmed !== true) throw invalidVerification();
  let member, source, guards = [];
  if (body.transaction_id) {
    source = await readTransaction(request, env, body, "email_register");
    if (!source.member_id || !source.data.add_password) throw invalidVerification();
    member = await db.prepare("SELECT member_id,status FROM members WHERE member_id=? AND status='active'").bind(source.member_id).first();
    if (!member) throw invalidVerification();
    guards.push(transactionGuard(source));
  } else { member = await freshGoogle(request, env); guards.push(activeSessionGuard(member)); }
  await throttle(request, env, "method-start", member.member_id);
  const identity = await db.prepare("SELECT * FROM auth_identities WHERE member_id=? AND password_enabled=0 AND google_identity_id IS NOT NULL").bind(member.member_id).first();
  if (!identity) throw methodUnavailable();
  const record = await credentials(db, member.member_id);
  const setup = record ? null : newTotp(await decryptEmail(env, identity, identity.provider_subject));
  const tx = await createTransaction(db, "add_password", { provider_subject: identity.provider_subject, version: record?.version ?? 0,
    session_hash: source ? null : member.tokenHash, ...(setup ? await encryptTotp(setup.secret, member.member_id, env) : {}) }, member.member_id);
  guards.push(activeIdentity(member.member_id, identity.provider_subject));
  await authAtomic(db, guards, source ? [consumeTransaction(db, source)] : []);
  return withCookies(jsonSuccess({ status: "PASSWORD_MFA_REQUIRED", transaction_id: tx.id, expires_in: AUTH_LIMITS.transactionSeconds,
    ...(setup ? { otpauth_uri: setup.otpauth_uri } : { authenticator_already_configured: true }) }, "no-store", 202), tx.cookies);
});

async function setupOwner(request, env, tx) {
  if (tx.data.session_hash) {
    const member = await memberSession(request, env); await memberCsrf(request, env, member);
    if (member.member_id !== tx.member_id || member.tokenHash !== tx.data.session_hash) throw invalidVerification();
    return [activeSessionGuard(member)];
  }
  return [];
}
function insertCredentials(db, tx, step) {
  return db.prepare(`INSERT INTO member_credentials(member_id,totp_ciphertext,totp_iv,totp_key_version,last_used_time_step,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(tx.member_id, tx.data.totp_ciphertext, tx.data.totp_iv, tx.data.totp_key_version, step, authNow());
}
export const addPasswordVerify = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env), body = await readAuthJson(request); onlyFields(body, ["transaction_id", "new_password", "code"]);
  const password = passwordInput(body.new_password), tx = await readTransaction(request, env, body, "add_password");
  const guards = await setupOwner(request, env, tx), record = await credentials(db, tx.member_id);
  if ((record?.version ?? 0) !== tx.data.version) throw methodUnavailable();
  const step = await totpStep(record ?? tx.data, tx.member_id, body.code, env);
  guards.push(transactionGuard(tx), activeIdentity(tx.member_id, tx.data.provider_subject),
    { sql: "EXISTS(SELECT 1 FROM auth_identities WHERE member_id=? AND password_enabled=0 AND google_identity_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM auth_password_operations WHERE member_id=? AND status='pending')", args: [tx.member_id, tx.member_id] });
  guards.push(record ? totpGuard(tx.member_id, record.version, step) : { sql: "NOT EXISTS(SELECT 1 FROM member_credentials WHERE member_id=?)", args: [tx.member_id] });
  const digest = await authMac(await authKey(env), "password-method-retry", JSON.stringify([tx.id, password])), owner = crypto.randomUUID();
  // Unique per-member reservation survives an uncertain provider write. A new
  // transaction must never replace it; verified same-password retries may finish.
  await authAtomic(db, guards, [db.prepare(`INSERT INTO auth_method_setups(member_id,transaction_id,password_digest,created_at) VALUES(?,?,?,?) ON CONFLICT(member_id) DO NOTHING`).bind(tx.member_id, tx.id, digest, authNow())]);
  const claim = await db.prepare("UPDATE auth_method_setups SET lease_owner=?,lease_until=? WHERE member_id=? AND transaction_id=? AND password_digest=? AND lease_until<=? RETURNING member_id")
    .bind(owner, authNow() + 30, tx.member_id, tx.id, digest, authNow()).first();
  if (!claim) throw methodUnavailable();
  try {
    await adminUpdatePassword(env, tx.data.provider_subject, password);
    const generation = (record?.recovery_generation ?? 0) + 1, recovery = await recoverySet(db, tx.member_id, generation);
    guards.push({ sql: "EXISTS(SELECT 1 FROM auth_method_setups WHERE member_id=? AND transaction_id=? AND lease_owner=?)", args: [tx.member_id, tx.id, owner] });
    const statements = [record ? advanceTotp(db, tx.member_id, step) : insertCredentials(db, tx, step)];
    if (record) statements.push(db.prepare("UPDATE member_credentials SET recovery_generation=?,version=version+1,updated_at=? WHERE member_id=?").bind(generation, authNow(), tx.member_id), db.prepare("DELETE FROM recovery_codes WHERE member_id=?").bind(tx.member_id));
    statements.push(...recovery.statements,
      db.prepare("UPDATE auth_identities SET password_enabled=1 WHERE member_id=?").bind(tx.member_id),
      db.prepare("DELETE FROM auth_method_setups WHERE member_id=? AND lease_owner=?").bind(tx.member_id, owner), identityEvent(db, tx.member_id, tx.id, "password_enabled"));
    return await issueSession(request, env, tx.member_id, { guards, statements, tx, mfa: true, recoveryCodes: recovery.codes });
  } catch (e) {
    // No global auth lock: Google remains usable. Password flag is still false.
    try { await db.prepare("UPDATE auth_method_setups SET lease_until=0,lease_owner=NULL WHERE member_id=? AND lease_owner=?").bind(tx.member_id, owner).run(); } catch { console.warn("Login method reservation requires reconciliation"); }
    throw e;
  }
});

export const googleTotpEnrollStart = authHandler(async (env, _url, request) => {
  await authContext(request, env); const body = await readAuthJson(request); onlyFields(body, ["confirmed"]);
  if (body.confirmed !== true) throw invalidVerification();
  const member = await freshGoogle(request, env), db = authDatabase(env);
  await throttle(request, env, "totp-enroll", member.member_id);
  if (await credentials(db, member.member_id)) throw methodUnavailable();
  const setup = newTotp(member.member_id);
  const tx = await createTransaction(db, "totp_enroll", { session_hash: member.tokenHash, ...(await encryptTotp(setup.secret, member.member_id, env)) }, member.member_id);
  return withCookies(jsonSuccess({ transaction_id: tx.id, otpauth_uri: setup.otpauth_uri, expires_in: AUTH_LIMITS.transactionSeconds }, "no-store", 202), tx.cookies);
});
export const googleTotpEnrollVerify = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env), body = await readAuthJson(request); onlyFields(body, ["transaction_id", "code"]);
  const tx = await readTransaction(request, env, body, "totp_enroll"), guards = await setupOwner(request, env, tx);
  const step = await totpStep(tx.data, tx.member_id, body.code, env), recovery = await recoverySet(db, tx.member_id, 1);
  guards.push(transactionGuard(tx), { sql: "NOT EXISTS(SELECT 1 FROM member_credentials WHERE member_id=?) AND EXISTS(SELECT 1 FROM members WHERE member_id=? AND status='active')", args: [tx.member_id, tx.member_id] });
  await authAtomic(db, guards, [insertCredentials(db, tx, step), ...recovery.statements, consumeTransaction(db, tx), identityEvent(db, tx.member_id, tx.id, "totp_enrolled")]);
  // Enrollment alone grants no elevated access; fresh OAuth+TOTP step-up follows.
  return jsonSuccess({ authenticator_configured: true, recovery_codes: recovery.codes });
});
export const googleStepUp = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env), body = await readAuthJson(request); onlyFields(body, ["transaction_id", "code"]);
  const tx = await googleProof(request, env, body);
  if (tx.data.purpose !== "security" || !tx.member_id || !tx.data.session_hash) throw invalidVerification();
  const member = await memberSession(request, env), record = await credentials(db, tx.member_id);
  if (!record) throw new AuthError(403, "AUTH_MFA_ENROLLMENT_REQUIRED", "Enroll VoteProof Authenticator before elevated access");
  const step = await totpStep(record, tx.member_id, body.code, env), now = authNow();
  await authAtomic(db, [activeSessionGuard(member), transactionGuard(tx), activeIdentity(member.member_id, tx.data.provider_subject), totpGuard(member.member_id, record.version, step)], [
    advanceTotp(db, member.member_id, step), consumeTransaction(db, tx),
    db.prepare("UPDATE auth_sessions SET elevated_until=?,reauthenticated_until=? WHERE token_hash=?").bind(now + AUTH_LIMITS.elevationSeconds, now + AUTH_LIMITS.securitySeconds, member.tokenHash), identityEvent(db, member.member_id, tx.id, "google_step_up")]);
  return jsonSuccess({ elevated_until: now + AUTH_LIMITS.elevationSeconds, reauthenticated_until: now + AUTH_LIMITS.securitySeconds });
});
