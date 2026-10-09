import { authHandler, authContext, createTransaction, readTransaction, consumeTransaction, issueSession } from "./auth.js";
import { AuthError, readAuthJson, onlyFields, profileInput, invalidVerification, suspended } from "./auth-validation.js";
import { authDatabase, newAuthToken, browserHash, cookie, readCookie, withCookies, configuredAuthOrigin, memberSession, memberCsrf, LOGIN_COOKIE } from "../lib/auth-session.js";
import { authNow, throttle, authAtomic, transactionGuard } from "../lib/auth-store.js";
import { encryptEmail, decryptEmail, emailHash } from "../lib/auth-identity.js";
import { googleAuthorization, exchangeGoogle } from "../lib/supabase-auth.js";
import { sha256, QUERY_KEY_PATTERN } from "../lib/case-keys.js";
import { jsonSuccess } from "./response.js";

export const GOOGLE_COOKIE = "__Host-vp-google";
export const GOOGLE_SECONDS = 300;
const conflict = () => new AuthError(409, "AUTH_IDENTITY_CONFLICT", "Identity cannot be linked; contact support");
export const identityEvent = (db, member, flow, action, subject = null, googleId = null) => db.prepare("INSERT INTO auth_identity_events(id,member_id,flow_id,action,created_at,provider_subject,google_identity_id) VALUES(?,?,?,?,?,?,?)").bind(crypto.randomUUID(), member, flow, action, authNow(), subject, googleId);
export const activeIdentity = (member, subject) => ({ sql: "EXISTS(SELECT 1 FROM auth_identities i JOIN members m USING(member_id) WHERE i.member_id=? AND i.provider_subject=? AND m.status='active')", args: [member, subject] });

