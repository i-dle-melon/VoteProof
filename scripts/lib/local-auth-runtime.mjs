// Real auth routes in disposable workerd/D1; no production bypass.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { URI } from "otpauth";
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  DEVICE_COOKIE,
} from "../../src/lib/auth-session.js";
export const loginHeaders = () => ({
  Origin: "https://voteproof.example",
  "X-VoteProof-Request": "1",
  "CF-Connecting-IP":
    "2001:db8:" +
    randomBytes(2).toString("hex") +
    "::" +
    randomBytes(2).toString("hex"),
});
export function responseCookie(response, name) {
  const values = response.headers.getSetCookie?.() ?? [
    response.headers.get("set-cookie") ?? "",
  ];
  const value = values
    .join(", ")
    .match(new RegExp("(?:^|,\\s*)" + name + "=([^;]*)"))?.[1];
  assert.ok(value);
  return `${name}=${value}`;
}
export async function begin(
  local,
  name = randomUUID().replaceAll("-", ""),
  headers = loginHeaders(),
  extra = {},
) {
  const password = extra.password ?? randomBytes(24).toString("base64url"), email = name.includes("@") ? name : name + "@local.example";
  const started = await local.fetch("/api/auth/register/start","POST",{email,turnstile_token:randomBytes(24).toString("hex")},headers);
  assert.equal(started.status,202);const challenge=(await started.json()).data;
  const verified=await local.fetch("/api/auth/register/verify-email","POST",{challenge_id:challenge.challenge_id,code:local.provider.codeFor(email)}, {...headers,Cookie:responseCookie(started,LOGIN_COOKIE)});
  assert.equal(verified.status,202);const registration=(await verified.json()).data;
  const response=await local.fetch("/api/auth/register/credentials","POST",{transaction_id:registration.transaction_id,password,nickname:"本機會員",player_id:"local-player",...extra}, {...headers,Cookie:responseCookie(verified,LOGIN_COOKIE)});
  assert.equal(response.status,202);const data=(await response.json()).data,otp=URI.parse(data.otpauth_uri);
  return {id:data.transaction_id,data,code:otp.generate(),otp,password,email:email.trim().toLowerCase(),email_hash:await local.emailHash(email),cookie:responseCookie(response,LOGIN_COOKIE),headers,response};
}

export async function finish(local, setup, extra = {}, extraHeaders = {}) {
  return local.fetch(
    "/api/auth/register/verify-totp",
    "POST",
    { transaction_id: setup.id, code: setup.code, ...extra },
    { ...setup.headers, Cookie: setup.cookie, ...extraHeaders },
  );
}
export async function login(local, existing) {
  if (existing) {
    const response = await local.fetch(
      "/api/auth/login",
      "POST",
      { email: existing.email, password: existing.password },
      {
        ...loginHeaders(),
        Cookie: existing.deviceCookie + "; " + existing.cookie,
      },
    );
    assert.equal(response.status, 200);
    const data = (await response.json()).data,
      cookie = responseCookie(response, SESSION_COOKIE);
    return {
      ...existing,
      ...data,
      cookie,
      response,
      headers: {
        ...loginHeaders(),
        Cookie: cookie,
        "X-CSRF-Token": data.csrf_token,
      },
    };
  }
  const setup = await begin(local),
    response = await finish(local, setup, { trust_this_device: true });
  assert.equal(response.status, 200);
  const data = (await response.json()).data,
    cookie = responseCookie(response, SESSION_COOKIE),
    deviceCookie = responseCookie(response, DEVICE_COOKIE);
  return {
    ...setup,
    ...data,
    cookie,
    deviceCookie,
    response,
    headers: {
      ...setup.headers,
      Cookie: cookie,
      "X-CSRF-Token": data.csrf_token,
    },
  };
}
export async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["error", "ok"]);
  assert.equal(body.error.code, code);
  return body;
}
