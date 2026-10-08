import { jsonSuccess, jsonError } from "./response.js";
import { AuthError, AUTH_LIMITS, readAuthJson, onlyFields, normalizeEmail, invalidAuth, invalidVerification, suspended } from "./auth-validation.js";
import { UploadError, UPLOAD_LIMITS } from "./upload-validation.js";
import { verifyTurnstile } from "./turnstile.js";
import { equalQueryHash } from "../lib/case-keys.js";
import { authDatabase, authKey, authMac, newAuthToken, browserHash, sessionHash, SESSION_COOKIE, LOGIN_COOKIE,
  loginCsrf, readCookie, cookie, withCookies, sessionCookie, memberSession, publicMember, csrfToken } from "../lib/auth-session.js";
import { rateLimit, rateError, establishSession } from "../lib/auth-store.js";
import { emailConfig, sendLoginCode } from "../lib/auth-email.js";

export const authHandler = action => async (env, url, request) => {
  try { return await action(env, url, request); }
  catch (e) {
    if (e instanceof AuthError || e instanceof UploadError) return jsonError(e.status, e.code, e.message,
      e.status === 429 ? { "retry-after": String(e.retryAfter ?? AUTH_LIMITS.windowSeconds) } : {});
    return jsonError(503, "AUTH_SERVICE_UNAVAILABLE", "Authentication service is unavailable");
  }
};
function otpCode() {
  const range = 100000000, ceiling = Math.floor(4294967296 / range) * range;
  let value;
  do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= ceiling);
  return String(value % range).padStart(8, "0");
}
const accepted = id => jsonSuccess({ challenge_id: id, expires_in: AUTH_LIMITS.otpSeconds,
  message: "If this address can receive email, a verification code will arrive shortly" }, "no-store", 202);

export const startLogin = authHandler(async (env, _url, request) => {
  loginCsrf(request, env);
  const body = await readAuthJson(request);
  onlyFields(body, ["email", "turnstile_token"]);
  const email = normalizeEmail(body.email);
  if (typeof body.turnstile_token !== "string" || !body.turnstile_token.trim()) throw new UploadError(400, "TURNSTILE_REQUIRED", "Turnstile verification is required");
  if (body.turnstile_token.length > UPLOAD_LIMITS.maxTokenLength) invalidAuth();
  const db = authDatabase(env), key = await authKey(env);
  emailConfig(env);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!await rateLimit(db, key, "start-ip", ip, AUTH_LIMITS.ipStarts)) throw rateError();
  if (!await rateLimit(db, key, "start-global", "all", AUTH_LIMITS.globalStarts, 3600)) throw rateError(3600);
  await verifyTurnstile(request, env, body.turnstile_token.trim());
  const id = crypto.randomUUID(), browser = newAuthToken();
  const cookies = [cookie(LOGIN_COOKIE, browser, AUTH_LIMITS.otpSeconds)];
  // Account existence and suspension never affect the start response. Suppress
  // excess email sends using an identical response and a non-verifiable handle.
  if (!await rateLimit(db, key, "start-email", email, AUTH_LIMITS.emailStarts)) return withCookies(accepted(id), cookies);
  const code = otpCode(), now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT INTO auth_challenges (id, email, browser_hash, otp_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(id, email, await browserHash(browser), await authMac(key, "otp", [id, code]), now, now + AUTH_LIMITS.otpSeconds).run();
  await sendLoginCode(env, email, code, id);
  const marked = await db.prepare("UPDATE auth_challenges SET delivered = 1 WHERE id = ? AND consumed_at IS NULL").bind(id).run();
  if (marked.meta.changes !== 1) throw new Error();
  return withCookies(accepted(id), cookies);
});

export const verifyLogin = authHandler(async (env, _url, request) => {
  loginCsrf(request, env);
  const body = await readAuthJson(request);
  onlyFields(body, ["challenge_id", "code"]);
  if (typeof body.challenge_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.challenge_id) ||
      typeof body.code !== "string" || !/^\d{8}$/.test(body.code)) throw invalidVerification();
  const db = authDatabase(env), key = await authKey(env);
  if (!await rateLimit(db, key, "verify-ip", request.headers.get("CF-Connecting-IP") ?? "unknown", AUTH_LIMITS.ipVerifies)) throw rateError();
  let browser;
  try { browser = readCookie(request, LOGIN_COOKIE); } catch { throw invalidVerification(); }
  if (!browser) throw invalidVerification();
  const challenge = await db.prepare(`UPDATE auth_challenges SET attempts = attempts + 1
    WHERE id = ? AND browser_hash = ? AND delivered = 1 AND consumed_at IS NULL
    AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) AND attempts < ? RETURNING *`)
    .bind(body.challenge_id, await browserHash(browser), AUTH_LIMITS.otpAttempts).first();
  const candidate = await authMac(key, "otp", [body.challenge_id, body.code]);
  if (!equalQueryHash(candidate, challenge?.otp_hash ?? "0".repeat(64)) || !challenge) throw invalidVerification();
  const existing = await db.prepare("SELECT status FROM members WHERE email = ?").bind(challenge.email).first();
  if (existing?.status === "suspended") throw suspended();
  const token = newAuthToken(), tokenHash = await sessionHash(token);
  let previous;
  try { previous = readCookie(request, SESSION_COOKIE); } catch { /* Replace invalid cookies on successful verification. */ }
  if (!await establishSession(db, challenge, tokenHash, previous ? await sessionHash(previous) : null)) {
    if ((await db.prepare("SELECT status FROM members WHERE email = ?").bind(challenge.email).first())?.status === "suspended") throw suspended();
    throw invalidVerification();
  }
  const member = await memberSession(new Request(request.url, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }), env);
  return withCookies(jsonSuccess({ member: publicMember(member), csrf_token: await csrfToken(member, env), expires_in: AUTH_LIMITS.sessionSeconds }),
    [sessionCookie(token), cookie(LOGIN_COOKIE, "", 0)]);
});

export const currentMember = authHandler(async (env, _url, request) => {
  const member = await memberSession(request, env);
  return jsonSuccess({ member: publicMember(member), csrf_token: await csrfToken(member, env), expires_at: member.expires_at });
});

export const logout = authHandler(async (env, _url, request) => {
  // Exact Origin + a non-simple custom header protect logout from browser CSRF.
  // No active-member/CSRF-token fetch is needed to discard suspended, expired
  // or damaged cookies, so the visitor can always return to the Guest flow.
  loginCsrf(request, env);
  let token;
  try { token = readCookie(request, SESSION_COOKIE); } catch { /* Clear damaged/duplicate cookies below. */ }
  if (token) {
    const tokenHash = await sessionHash(token);
    await authDatabase(env).prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(Math.floor(Date.now() / 1000), tokenHash).run();
  }
  return withCookies(jsonSuccess({ logged_out: true }), [cookie(SESSION_COOKIE, "", 0), cookie(LOGIN_COOKIE, "", 0)]);
});
