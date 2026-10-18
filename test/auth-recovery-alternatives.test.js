import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { localCaseRuntime } from "../scripts/lib/local-case-runtime.mjs";
import { login, loginHeaders, responseCookie, expectError } from "../scripts/lib/local-auth-runtime.mjs";
import { LOGIN_COOKIE } from "../src/lib/auth-session.js";
let local;
before(async () => { local = await localCaseRuntime(); });
after(async () => { await local?.runtime.dispose(); });
const secret = () => randomBytes(24).toString("base64url");
const code = m => m.otp.generate({ timestamp: Date.now() + 30000 });
async function start(m, proof, headers = loginHeaders()) {
  const r = await local.fetch("/api/auth/recovery/password/start", "POST", { email: m.email, ...proof }, headers);
  assert.equal(r.status, 202); assert.equal(r.headers.get("cache-control"), "no-store");
  const d = (await r.json()).data;
  assert.deepEqual(Object.keys(d).sort(), ["expires_in", "transaction_id"]);
  return { id: d.transaction_id, headers: { ...headers, Cookie: responseCookie(r, LOGIN_COOKIE) } };
}
const finish = (tx, password = secret(), headers = tx.headers) => local.fetch("/api/auth/recovery/password/finish", "POST", { transaction_id: tx.id, new_password: password }, headers);
const spent = async m => (await local.db.prepare("SELECT COUNT(*) n FROM recovery_codes WHERE member_id=? AND used_at IS NOT NULL").bind(m.member.member_id).first()).n;
test("TOTP alone resets password without spending recovery codes or granting a session", async () => {
  const m = await login(local), tx = await start(m, { code: code(m) }), next = secret();
  const r = await finish(tx, next); assert.equal(r.status, 200);
  const d = (await r.json()).data; assert.equal(d.recovered, true); assert.equal(d.login_required, true); assert.equal(d.member, undefined);
  assert.equal(await spent(m), 0);
  await expectError(await local.fetch("/api/auth/me", "GET", undefined, m.headers), 401, "AUTH_REQUIRED");
  const l = await local.fetch("/api/auth/login", "POST", { email: m.email, password: next }, loginHeaders());
  assert.equal(l.status, 202); assert.equal((await l.json()).data.status, "MFA_REQUIRED");
  await expectError(await finish(tx), 400, "AUTH_VERIFICATION_FAILED");
});
test("TOTP replay and concurrent starts authorize exactly one password reset", async () => {
  const m = await login(local), proof = { code: code(m) };
  const txs = await Promise.all([start(m, proof), start(m, proof)]);
  const rs = await Promise.all(txs.map(t => finish(t)));
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 400]); assert.equal(await spent(m), 0);
  await expectError(await finish(await start(m, proof)), 400, "AUTH_VERIFICATION_FAILED");
});
test("unused recovery code alone resets password once and preserves TOTP enrollment", async () => {
  const m = await login(local), tx = await start(m, { recovery_code: m.recovery_codes[0] });
  assert.equal(await spent(m), 0); assert.equal((await finish(tx)).status, 200); assert.equal(await spent(m), 1);
  await expectError(await finish(await start(m, { recovery_code: m.recovery_codes[0] })), 400, "AUTH_VERIFICATION_FAILED");
  const c = await local.db.prepare("SELECT totp_ciphertext,recovery_generation FROM member_credentials WHERE member_id=?").bind(m.member.member_id).first();
  assert.ok(c.totp_ciphertext); assert.equal(c.recovery_generation, 1);
});
test("concurrent recovery-code-only transactions cannot spend the same code twice", async () => {
  const m = await login(local), proof = { recovery_code: m.recovery_codes[0] };
  const txs = await Promise.all([start(m, proof), start(m, proof)]);
  assert.deepEqual((await Promise.all(txs.map(t => finish(t)))).map(r => r.status).sort(), [200, 400]); assert.equal(await spent(m), 1);
});
test("missing, malformed, wrong-account and mixed invalid proofs never fall back", async () => {
  const m = await login(local), other = await login(local);
  for (const proof of [{}, { code: "bad" }, { recovery_code: "bad" }, { recovery_code: other.recovery_codes[0] }, { code: "bad", recovery_code: m.recovery_codes[0] }, { code: code(m), recovery_code: "bad" }]) {
    await expectError(await finish(await start(m, proof)), 400, "AUTH_VERIFICATION_FAILED");
  }
  assert.equal(await spent(m), 0);
  assert.equal((await finish(await start(m, { code: code(m), recovery_code: m.recovery_codes[0] }))).status, 200);
  assert.equal(await spent(m), 1);
});
test("suspended, password-disabled and unknown accounts return generic transactions but cannot reset", async () => {
  const m = await login(local);
  await local.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(m.member.member_id).run();
  await expectError(await finish(await start(m, { code: code(m) })), 400, "AUTH_VERIFICATION_FAILED");
  await local.db.prepare("UPDATE members SET status='active' WHERE member_id=?").bind(m.member.member_id).run();
  await local.db.prepare("UPDATE auth_identities SET password_enabled=0 WHERE member_id=?").bind(m.member.member_id).run();
  await expectError(await finish(await start(m, { recovery_code: m.recovery_codes[0] })), 400, "AUTH_VERIFICATION_FAILED");
  await expectError(await finish(await start({ email: "missing@local.example" }, { code: "123456" })), 400, "AUTH_VERIFICATION_FAILED");
});
test("TOTP-only provider failure keeps durable lock and supports authorized retry", async () => {
  const m = await login(local), tx = await start(m, { code: code(m) });
  const identity = await local.db.prepare("SELECT provider_subject FROM auth_identities WHERE member_id=?").bind(m.member.member_id).first();
  local.provider.failures.set("/auth/v1/admin/users/" + identity.provider_subject, { status: 503, once: true });
  const next = secret(); await expectError(await finish(tx, next), 502, "AUTH_PROVIDER_UNAVAILABLE");
  await expectError(await local.fetch("/api/auth/me", "GET", undefined, m.headers), 401, "AUTH_REQUIRED");
  assert.equal((await finish(tx, next)).status, 200); assert.equal(await spent(m), 0);
});
test("either proof retains browser binding, Origin protection and expiry", async () => {
  for (const method of ["totp", "recovery_code"]) {
    const m = await login(local), tx = await start(m, method === "totp" ? { code: code(m) } : { recovery_code: m.recovery_codes[0] });
    await expectError(await finish(tx, secret(), loginHeaders()), 400, "AUTH_VERIFICATION_FAILED");
    await expectError(await finish(tx, secret(), { ...tx.headers, Origin: "https://attacker.example" }), 403, "CSRF_REJECTED");
    const now = Math.floor(Date.now()/1000); await local.db.prepare("UPDATE auth_transactions SET created_at=?,expires_at=? WHERE id=?").bind(now-1000,now-1,tx.id).run();
    await expectError(await finish(tx), 400, "AUTH_VERIFICATION_FAILED");
  }
});
test("credential changes invalidate either proof before the password operation is reserved", async () => {
  for (const method of ["totp", "recovery_code"]) {
    const m = await login(local), tx = await start(m, method === "totp" ? { code: code(m) } : { recovery_code: m.recovery_codes[0] });
    await local.db.prepare("UPDATE member_credentials SET version=version+1 WHERE member_id=?").bind(m.member.member_id).run();
    await expectError(await finish(tx), 400, "AUTH_VERIFICATION_FAILED"); assert.equal(await spent(m), 0);
    assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM auth_password_operations WHERE member_id=?").bind(m.member.member_id).first()).n,0);
  }
});
