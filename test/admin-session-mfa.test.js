import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { URI } from "otpauth";
import { localCaseRuntime } from "../scripts/lib/local-case-runtime.mjs";
import { googleMember, googleProof } from "../scripts/lib/local-google-runtime.mjs";
import { login, loginHeaders, responseCookie, expectError } from "../scripts/lib/local-auth-runtime.mjs";
import { LOGIN_COOKIE, SESSION_COOKIE } from "../src/lib/auth-session.js";
import { AUTH_LIMITS } from "../src/api/auth-validation.js";

// All identities, timestamp simulations and writes are disposable local fixtures.
let local;
before(async () => { local = await localCaseRuntime(); });
after(async () => { await local.runtime.dispose(); });
const post = (path, body, headers) => local.fetch("/api/auth/" + path, "POST", body, headers);
async function data(response) { assert.equal(response.status, 200); return (await response.json()).data; }
async function role(m, value, status = "active") {
  const now = new Date().toISOString();
  await local.db.prepare("INSERT INTO admin_memberships(id,member_id,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind(randomUUID(), m.member.member_id, value, status, now, now).run();
}
const session = m => local.db.prepare("SELECT * FROM auth_sessions WHERE member_id=? AND revoked_at IS NULL ORDER BY created_at DESC").bind(m.member.member_id).first();
async function enroll(m) {
  const start = await post("google/totp/enroll/start", { confirmed: true }, m.headers);
  assert.equal(start.status, 202);
  const setup = (await start.json()).data, otp = URI.parse(setup.otpauth_uri);
  await data(await post("google/totp/enroll/verify", { transaction_id: setup.transaction_id, code: otp.generate() },
    { ...m.headers, Cookie: m.cookie + "; " + responseCookie(start, LOGIN_COOKIE) }));
  return otp;
}
async function googleStep(m, otp) {
  const proof = await googleProof(local, m.email, m, "security");
  return data(await post("google/step-up", { transaction_id: proof.result.transaction_id,
    code: otp.generate({ timestamp: Date.now() + 30000 }) }, proof.headers));
}

for (const privilegedRole of ["admin", "super_admin"]) {
  test(privilegedRole + " Google TOTP grants only this session; reauth stays recent and logout requires new MFA", async () => {
    const m = await googleMember(local); await role(m, privilegedRole);
    const otp = await enroll(m);
    await expectError(await local.fetch("/api/admin/me", "GET", undefined, m.headers), 403, "ADMIN_STEP_UP_REQUIRED");
    const elevated = await googleStep(m, otp), stored = await session(m);
    assert.equal(elevated.elevated_until, stored.expires_at);
    assert.equal(stored.elevated_until, stored.expires_at);
    assert.equal(stored.reauthenticated_until, elevated.reauthenticated_until);
    assert.ok(elevated.reauthenticated_until <= Date.now() / 1000 + AUTH_LIMITS.securitySeconds);
    assert.equal((await data(await local.fetch("/api/admin/me", "GET", undefined, m.headers))).role, privilegedRole);
    // Security reauthentication expires independently, without closing admin UI.
    await local.db.prepare("UPDATE auth_sessions SET reauthenticated_until=0 WHERE token_hash=?").bind(stored.token_hash).run();
    await expectError(await post("recovery-codes/regenerate", {}, m.headers), 403, "AUTH_STEP_UP_REQUIRED");
    assert.equal((await local.fetch("/api/admin/campaigns", "GET", undefined, m.headers)).status, 200);
    await data(await post("logout", {}, m.headers));
    await expectError(await local.fetch("/api/admin/me", "GET", undefined, m.headers), 401, "AUTH_REQUIRED");
    const next = await googleMember(local, m.email), newSession = await session(next);
    assert.equal(next.member.member_id, m.member.member_id);
    assert.notEqual(next.cookie, m.cookie);
    assert.equal(newSession.elevated_until, 0);
    await expectError(await local.fetch("/api/admin/me", "GET", undefined, next.headers), 403, "ADMIN_STEP_UP_REQUIRED");
  });
}

test("password admin MFA login binds 30-day elevation; trusted-device re-login grants none", async () => {
  const m = await login(local); await role(m, "admin");
  const headers = { ...loginHeaders(), Cookie: m.cookie };
  const start = await post("login", { email: m.email, password: m.password, remember_me: true }, headers);
  assert.equal(start.status, 202); const tx = (await start.json()).data;
  const finish = await post("login/totp", { transaction_id: tx.transaction_id,
    code: m.otp.generate({ timestamp: Date.now() + 30000 }), trust_this_device: true },
    { ...headers, Cookie: m.cookie + "; " + responseCookie(start, LOGIN_COOKIE) });
  const result = await data(finish), cookie = responseCookie(finish, SESSION_COOKIE);
  const active = { ...m, cookie, headers: { ...loginHeaders(), Cookie: cookie, "X-CSRF-Token": result.csrf_token } };
  const stored = await session(active);
  assert.equal(stored.elevated_until, stored.expires_at);
  assert.equal(stored.expires_at - stored.created_at, AUTH_LIMITS.rememberSeconds);
  assert.equal((await local.fetch("/api/admin/me", "GET", undefined, active.headers)).status, 200);
  await expectError(await local.fetch("/api/admin/me", "GET", undefined, m.headers), 401, "AUTH_REQUIRED");
  const trusted = await login(local, active);
  assert.equal((await session(trusted)).elevated_until, 0);
  await expectError(await local.fetch("/api/admin/me", "GET", undefined, trusted.headers), 403, "ADMIN_STEP_UP_REQUIRED");
});

for (const value of [null, "reviewer", "inactive_admin"]) {
  test("password step-up preserves one-hour policy for " + (value ?? "ordinary member"), async () => {
    const m = await login(local);
    if (value) await role(m, value === "inactive_admin" ? "admin" : value, value === "inactive_admin" ? "disabled" : "active");
    const elevated = await data(await post("step-up", { password: m.password,
      code: m.otp.generate({ timestamp: Date.now() + 30000 }) }, m.headers));
    const stored = await session(m);
    assert.equal(elevated.elevated_until, stored.elevated_until);
    assert.ok(elevated.elevated_until <= Date.now() / 1000 + AUTH_LIMITS.elevationSeconds);
    assert.ok(elevated.elevated_until < stored.expires_at);
  });
}

test("admin step-up never extends a short session; expiry, revocation and role removal still deny", async () => {
  const m = await login(local); await role(m, "admin");
  const expiry = Math.floor(Date.now() / 1000) + 120;
  await local.db.prepare("UPDATE auth_sessions SET expires_at=? WHERE member_id=?").bind(expiry, m.member.member_id).run();
  const elevated = await data(await post("step-up", { password: m.password,
    code: m.otp.generate({ timestamp: Date.now() + 30000 }) }, m.headers));
  assert.equal(elevated.elevated_until, expiry);
  await local.db.prepare("UPDATE admin_memberships SET status='disabled' WHERE member_id=?").bind(m.member.member_id).run();
  await expectError(await local.fetch("/api/admin/me", "GET", undefined, m.headers), 403, "ADMIN_FORBIDDEN");
  await local.db.prepare("UPDATE admin_memberships SET status='active' WHERE member_id=?").bind(m.member.member_id).run();
  const stored = await session(m);
  await local.db.prepare("UPDATE auth_sessions SET created_at=1,expires_at=? WHERE token_hash=?").bind(Math.floor(Date.now() / 1000) - 1, stored.token_hash).run();
  await expectError(await local.fetch("/api/admin/me", "GET", undefined, m.headers), 401, "AUTH_REQUIRED");
  await local.db.prepare("UPDATE auth_sessions SET expires_at=?,revoked_at=? WHERE token_hash=?").bind(expiry, Math.floor(Date.now() / 1000), stored.token_hash).run();
  await expectError(await local.fetch("/api/admin/me", "GET", undefined, m.headers), 401, "AUTH_REQUIRED");
});

test("bad TOTP, replay and CSRF cannot grant or renew admin MFA", async () => {
  const m = await login(local); await role(m, "admin");
  await local.db.prepare("UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?").bind(m.member.member_id).run();
  const code = m.otp.generate({ timestamp: Date.now() + 30000 });
  await expectError(await post("step-up", { password: m.password, code }, { ...m.headers, "X-CSRF-Token": "wrong" }), 403, "CSRF_REJECTED");
  await expectError(await post("step-up", { password: m.password, code: "invalid" }, m.headers), 400, "AUTH_VERIFICATION_FAILED");
  assert.equal((await session(m)).elevated_until, 0);
  await data(await post("step-up", { password: m.password, code }, m.headers));
  const stored = await session(m);
  await expectError(await post("step-up", { password: m.password, code }, m.headers), 400, "AUTH_VERIFICATION_FAILED");
  assert.deepEqual(await session(m), stored);
});