export const googleStart = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env), body = await readAuthJson(request);
  onlyFields(body, ["purpose", "confirmed"]);
  const purpose = body.purpose ?? "login";
  if (!["login", "connect", "security"].includes(purpose) || (purpose !== "login" && body.confirmed !== true)) throw invalidVerification();
  const member = await memberSession(request, env, purpose !== "login");
  // Login cannot silently switch a signed-in account; use the bound connect path.
  if (purpose === "login" && member) throw conflict();
  if (member) await memberCsrf(request, env, member);
  await throttle(request, env, "google-start", member?.member_id ?? (request.headers.get("CF-Connecting-IP") ?? "unknown"));
  const id = crypto.randomUUID(), state = newAuthToken(), browser = newAuthToken(), verifier = newAuthToken(), now = authNow();
  const encrypted = await encryptEmail(env, verifier, "oauth-pkce:" + id);
  const redirect = configuredAuthOrigin(env) + "/api/auth/google/callback?state=" + state;
  const authorize = await googleAuthorization(env, redirect, verifier);
  await db.batch([
    db.prepare("DELETE FROM auth_google_flows WHERE id IN(SELECT id FROM auth_google_flows WHERE expires_at<=? LIMIT 100)").bind(now),
    db.prepare(`INSERT INTO auth_google_flows(id,state_hash,browser_hash,purpose,member_id,session_hash,email_ciphertext,email_iv,email_key_version,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, await sha256("VoteProof/oauth-state/v1:" + state), await browserHash(browser), purpose, member?.member_id ?? null, member?.tokenHash ?? null, encrypted.email_ciphertext, encrypted.email_iv, encrypted.email_key_version, now, now + GOOGLE_SECONDS),
  ]);
  return withCookies(jsonSuccess({ authorize_url: authorize, expires_in: GOOGLE_SECONDS }), [cookie(GOOGLE_COOKIE, browser, GOOGLE_SECONDS)]);
});

export async function mapGoogle(db, env, verified) {
  const lookup = await emailHash(env, verified.email);
  const bySubject = await db.prepare("SELECT i.*,m.status FROM auth_identities i JOIN members m USING(member_id) WHERE provider_subject=?").bind(verified.id).first();
  const byEmail = await db.prepare("SELECT provider_subject FROM auth_identities WHERE email_lookup_hash=?").bind(lookup).first();
  const enrollment = await db.prepare("SELECT id FROM auth_enrollments WHERE email_lookup_hash=? AND state NOT IN('deleted','active')").bind(lookup).first();
  if (enrollment || (byEmail && byEmail.provider_subject !== verified.id) ||
      (bySubject && bySubject.email_lookup_hash !== lookup) ||
      (bySubject?.google_identity_id && bySubject.google_identity_id !== verified.identity_id)) throw conflict();
  if (bySubject && bySubject.status !== "active") throw suspended();
  return { existing: bySubject, lookup };
}
export const googleCallback = authHandler(async (env, url, request) => {
  // Browser navigation cannot supply Origin/custom CSRF; state + cookie + PKCE
  // replace that check here. Every later mutation uses normal exact Origin.
  const denied = url.searchParams.has("error");
  if (url.origin !== configuredAuthOrigin(env) || url.searchParams.getAll("state").length !== 1 ||
      !QUERY_KEY_PATTERN.test(url.searchParams.get("state") ?? "") ||
      (denied ? url.searchParams.getAll("error").length !== 1 || url.searchParams.has("code") :
        url.searchParams.getAll("code").length !== 1 || !/^[A-Za-z0-9._~-]{1,2048}$/.test(url.searchParams.get("code") ?? ""))) throw invalidVerification();
  const db = authDatabase(env), browser = readCookie(request, GOOGLE_COOKIE);
  if (!browser) throw invalidVerification();
  const row = await db.prepare(`UPDATE auth_google_flows SET consumed_at=? WHERE state_hash=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>? RETURNING *`)
    .bind(authNow(), await sha256("VoteProof/oauth-state/v1:" + url.searchParams.get("state")), await browserHash(browser), authNow()).first();
  if (!row) throw invalidVerification();
  // A provider denial is still a browser-bound, one-use callback. Consume it
  // without exchanging tokens or creating a login transaction/session. Never
  // reflect provider descriptions (or callback parameters) into the frontend.
  if (denied) {
    const notice = url.searchParams.get("error") === "access_denied" ? "google_cancelled" : "google_failed";
    return withCookies(new Response(null, { status: 303, headers: {
      Location: configuredAuthOrigin(env) + "/?auth_notice=" + notice + "#login",
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    } }), [cookie(GOOGLE_COOKIE, "", 0)]);
  }
  const verified = await exchangeGoogle(env, url.searchParams.get("code"), await decryptEmail(env, row, "oauth-pkce:" + row.id));
  let mapping;
  try {
    mapping = await mapGoogle(db, env, verified);
    if (!row.member_id && await memberSession(request, env, false)) throw conflict();
    if (row.member_id) {
      const member = await memberSession(request, env);
      if (member.member_id !== row.member_id || member.tokenHash !== row.session_hash || mapping.existing?.member_id !== member.member_id) throw conflict();
    }
  } catch (error) {
    await identityEvent(db, row.member_id, row.id, "google_conflict", verified.id, verified.identity_id).run();
    throw error;
  }
  const tx = await createTransaction(db, "google", { flow_id: row.id, purpose: row.purpose, session_hash: row.session_hash,
    provider_subject: verified.id, google_identity_id: verified.identity_id, email_lookup_hash: mapping.lookup,
    ...(await encryptEmail(env, verified.email, "google-proof:" + row.id)),
    provider_linked: Boolean(mapping.existing), google_enabled: Boolean(mapping.existing?.google_identity_id) }, mapping.existing?.member_id ?? null);
  await identityEvent(db, mapping.existing?.member_id ?? null, row.id, "google_verified", verified.id, verified.identity_id).run();
  return withCookies(new Response(null, { status: 303, headers: { Location: configuredAuthOrigin(env) + "/#google", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }), [...tx.cookies, cookie(GOOGLE_COOKIE, "", 0)]);
});

export async function googleProof(request, env, body) {
  const tx = await readTransaction(request, env, body, "google");
  if (tx.created_at + GOOGLE_SECONDS <= authNow()) throw invalidVerification();
  if (tx.data.session_hash) {
    const member = await memberSession(request, env);
    await memberCsrf(request, env, member);
    if (member.member_id !== tx.member_id || member.tokenHash !== tx.data.session_hash) throw invalidVerification();
  }
  return tx;
}
export const googleResult = authHandler(async (env, _url, request) => {
  const browser = readCookie(request, LOGIN_COOKIE);
  if (!browser) throw invalidVerification();
  const tx = await authDatabase(env).prepare("SELECT * FROM auth_transactions WHERE kind='google' AND browser_hash=? AND consumed_at IS NULL AND expires_at>? AND created_at>? ORDER BY created_at DESC,id DESC LIMIT 1")
    .bind(await browserHash(browser), authNow(), authNow() - GOOGLE_SECONDS).first();
  if (!tx) throw invalidVerification();
  const data = JSON.parse(tx.payload);
  if (data.session_hash) { const member = await memberSession(request, env); if (member.tokenHash !== data.session_hash || member.member_id !== tx.member_id) throw invalidVerification(); }
  return jsonSuccess({ transaction_id: tx.id, expires_in: Math.max(0, tx.created_at + GOOGLE_SECONDS - authNow()),
    status: tx.member_id ? (data.google_enabled ? "GOOGLE_LOGIN_READY" : "GOOGLE_CONFIRM_REQUIRED") : "GOOGLE_PROFILE_REQUIRED",
    purpose: data.purpose, email: await decryptEmail(env, data, "google-proof:" + data.flow_id), provider_already_linked: data.provider_linked,
    cancel_unlinks_provider: false });
});

export const googleConfirm = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env), body = await readAuthJson(request);
  onlyFields(body, ["transaction_id", "confirmed", "nickname", "player_id", "remember_me"]);
  if (body.confirmed !== true || (body.remember_me !== undefined && typeof body.remember_me !== "boolean")) throw invalidVerification();
  const tx = await googleProof(request, env, body);
  if (tx.data.purpose === "security") throw invalidVerification();
  if (!tx.data.session_hash && await memberSession(request, env, false)) throw conflict();
  const email = await decryptEmail(env, tx.data, "google-proof:" + tx.data.flow_id);
  const mapping = await mapGoogle(db, env, { id: tx.data.provider_subject, identity_id: tx.data.google_identity_id, email });
  const existing = mapping.existing;
  if (tx.member_id && existing?.member_id !== tx.member_id) throw conflict();
  const member = existing?.member_id ?? "M-" + crypto.randomUUID(), statements = [], guards = [];
  if (existing) {
    guards.push(activeIdentity(member, tx.data.provider_subject));
    if (tx.data.session_hash) guards.push({ sql: "EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=? AND member_id=? AND revoked_at IS NULL AND expires_at>?)", args: [tx.data.session_hash, member, authNow()] });
    statements.push(db.prepare("UPDATE auth_identities SET google_identity_id=? WHERE provider_subject=?").bind(tx.data.google_identity_id, tx.data.provider_subject));
  } else {
    const profile = profileInput({ nickname: body.nickname, ...(body.player_id === undefined ? {} : { player_id: body.player_id }) }), now = new Date().toISOString();
    guards.push({ sql: "NOT EXISTS(SELECT 1 FROM auth_identities WHERE provider_subject=? OR email_lookup_hash=?) AND NOT EXISTS(SELECT 1 FROM auth_enrollments WHERE email_lookup_hash=? AND state NOT IN('deleted','active'))", args: [tx.data.provider_subject, mapping.lookup, mapping.lookup] });
    const protectedEmail = await encryptEmail(env, email, tx.data.provider_subject);
    statements.push(db.prepare("INSERT INTO members(id,member_id,login_name,nickname,player_id,created_at,updated_at,last_login_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), member, crypto.randomUUID().replaceAll("-", ""), profile.nickname, profile.player_id ?? null, now, now, now));
    statements.push(db.prepare("INSERT INTO auth_identities(provider,provider_subject,member_id,email_lookup_hash,email_ciphertext,email_iv,email_key_version,created_at,password_enabled,google_identity_id) VALUES('supabase',?,?,?,?,?,?,?,0,?)")
      .bind(tx.data.provider_subject, member, mapping.lookup, protectedEmail.email_ciphertext, protectedEmail.email_iv, protectedEmail.email_key_version, authNow(), tx.data.google_identity_id));
  }
  statements.push(identityEvent(db, member, tx.data.flow_id, "google_enabled", tx.data.provider_subject, tx.data.google_identity_id));
  try { return await issueSession(request, env, member, { guards, statements, tx, remember: body.remember_me === true, method: "google" }); }
  catch (e) { if (e instanceof AuthError || /constraint/i.test(String(e.message))) throw conflict(); throw e; }
});
export const googleCancel = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env), body = await readAuthJson(request); onlyFields(body, ["transaction_id"]);
  const tx = await googleProof(request, env, body);
  await authAtomic(db, [transactionGuard(tx)], [consumeTransaction(db, tx), identityEvent(db, tx.member_id, tx.data.flow_id, "google_cancelled", tx.data.provider_subject, tx.data.google_identity_id)]);
  return withCookies(jsonSuccess({ cancelled: true, provider_unlinked: false, message: "VoteProof activation cancelled; Supabase may retain the Google identity" }), [cookie(LOGIN_COOKIE, "", 0)]);
});

export const loginSecurity = authHandler(async (env, _url, request) => {
  const member = await memberSession(request, env), db = authDatabase(env);
  const identity = await db.prepare("SELECT * FROM auth_identities WHERE member_id=?").bind(member.member_id).first();
  const credentials = await db.prepare("SELECT member_id FROM member_credentials WHERE member_id=?").bind(member.member_id).first();
  if (!identity) throw invalidVerification();
  return jsonSuccess({ google: { connected: Boolean(identity.google_identity_id), ...(identity.google_identity_id ? { email: await decryptEmail(env, identity, identity.provider_subject) } : {}) },
    password: { configured: Boolean(identity.password_enabled) }, authenticator: { configured: Boolean(credentials), required_for_password: true, required_for_admin: true },
    current_method: member.auth_method, unlink_supported: false, google_assisted_password_reset_supported: false });
});
