import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { localCaseRuntime } from "../scripts/lib/local-case-runtime.mjs";
import { begin, finish, login, loginHeaders, responseCookie, expectError } from "../scripts/lib/local-auth-runtime.mjs";
import { SESSION_COOKIE, LOGIN_COOKIE, sessionHash } from "../src/lib/auth-session.js";
import { AUTH_LIMITS } from "../src/api/auth-validation.js";

let local;
before(async () => { local = await localCaseRuntime(); });
after(async () => { await local?.runtime.dispose(); });

test("B4 local schema has identity/session/challenge/rate tables and owner cursor index", async () => {
  const names = (await local.db.prepare("SELECT name FROM sqlite_master").all()).results.map(r => r.name);
  for (const name of ["members", "auth_sessions", "auth_challenges", "auth_rate_limits", "idx_cases_member_cursor", "idx_auth_sessions_member"]) assert.ok(names.includes(name));
});
test("email OTP login normalizes identity, creates private member and returns no bearer token in JSON", async () => {
  const email = `LOGIN-${randomUUID()}@EXAMPLE.TEST`, member = await login(local, "  " + email + "  ");
  assert.match(member.member.member_id, /^M-[0-9a-f-]{36}$/);
  assert.equal(member.member.nickname, "會員"); assert.equal(member.member.player_id, null);
  assert.equal(member.member.status, "active"); assert.equal(member.expires_in, AUTH_LIMITS.sessionSeconds);
  const row = await local.db.prepare("SELECT * FROM members WHERE member_id = ?").bind(member.member.member_id).first();
  assert.equal(row.email, email.toLowerCase());
  for (const name of ["email", "id", "session_token", "token_hash"]) assert.equal(Object.hasOwn(member.member, name), false);
});
test("all issued cookies have host-only Secure/HttpOnly/SameSite/path and bounded lifetimes", async () => {
  const challenge = await begin(local), response = await finish(local, challenge);
  for (const value of [...challenge.response.headers.getSetCookie(), ...response.headers.getSetCookie()]) {
    assert.match(value, /HttpOnly/); assert.match(value, /Secure/); assert.match(value, /SameSite=Lax/); assert.match(value, /Path=\//);
    assert.equal(/Domain=/i.test(value), false); assert.match(value, /Max-Age=(?:0|600|604800)(?:;|$)/);
  }
});
test("current member verifies session in D1 and returns csrf token without email", async () => {
  const member = await login(local), response = await local.fetch("/api/auth/me", "GET", undefined, { Cookie: member.cookie });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const data = (await response.json()).data; assert.equal(data.member.member_id, member.member.member_id);
  assert.equal(data.csrf_token, member.csrf_token); assert.equal(JSON.stringify(data).includes(member.email), false);
});
test("D1 stores session SHA-256 and keyed OTP hash, never either plaintext credential", async () => {
  const challenge = await begin(local), response = await finish(local, challenge);
  const token = responseCookie(response, SESSION_COOKIE).split("=")[1];
  const rows = await local.db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?").bind(await sessionHash(token)).first();
  assert.ok(rows); assert.equal(JSON.stringify(rows).includes(token), false);
  const stored = await local.db.prepare("SELECT * FROM auth_challenges WHERE id = ?").bind(challenge.id).first();
  assert.match(stored.otp_hash, /^[a-f0-9]{64}$/); assert.equal(stored.otp_hash.includes(challenge.code), false);
  assert.equal(JSON.stringify(stored).includes(challenge.cookie.split("=")[1]), false);
});
test("wrong OTP has uniform failure and five persistent attempts lock even correct code", async () => {
  const challenge = await begin(local), wrong = challenge.code === "00000000" ? "11111111" : "00000000";
  for (let i = 0; i < 5; i++) await expectError(await finish(local, { ...challenge, code: wrong }), 400, "AUTH_VERIFICATION_FAILED");
  await expectError(await finish(local, challenge), 400, "AUTH_VERIFICATION_FAILED");
  assert.equal((await local.db.prepare("SELECT attempts FROM auth_challenges WHERE id = ?").bind(challenge.id).first()).attempts, 5);
});
test("fifth correct OTP attempt still succeeds", async () => {
  const challenge = await begin(local), wrong = challenge.code === "00000000" ? "11111111" : "00000000";
  for (let i = 0; i < 4; i++) await expectError(await finish(local, { ...challenge, code: wrong }), 400, "AUTH_VERIFICATION_FAILED");
  assert.equal((await finish(local, challenge)).status, 200);
});
test("expired OTP rejects even the original browser and correct code", async () => {
  const challenge = await begin(local), now = Math.floor(Date.now() / 1000);
  await local.db.prepare("UPDATE auth_challenges SET created_at = ?, expires_at = ? WHERE id = ?").bind(now - 1000, now - 1, challenge.id).run();
  await expectError(await finish(local, challenge), 400, "AUTH_VERIFICATION_FAILED");
});
test("OTP is one-use and concurrent verification issues exactly one session", async () => {
  const challenge = await begin(local), responses = await Promise.all(Array.from({ length: 3 }, () => finish(local, challenge)));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400, 400]);
  const email = challenge.email.toLowerCase();
  const rows = (await local.db.prepare("SELECT s.token_hash FROM auth_sessions s JOIN members m ON s.member_id=m.member_id WHERE m.email=?").bind(email).all()).results;
  assert.equal(rows.length, 1); await expectError(await finish(local, challenge), 400, "AUTH_VERIFICATION_FAILED");
});
test("OTP browser binding rejects another browser, absent cookie and forged cookie", async () => {
  const challenge = await begin(local), other = await begin(local);
  for (const value of ["", other.cookie, LOGIN_COOKIE + "=" + randomBytes(32).toString("base64url")])
    await expectError(await finish(local, challenge, { Cookie: value }), 400, "AUTH_VERIFICATION_FAILED");
  assert.equal((await finish(local, challenge)).status, 200);
});
test("re-login rotates session and revokes prior session rather than fixing it", async () => {
  const member = await login(local), challenge = await begin(local, member.email);
  const response = await finish(local, challenge, { Cookie: challenge.cookie + "; " + member.cookie });
  assert.equal(response.status, 200); assert.notEqual(responseCookie(response, SESSION_COOKIE), member.cookie);
  await expectError(await local.fetch("/api/auth/me", "GET", undefined, { Cookie: member.cookie }), 401, "AUTH_REQUIRED");
  assert.equal((await local.fetch("/api/auth/me", "GET", undefined, { Cookie: responseCookie(response, SESSION_COOKIE) })).status, 200);
});
test("logout revokes persisted session and expires both cookies", async () => {
  const member = await login(local), response = await local.fetch("/api/auth/logout", "POST", undefined, member.headers);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  for (const value of response.headers.getSetCookie()) assert.match(value, /Max-Age=0/);
  await expectError(await local.fetch("/api/auth/me", "GET", undefined, { Cookie: member.cookie }), 401, "AUTH_REQUIRED");
});
test("invalid, missing, duplicate and expired sessions never authorize a member", async () => {
  for (const cookie of ["", `${SESSION_COOKIE}=invalid`, `${SESSION_COOKIE}=${randomBytes(32).toString("base64url")}`, `${SESSION_COOKIE}=invalid; ${SESSION_COOKIE}=invalid`])
    await expectError(await local.fetch("/api/auth/me", "GET", undefined, { Cookie: cookie }), 401, "AUTH_REQUIRED");
  const member = await login(local), now = Math.floor(Date.now() / 1000), hash = await sessionHash(member.cookie.split("=")[1]);
  await local.db.prepare("UPDATE auth_sessions SET created_at=?, expires_at=? WHERE token_hash=?").bind(now - 1000, now - 1, hash).run();
  await expectError(await local.fetch("/api/auth/me", "GET", undefined, { Cookie: member.cookie }), 401, "AUTH_REQUIRED");
});
test("suspended members cannot read current identity or complete a new login", async () => {
  const member = await login(local);
  await local.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(member.member.member_id).run();
  await expectError(await local.fetch("/api/auth/me", "GET", undefined, member.headers), 403, "MEMBER_SUSPENDED");
  const challenge = await begin(local, member.email); await expectError(await finish(local, challenge), 403, "MEMBER_SUSPENDED");
  assert.equal((await local.fetch("/api/auth/logout", "POST", undefined, member.headers)).status, 200);
});
test("start response never enumerates existing, new or suspended email identities", async () => {
  const member = await login(local);
  await local.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(member.member.member_id).run();
  const known = await begin(local, member.email), absent = await begin(local);
  const a = known.data, b = absent.data;
  assert.deepEqual(Object.keys(a), Object.keys(b)); assert.equal(a.message, b.message); assert.equal(a.expires_in, b.expires_in);
  assert.equal(JSON.stringify(a).includes(member.email), false);
});
test("email send quota uses indistinguishable 202 response and stops after three sends", async () => {
  const email = `quota-${randomUUID()}@example.test`;
  for (let i = 0; i < 5; i++) assert.equal((await begin(local, email)).response.status, 202);
  assert.equal(local.emails.filter(e => e.email === email).length, 3);
});
test("IP start rate limit is persistent and atomic across concurrent requests", async () => {
  const headers = loginHeaders(), email = `ip-${randomUUID()}@example.test`;
  const responses = await Promise.all(Array.from({ length: 22 }, () => local.fetch("/api/auth/start", "POST", { email, turnstile_token: "local-test-token" }, headers)));
  assert.equal(responses.filter(r => r.status === 202).length, 20);
  for (const r of responses.filter(r => r.status !== 202)) await expectError(r, 429, "AUTH_RATE_LIMITED");
});
test("verification IP rate cap rejects even nonexistent challenge attempts", async () => {
  const challenge = await begin(local), body = { challenge_id: randomUUID(), code: "00000000" };
  for (let i = 0; i < 60; i++) await expectError(await local.fetch("/api/auth/verify", "POST", body, { ...challenge.headers, Cookie: challenge.cookie }), 400, "AUTH_VERIFICATION_FAILED");
  await expectError(await finish(local, challenge), 429, "AUTH_RATE_LIMITED");
});
for (const [name, headers] of [["missing Origin", { Origin: undefined }], ["other Origin", { Origin: "https://attacker.example" }],
  ["missing custom header", { "X-VoteProof-Request": undefined }], ["cross-site fetch", { "Sec-Fetch-Site": "cross-site" }]]) {
  test("login CSRF rejects " + name, async () => {
    const h = { ...loginHeaders(), ...headers }; for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    for (const path of ["start", "verify", "logout"]) await expectError(await local.fetch("/api/auth/" + path, "POST", {}, h), 403, "CSRF_REJECTED");
  });
}
test("same-origin custom-header logout works without cached CSRF after suspension", async () => {
  const member = await login(local), h = { ...member.headers }; delete h["X-CSRF-Token"];
  await local.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(member.member.member_id).run();
  assert.equal((await local.fetch("/api/auth/logout", "POST", undefined, h)).status, 200);
  await expectError(await local.fetch("/api/auth/me", "GET", undefined, h), 401, "AUTH_REQUIRED");
});
test("logout clears invalid/duplicate cookies while still rejecting cross-origin requests", async () => {
  const headers = { ...loginHeaders(), Cookie: `${SESSION_COOKIE}=invalid; ${SESSION_COOKIE}=duplicate` };
  const response = await local.fetch("/api/auth/logout", "POST", undefined, headers);
  assert.equal(response.status, 200);
  for (const value of response.headers.getSetCookie()) assert.match(value, /Max-Age=0/);
  await expectError(await local.fetch("/api/auth/logout", "POST", undefined, { ...headers, Origin: "https://attacker.example" }), 403, "CSRF_REJECTED");
});
for (const email of ["", "a", "a@localhost", "a\r\n@example.test", ".a@example.test", "a..b@example.test", "a".repeat(65) + "@example.test", "a@" + "b".repeat(250) + ".test"]) {
  test("invalid email format is bounded and rejected: " + JSON.stringify(email.slice(0, 25)), async () => {
    await expectError(await local.fetch("/api/auth/start", "POST", { email, turnstile_token: "local-test-token" }, loginHeaders()), 400, "INVALID_AUTH_REQUEST");
  });
}
test("auth rejects invalid/oversize JSON, unknown fields and missing Turnstile", async () => {
  const h = loginHeaders();
  await expectError(await local.fetch("/api/auth/start", "POST", "{", h), 400, "INVALID_JSON");
  await expectError(await local.fetch("/api/auth/start", "POST", " ".repeat(16385), h), 413, "INVALID_AUTH_REQUEST");
  await expectError(await local.fetch("/api/auth/start", "POST", { email: "a@example.test", password: "unused" }, h), 400, "INVALID_AUTH_REQUEST");
  await expectError(await local.fetch("/api/auth/start", "POST", { email: "a@example.test" }, h), 400, "TURNSTILE_REQUIRED");
});
test("email delivery failure is sanitized, undelivered challenges cannot authenticate", async () => {
  const failed = await localCaseRuntime({ emailService: () => new Response("private upstream error", { status: 500 }) });
  try {
    const h = loginHeaders(), response = await failed.fetch("/api/auth/start", "POST", { email: "failure@example.test", turnstile_token: "local-test-token" }, h);
    const body = await expectError(response, 502, "AUTH_EMAIL_UNAVAILABLE"); assert.equal(JSON.stringify(body).includes("private upstream"), false);
    assert.equal((await failed.db.prepare("SELECT delivered FROM auth_challenges").first()).delivered, 0);
  } finally { await failed.runtime.dispose(); }
});
test("identity UNIQUE and suspended status constraints are enforced by local D1", async () => {
  const member = await login(local);
  await assert.rejects(() => local.db.prepare("UPDATE members SET status='admin' WHERE member_id=?").bind(member.member.member_id).run());
  const other = await login(local);
  await assert.rejects(() => local.db.prepare("UPDATE members SET email=? WHERE member_id=?").bind(member.email.toLowerCase(), other.member.member_id).run());
});
test("auth methods and unknown API preserve 405/404 and no-store", async () => {
  for (const path of ["start", "verify", "logout"]) await expectError(await local.fetch("/api/auth/" + path), 405, "METHOD_NOT_ALLOWED");
  await expectError(await local.fetch("/api/auth/me", "POST", {}), 405, "METHOD_NOT_ALLOWED");
  await expectError(await local.fetch("/api/auth/password"), 404, "NOT_FOUND");
});

