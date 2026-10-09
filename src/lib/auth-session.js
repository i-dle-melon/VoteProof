import { AuthError, AUTH_LIMITS, suspended } from "../api/auth-validation.js";
import { newQueryKey, sha256, equalQueryHash } from "./case-keys.js";

export const SESSION_COOKIE = "__Host-vp-session", LOGIN_COOKIE = "__Host-vp-login", DEVICE_COOKIE = "__Host-voteproof_device";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const newAuthToken = newQueryKey;
export const sessionHash = token => sha256("VoteProof/member-session/v1:" + token);
export const browserHash = token => sha256("VoteProof/login-browser/v1:" + token);
export const authRequired = () => new AuthError(401, "AUTH_REQUIRED", "Authentication is required");
export function authDatabase(env) {
  if (typeof env.DB?.prepare !== "function" || typeof env.DB?.batch !== "function") throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Authentication service is not configured");
  return env.DB;
}
export async function authKey(env) {
  if (typeof env.AUTH_SECRET !== "string" || !/^[0-9a-fA-F]{64}$/.test(env.AUTH_SECRET)) throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Authentication service is not configured");
  return crypto.subtle.importKey("raw", Uint8Array.from(env.AUTH_SECRET.match(/../g), v => parseInt(v, 16)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
export async function authMac(key, purpose, value) {
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(["VoteProof/auth/v1", purpose, value])));
  return Array.from(new Uint8Array(signed), v => v.toString(16).padStart(2, "0")).join("");
}
export function configuredAuthOrigin(env) {
  let url;
  try { url = new URL(env.AUTH_ORIGIN); } catch { /* Fail closed below. */ }
  if (!url || url.origin !== env.AUTH_ORIGIN ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Authentication service is not configured");
  }
  return url.origin;
}
export function requestOrigin(request, env) {
  const origin = configuredAuthOrigin(env);
  if (request.headers.get("Origin") !== origin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new AuthError(403, "CSRF_REJECTED", "Request origin is not allowed");
  }
}
export function loginCsrf(request, env) {
  requestOrigin(request, env);
  if (request.headers.get("X-VoteProof-Request") !== "1") throw new AuthError(403, "CSRF_REJECTED", "Request verification is required");
}
export function readCookie(request, name) {
  const values = (request.headers.get("Cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(name + "="));
  if (!values.length) return null;
  if (values.length !== 1 || !TOKEN_PATTERN.test(values[0].slice(name.length + 1))) throw authRequired();
  return values[0].slice(name.length + 1);
}
export function cookie(name, token, maxAge) {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function withCookies(response, cookies) {
  const headers = new Headers(response.headers);
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(response.body, { status: response.status, headers });
}
export async function memberSession(request, env, required = true) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) { if (required) throw authRequired(); return null; }
  const tokenHash = await sessionHash(token);
  const row = await authDatabase(env).prepare(`SELECT m.id, m.member_id, m.nickname, m.player_id, m.status,
    m.created_at, m.updated_at, m.last_login_at, s.expires_at, s.elevated_until, s.reauthenticated_until FROM auth_sessions s
    JOIN members m ON m.member_id = s.member_id WHERE s.token_hash = ? AND s.revoked_at IS NULL
    AND s.expires_at > CAST(strftime('%s', 'now') AS INTEGER) AND NOT EXISTS(SELECT 1 FROM auth_password_operations o WHERE o.member_id=m.member_id AND o.status='pending')`).bind(tokenHash).first();
  if (!row) throw authRequired();
  if (row.status !== "active") throw suspended();
  return { ...row, tokenHash };
}
export async function csrfToken(member, env) { return authMac(await authKey(env), "csrf", member.tokenHash); }
export async function memberCsrf(request, env, member) {
  requestOrigin(request, env);
  const supplied = request.headers.get("X-CSRF-Token");
  const expected = await csrfToken(member, env);
  if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied) || !equalQueryHash(supplied, expected)) throw new AuthError(403, "CSRF_REJECTED", "Request verification is required");
}
export const publicMember = member => ({ member_id: member.member_id, nickname: member.nickname, player_id: member.player_id,
  status: member.status, created_at: member.created_at, updated_at: member.updated_at, last_login_at: member.last_login_at });
export const sessionCookie = (token, seconds = AUTH_LIMITS.sessionSeconds) => cookie(SESSION_COOKIE, token, seconds);
