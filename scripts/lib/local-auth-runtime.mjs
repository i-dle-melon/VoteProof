// Local-only upstream capture. Real Worker routes and D1 enforce every check.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { LOGIN_COOKIE, SESSION_COOKIE } from "../../src/lib/auth-session.js";

export const loginHeaders = () => ({ Origin: "https://voteproof.example", "X-VoteProof-Request": "1",
  "CF-Connecting-IP": "2001:db8:" + randomBytes(2).toString("hex") + "::" + randomBytes(2).toString("hex") });
export function responseCookie(response, name) {
  const values = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const value = values.join(", ").match(new RegExp("(?:^|,\\s*)" + name + "=([^;]*)"))?.[1];
  assert.ok(value); return `${name}=${value}`;
}
export async function begin(local, email = `local-${randomUUID()}@example.test`, headers = loginHeaders()) {
  const response = await local.fetch("/api/auth/start", "POST", { email, turnstile_token: randomBytes(24).toString("hex") }, headers);
  assert.equal(response.status, 202);
  const data = (await response.json()).data;
  const message = local.emails.findLast(m => m.email === email.trim().toLowerCase());
  return { id: data.challenge_id, data, code: message?.code, cookie: responseCookie(response, LOGIN_COOKIE), headers, response, email };
}
export async function finish(local, challenge, extraHeaders = {}) {
  return local.fetch("/api/auth/verify", "POST", { challenge_id: challenge.id, code: challenge.code },
    { ...challenge.headers, Cookie: challenge.cookie, ...extraHeaders });
}
export async function login(local, email) {
  const challenge = await begin(local, email), response = await finish(local, challenge);
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  return { ...data, cookie: responseCookie(response, SESSION_COOKIE), response, email: challenge.email,
    headers: { ...challenge.headers, Cookie: responseCookie(response, SESSION_COOKIE), "X-CSRF-Token": data.csrf_token } };
}
export async function expectError(response, status, code) {
  assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json(); assert.deepEqual(Object.keys(body).sort(), ["error", "ok"]);
  assert.equal(body.error.code, code); return body;
}