test("missing dedicated AUTH_SECRET/sender/origin fails closed without changing Guest APIs", async () => {
  const isolated = await localCaseRuntime();
  try {
    for (const settings of [{ AUTH_SECRET: undefined }, { AUTH_SECRET: "invalid" },
      { AUTH_SECRET: randomBytes(32).toString("hex"), AUTH_EMAIL_API_KEY: undefined },
      { AUTH_EMAIL_API_KEY: randomBytes(32).toString("hex"), AUTH_EMAIL_FROM: "invalid" },
      { AUTH_EMAIL_FROM: "login@example.test", AUTH_ORIGIN: "https://voteproof.example/path" }]) {
      await isolated.setAuthConfig(settings);
      const response = await isolated.fetch("/api/auth/start", "POST", { email: "config@example.test", turnstile_token: "local-test-token" }, loginHeaders());
      assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
      const value = JSON.stringify(await response.json()); assert.equal(value.includes("AUTH_SECRET"), false);
      assert.equal((await isolated.fetch("/api/health")).status, 200);
    }
    assert.equal(isolated.emails.length, 0);
  } finally { await isolated.runtime.dispose(); }
});
test("global email quota bounds distributed starts and provides a conservative Retry-After", async () => {
  const isolated = await localCaseRuntime();
  try {
    await begin(isolated);
    await isolated.db.prepare("UPDATE auth_rate_limits SET count=? WHERE expires_at-window_start=3600").bind(AUTH_LIMITS.globalStarts).run();
    const response = await isolated.fetch("/api/auth/start", "POST", { email: "global@example.test", turnstile_token: "local-test-token" }, loginHeaders());
    assert.equal(response.headers.get("retry-after"), "3600"); await expectError(response, 429, "AUTH_RATE_LIMITED");
    assert.equal(isolated.emails.length, 1);
  } finally { await isolated.runtime.dispose(); }
});
test("D1 session insertion failure rolls back member creation/OTP consumption and allows retry", async () => {
  const challenge = await begin(local);
  await local.db.prepare("CREATE TRIGGER local_abort_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT,'local session failure'); END").run();
  try { await expectError(await finish(local, challenge), 503, "AUTH_SERVICE_UNAVAILABLE"); }
  finally { await local.db.prepare("DROP TRIGGER local_abort_session").run(); }
  assert.equal(await local.db.prepare("SELECT member_id FROM members WHERE email=?").bind(challenge.email).first(), null);
  assert.equal((await local.db.prepare("SELECT consumed_at FROM auth_challenges WHERE id=?").bind(challenge.id).first()).consumed_at, null);
  assert.equal((await finish(local, challenge)).status, 200);
});
test("email API invalid JSON/schema errors never return upstream body or credentials", async () => {
  for (const reply of [() => new Response("private upstream text"), () => Response.json({ unexpected: "private upstream text" })]) {
    const isolated = await localCaseRuntime({ emailService: reply });
    try {
      const response = await isolated.fetch("/api/auth/start", "POST", { email: "format@example.test", turnstile_token: "local-test-token" }, loginHeaders());
      const body = await expectError(response, 502, "AUTH_EMAIL_UNAVAILABLE");
      assert.equal(JSON.stringify(body).includes("private upstream text"), false);
    } finally { await isolated.runtime.dispose(); }
  }
});
test("login requires successful server-side Turnstile before issuing or sending OTP", async () => {
  const isolated = await localCaseRuntime({ turnstileService: () => Response.json({ success: false }) });
  try {
    await expectError(await isolated.fetch("/api/auth/start", "POST", { email: "verify@example.test", turnstile_token: "invalid-test-token" }, loginHeaders()), 403, "TURNSTILE_INVALID");
    assert.equal(isolated.emails.length, 0);
    assert.equal((await isolated.db.prepare("SELECT count(*) AS n FROM auth_challenges").first()).n, 0);
  } finally { await isolated.runtime.dispose(); }
});
