import { jsonSuccess } from "./response.js";
import { AuthError, AUTH_LIMITS, readAuthJson, onlyFields, normalizeEmail, passwordInput, profileInput, transactionId, invalidVerification } from "./auth-validation.js";
import { verifyTurnstile } from "./turnstile.js";
import { UPLOAD_LIMITS, UploadError } from "./upload-validation.js";
import { authHandler, authContext, createTransaction, readTransaction } from "./auth.js";
import { authDatabase, newAuthToken, browserHash, LOGIN_COOKIE, cookie, withCookies, readCookie, configuredAuthOrigin } from "../lib/auth-session.js";
import { authNow, authAtomic, transactionGuard, throttle } from "../lib/auth-store.js";
import { newTotp, encryptTotp } from "../lib/auth-crypto.js";
import { emailHash, codeHash, sourceHash, encryptEmail, decryptEmail, findIdentity } from "../lib/auth-identity.js";
import { supabaseConfig, adminCreateVerifiedUser, adminDeleteUser } from "../lib/supabase-auth.js";
import { mailConfig, sendVerificationEmail } from "../lib/mail-relay.js";
import { EMAIL_LIMITS, emailBudget, reserveEmail } from "../lib/registration-quota.js";
import { equalQueryHash } from "../lib/case-keys.js";
function randomCode() {
  const sample = new Uint32Array(1); do { crypto.getRandomValues(sample); } while (sample[0] >= 4294000000);
  return String(sample[0] % 1000000).padStart(6, "0");
}
function configuration(env) { supabaseConfig(env); mailConfig(env); }
async function delivered(db, env, eventId, email, code) {
  try { await sendVerificationEmail(env, email, code); await db.prepare("UPDATE auth_email_sends SET status='sent' WHERE id=?").bind(eventId).run(); }
  catch (e) { try { await db.prepare("UPDATE auth_email_sends SET status='failed' WHERE id=?").bind(eventId).run(); } catch { /* Reservation still counts: delivery may have occurred. */ } throw e; }
}
export const registrationStatus = authHandler(async (env) => {
  try { configuration(env); await authContextStatus(env); } catch { return jsonSuccess({ registration_available: false }); }
  const budget = await emailBudget(authDatabase(env), env);
  return jsonSuccess({ registration_available: budget.available, ...(!budget.available ? { retry_after: budget.retryAfter } : {}) });
});
async function authContextStatus(env) {
  const { authCryptoConfig } = await import("../lib/auth-crypto.js"); authCryptoConfig(env); authDatabase(env);
  configuredAuthOrigin(env);
}
export const registrationStart = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env); configuration(env);
  const body = await readAuthJson(request); onlyFields(body, ["email", "turnstile_token"]);
  const email = normalizeEmail(body.email);
  if (typeof body.turnstile_token !== "string" || !body.turnstile_token.trim()) throw new UploadError(400, "TURNSTILE_REQUIRED", "Turnstile verification is required");
  if (body.turnstile_token.length > UPLOAD_LIMITS.maxTokenLength) throw new AuthError(400, "INVALID_AUTH_REQUEST", "Invalid authentication request");
  await verifyTurnstile(request, env, body.turnstile_token.trim());
  const id = crypto.randomUUID(), eventId = crypto.randomUUID(), browser = newAuthToken(), code = randomCode(), now = authNow();
  const lookup = await emailHash(env, email), encrypted = await encryptEmail(env, email, id);
  await reserveEmail(db, env, { id: eventId, challengeId: id, emailHash: lookup, sourceHash: await sourceHash(env, request), statements: [
    db.prepare(`INSERT INTO auth_email_challenges(id,email_lookup_hash,browser_hash,code_hash,email_ciphertext,email_iv,email_key_version,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .bind(id, lookup, await browserHash(browser), await codeHash(env, id, code), encrypted.email_ciphertext, encrypted.email_iv, encrypted.email_key_version, now, now + EMAIL_LIMITS.codeSeconds) ] });
  await delivered(db, env, eventId, email, code);
  return withCookies(jsonSuccess({ challenge_id: id, expires_in: EMAIL_LIMITS.codeSeconds, message: "If registration is available, a verification email has been sent" }, "no-store", 202), [cookie(LOGIN_COOKIE, browser, EMAIL_LIMITS.codeSeconds)]);
});
async function challenge(request, env, id) {
  id = transactionId(id); let browser;
  try { browser = readCookie(request, LOGIN_COOKIE); } catch { throw invalidVerification(); }
  if (!browser) throw invalidVerification();
  const row = await authDatabase(env).prepare("SELECT * FROM auth_email_challenges WHERE id=? AND browser_hash=? AND state='pending' AND expires_at>? AND attempts<?")
    .bind(id, await browserHash(browser), authNow(), EMAIL_LIMITS.attempts).first();
  if (!row) throw invalidVerification(); return row;
}
export const registrationResend = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env); configuration(env);
  const body = await readAuthJson(request); onlyFields(body, ["challenge_id"]);
  const row = await challenge(request, env, body.challenge_id), eventId = crypto.randomUUID(), code = randomCode();
  await reserveEmail(db, env, { id: eventId, challengeId: row.id, emailHash: row.email_lookup_hash, sourceHash: await sourceHash(env, request), statements: [
    db.prepare("UPDATE auth_email_challenges SET code_hash=?,expires_at=? WHERE id=? AND state='pending'").bind(await codeHash(env, row.id, code), authNow() + EMAIL_LIMITS.codeSeconds, row.id) ] });
  await delivered(db, env, eventId, await decryptEmail(env, row, row.id), code);
  return jsonSuccess({ challenge_id: row.id, expires_in: EMAIL_LIMITS.codeSeconds }, "no-store", 202);
});
export const registrationVerifyEmail = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env); configuration(env);
  const body = await readAuthJson(request); onlyFields(body, ["challenge_id", "code"]);
  const row = await challenge(request, env, body.challenge_id);
  // A rejected/ambiguous latest delivery cannot advance verification. Resend
  // remains available through the existing cooldown and new-code path.
  const latest = await db.prepare("SELECT status FROM auth_email_sends WHERE challenge_id=? ORDER BY rowid DESC LIMIT 1").bind(row.id).first();
  if (latest?.status !== "sent") throw invalidVerification();
  await throttle(request, env, "registration-code", row.id);
  // Increment attempts with CAS before checking even malformed codes.
  const next = await db.prepare("UPDATE auth_email_challenges SET attempts=attempts+1 WHERE id=? AND state='pending' AND attempts=? AND expires_at>? RETURNING *")
    .bind(row.id, row.attempts, authNow()).first();
  if (!next || typeof body.code !== "string" || !/^\d{6}$/.test(body.code) || !equalQueryHash(await codeHash(env, row.id, body.code), row.code_hash)) throw invalidVerification();
  const claimed = await db.prepare("UPDATE auth_email_challenges SET state='verified' WHERE id=? AND state='pending' AND code_hash=? AND expires_at>? AND (SELECT status FROM auth_email_sends WHERE challenge_id=? ORDER BY rowid DESC LIMIT 1)='sent' RETURNING id").bind(row.id, row.code_hash, authNow(), row.id).first();
  if (!claimed) throw invalidVerification();
  const identity = await findIdentity(db, env, await decryptEmail(env, row, row.id));
  const add = Boolean(identity && !identity.password_enabled && identity.google_identity_id && identity.status === "active");
  const tx = await createTransaction(db, "email_register", { challenge_id: row.id, ...(add ? { add_password: true } : {}) }, add ? identity.member_id : null);
  return withCookies(jsonSuccess({ transaction_id: tx.id, expires_in: AUTH_LIMITS.transactionSeconds, status: add ? "ADD_PASSWORD_REQUIRED" : "EMAIL_VERIFIED" }, "no-store", 202), tx.cookies);
});
export const registrationCredentials = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env); supabaseConfig(env);
  const body = await readAuthJson(request); onlyFields(body, ["transaction_id", "password", "nickname", "player_id"]);
  const password = passwordInput(body.password), profile = profileInput({ nickname: body.nickname ?? "會員", ...(body.player_id === undefined ? {} : { player_id: body.player_id }) });
  const tx = await readTransaction(request, env, body, "email_register");
  const row = await db.prepare("SELECT * FROM auth_email_challenges WHERE id=? AND state='verified' AND expires_at>?").bind(tx.data.challenge_id, authNow()).first();
  if (!row) throw invalidVerification();
  const enrollmentId = crypto.randomUUID(), memberId = "M-" + crypto.randomUUID(), now = authNow();
  try { await authAtomic(db, [transactionGuard(tx), { sql: "NOT EXISTS(SELECT 1 FROM auth_identities WHERE email_lookup_hash=?) AND NOT EXISTS(SELECT 1 FROM auth_enrollments WHERE email_lookup_hash=? AND state!='deleted')", args: [row.email_lookup_hash, row.email_lookup_hash] }], [
    db.prepare("INSERT INTO auth_enrollments(id,email_lookup_hash,member_id,verified_transaction_id,state,created_at,expires_at) VALUES(?,?,?,?,'creating',?,?)").bind(enrollmentId, row.email_lookup_hash, memberId, tx.id, now, now + AUTH_LIMITS.transactionSeconds) ]); }
  catch { throw invalidVerification(); }
  let subject;
  try {
    const email = await decryptEmail(env, row, row.id);
    subject = await adminCreateVerifiedUser(env, email, password, enrollmentId);
    // Persist the new subject as soon as it is known for safe reconciliation.
    await db.prepare("UPDATE auth_enrollments SET provider_subject=? WHERE id=? AND state='creating'").bind(subject, enrollmentId).run();
    const setup = newTotp(email), encrypted = await encryptTotp(setup.secret, memberId, env), identity = await encryptEmail(env, email, subject);
    const enrollmentTx = await createTransaction(db, "register", { enrollment_id: enrollmentId, member_id: memberId, login_name: crypto.randomUUID().replaceAll("-", ""),
      provider_subject: subject, email_lookup_hash: row.email_lookup_hash, ...identity, ...profile, ...encrypted });
    await authAtomic(db, [transactionGuard(tx), { sql: "EXISTS(SELECT 1 FROM auth_enrollments WHERE id=? AND state='creating' AND provider_subject=?)", args: [enrollmentId, subject] }], [
      db.prepare("UPDATE auth_enrollments SET state='pending',totp_transaction_id=? WHERE id=?").bind(enrollmentTx.id, enrollmentId),
      db.prepare("UPDATE auth_transactions SET consumed_at=? WHERE id=?").bind(authNow(), tx.id),
      db.prepare("UPDATE auth_email_challenges SET state='transferred' WHERE id=?").bind(row.id) ]);
    return withCookies(jsonSuccess({ status: "MFA_ENROLLMENT_REQUIRED", transaction_id: enrollmentTx.id, expires_in: AUTH_LIMITS.transactionSeconds, otpauth_uri: setup.otpauth_uri }, "no-store", 202), enrollmentTx.cookies);
  } catch (error) {
    if (subject) {
      try { await adminDeleteUser(env, subject); await db.prepare("UPDATE auth_enrollments SET state='deleted' WHERE id=?").bind(enrollmentId).run(); }
      catch { try { await db.prepare("UPDATE auth_enrollments SET state='cleanup_failed',provider_subject=COALESCE(provider_subject,?) WHERE id=?").bind(subject, enrollmentId).run(); } catch { /* Durable creating claim remains; provider metadata identifies it. */ } console.warn("Registration compensation requires reconciliation"); }
    } else {
      // An explicit duplicate/validation rejection cannot have created a user.
      // Timeouts/unknown failures stay 'creating' for operator reconciliation.
      if (error instanceof AuthError && error.code === "AUTH_VERIFICATION_FAILED") await db.prepare("UPDATE auth_enrollments SET state='deleted' WHERE id=?").bind(enrollmentId).run();
    }
    throw error;
  }
});
