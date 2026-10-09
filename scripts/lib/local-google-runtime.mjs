// Isolated mock provider only. Never reads live config or talks to Google.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loginHeaders, responseCookie } from "./local-auth-runtime.mjs";
import { GOOGLE_COOKIE } from "../../src/api/auth-google.js";
import { LOGIN_COOKIE, SESSION_COOKIE } from "../../src/lib/auth-session.js";
export async function googleProof(local, email = randomUUID() + "@local.example", member, purpose = member ? "connect" : "login", options = {}) {
  const headers = member?.headers ?? loginHeaders();
  const start = await local.fetch("/api/auth/google/start", "POST", { purpose, ...(member ? { confirmed: true } : {}) }, headers);
  assert.equal(start.status, 200); const data = (await start.json()).data;
  const oauth = local.provider.oauth(data.authorize_url, email, options);
  const browser = responseCookie(start, GOOGLE_COOKIE);
  const callback = await local.fetch(oauth.path, "GET", undefined, { Cookie: browser + (member ? "; " + member.cookie : "") });
  if (callback.status !== 303) return { start, callback, oauth, data, browser };
  const txCookie = responseCookie(callback, LOGIN_COOKIE), proofHeaders = { ...headers, Cookie: txCookie + (member ? "; " + member.cookie : "") };
  const result = await local.fetch("/api/auth/google/result", "GET", undefined, proofHeaders);
  assert.equal(result.status, 200);
  return { start, callback, oauth, data, browser, headers: proofHeaders, result: (await result.json()).data };
}
export async function googleMember(local, email) {
  const proof = await googleProof(local, email); assert.equal(proof.callback.status, 303);
  const response = await local.fetch("/api/auth/google/confirm", "POST", { transaction_id: proof.result.transaction_id, confirmed: true, nickname: "Google會員", player_id: "local-player" }, proof.headers);
  assert.equal(response.status, 200); const data = (await response.json()).data, cookie = responseCookie(response, SESSION_COOKIE);
  return { ...data, email: proof.oauth.user.email, cookie, response, provider: proof.oauth.user, headers: { ...loginHeaders(), Cookie: cookie, "X-CSRF-Token": data.csrf_token } };
}
