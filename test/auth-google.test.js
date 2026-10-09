import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { URI } from "otpauth";
import { localCaseRuntime, guestBody } from "../scripts/lib/local-case-runtime.mjs";
import { googleProof, googleMember } from "../scripts/lib/local-google-runtime.mjs";
import { login, loginHeaders, responseCookie, expectError } from "../scripts/lib/local-auth-runtime.mjs";
import { LOGIN_COOKIE, SESSION_COOKIE } from "../src/lib/auth-session.js";
let local;
before(async () => { local = await localCaseRuntime(); });
after(async () => { await local?.runtime.dispose(); });
const count = async (table, member) => (await local.db.prepare(`SELECT count(*) n FROM ${table}` + (member ? " WHERE member_id=?" : "")).bind(...(member ? [member] : [])).first()).n;
const post = (path, body, headers = loginHeaders()) => local.fetch("/api/auth/" + path, "POST", body, headers);
const confirm = (p, extra = {}) => post("google/confirm", { transaction_id: p.result.transaction_id, confirmed: true, nickname: "本機Google", ...extra }, p.headers);
async function passwordSetup(member) {
  const r = await post("password/add/start", { confirmed: true }, member.headers); assert.equal(r.status, 202);
  const data = (await r.json()).data;
  return { ...data, headers: { ...member.headers, Cookie: member.cookie + "; " + responseCookie(r, LOGIN_COOKIE) }, password: randomBytes(24).toString("base64url"), otp: URI.parse(data.otpauth_uri) };
}
const finishPassword = s => post("password/add/verify", { transaction_id: s.transaction_id, new_password: s.password, code: s.otp.generate() }, s.headers);

test("Google start uses minimal scopes, S256, distinct high entropy state/browser and no secret URL", async () => {
  const p = await googleProof(local); assert.equal(p.callback.status, 303);
  const url = new URL(p.data.authorize_url), callback = new URL(url.searchParams.get("redirect_to"));
  assert.equal(url.searchParams.get("scopes"), "openid email profile"); assert.equal(url.searchParams.get("code_challenge_method"), "s256");
  assert.match(callback.searchParams.get("state"), /^[A-Za-z0-9_-]{43}$/); assert.equal(callback.pathname, "/api/auth/google/callback");
  assert.notEqual(callback.searchParams.get("state"), p.browser.split("=")[1]);
  assert.ok(!p.data.authorize_url.includes(local.provider.config.SUPABASE_SECRET_KEY)); assert.equal(p.start.headers.get("cache-control"), "no-store");
  assert.match(p.start.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
});
test("Google-only profile creates one member without TOTP/recovery/password or email mail", async () => {
  const mails = local.provider.mails.length, p = await googleProof(local); assert.equal(p.result.status, "GOOGLE_PROFILE_REQUIRED");
  const r = await confirm(p); assert.equal(r.status, 200); const d = (await r.json()).data;
  assert.equal(await count("members", d.member.member_id), 1); assert.equal(await count("member_credentials", d.member.member_id), 0); assert.equal(await count("recovery_codes", d.member.member_id), 0);
  assert.equal(local.provider.mails.length, mails); assert.equal(d.recovery_codes, undefined);
  const i = await local.db.prepare("SELECT * FROM auth_identities WHERE member_id=?").bind(d.member.member_id).first(); assert.equal(i.password_enabled, 0); assert.equal(i.provider_subject, p.oauth.user.id);
});
test("Google profile validation does not create a member", async () => { const p = await googleProof(local); await expectError(await confirm(p, { nickname: "" }), 400, "INVALID_AUTH_REQUEST"); assert.equal(await count("members", p.oauth.user.id), 0); });
test("Google-only repeated login maps same member without MFA", async () => { const m = await googleMember(local), p = await googleProof(local, m.email); assert.equal(p.result.status, "GOOGLE_LOGIN_READY"); const r = await confirm(p); assert.equal(r.status, 200); assert.equal((await r.json()).data.member.member_id, m.member.member_id); });
test("password member same-email Google is already provider linked but requires local confirmation", async () => {
  const m = await login(local), p = await googleProof(local, m.email); assert.equal(p.result.status, "GOOGLE_CONFIRM_REQUIRED"); assert.equal(p.result.provider_already_linked, true); assert.equal(p.result.email, m.email);
  const old = await local.db.prepare("SELECT * FROM members WHERE member_id=?").bind(m.member.member_id).first();
  const r = await confirm(p); assert.equal(r.status, 200); const d = (await r.json()).data; assert.equal(d.member.member_id, m.member.member_id);
  const current = await local.db.prepare("SELECT * FROM members WHERE member_id=?").bind(m.member.member_id).first(); for (const f of ["id", "member_id", "nickname", "player_id", "created_at"]) assert.equal(current[f], old[f]);
  assert.equal(await count("auth_identities", m.member.member_id), 1);
});
test("cancel honestly retains provider link, disables local activation and issues no session", async () => {
  const m = await login(local), p = await googleProof(local, m.email); const r = await post("google/cancel", { transaction_id: p.result.transaction_id }, p.headers); assert.equal(r.status, 200);
  assert.equal((await r.json()).data.provider_unlinked, false); assert.ok(p.oauth.user.identities.some(i => i.provider === "google"));
  const i = await local.db.prepare("SELECT google_identity_id FROM auth_identities WHERE member_id=?").bind(m.member.member_id).first(); assert.equal(i.google_identity_id, null);
  await expectError(await confirm(p), 400, "AUTH_VERIFICATION_FAILED");
});
test("authenticated same-email connect requires consent and preserves owner", async () => {
  const m = await login(local); await expectError(await post("google/start", { purpose: "connect" }, m.headers), 400, "AUTH_VERIFICATION_FAILED");
  const p = await googleProof(local, m.email, m); const r = await confirm(p); assert.equal(r.status, 200); assert.equal((await r.json()).data.member.member_id, m.member.member_id);
});
test("authenticated different-email provider fails closed without a second VoteProof member", async () => {
  const m = await login(local), before = await count("members"), p = await googleProof(local, randomUUID() + "@local.example", m);
  await expectError(p.callback, 409, "AUTH_IDENTITY_CONFLICT"); assert.equal(await count("members"), before);
});
test("different Supabase UUID with same verified email never merges histories", async () => {
  const m = await googleMember(local), before = await count("members"), p = await googleProof(local, m.email, undefined, "login", { newSubject: true });
  await expectError(p.callback, 409, "AUTH_IDENTITY_CONFLICT"); assert.equal(await count("members"), before);
});
test("existing second member selected during connect is rejected", async () => { const a = await googleMember(local), b = await googleMember(local), p = await googleProof(local, b.email, a); await expectError(p.callback, 409, "AUTH_IDENTITY_CONFLICT"); });
test("Google callback replay rejected before provider exchange", async () => { const p = await googleProof(local), calls = local.provider.calls.length; await expectError(await local.fetch(p.oauth.path, "GET", undefined, { Cookie: p.browser }), 400, "AUTH_VERIFICATION_FAILED"); assert.equal(local.provider.calls.length, calls); });
test("Google callback requires state, initiating browser, exact path and one code", async () => {
  const p = await googleProof(local); for (const path of ["/api/auth/google/callback", p.oauth.path + "&code=duplicate", p.oauth.path.replace(/state=[^&]+/, "state=wrong")]) await expectError(await local.fetch(path), 400, "AUTH_VERIFICATION_FAILED");
});
test("unverified Google identity is rejected", async () => { const p = await googleProof(local, undefined, undefined, "login", { unverified: true }); await expectError(p.callback, 400, "AUTH_VERIFICATION_FAILED"); });
test("invalid provider subject is rejected without member insertion", async () => {
  const headers = loginHeaders(), r = await post("google/start", {}, headers), d = (await r.json()).data, o = local.provider.oauth(d.authorize_url, randomUUID() + "@local.example"); o.user.id = "invalid";
  await expectError(await local.fetch(o.path, "GET", undefined, { Cookie: responseCookie(r, "__Host-vp-google") }), 400, "AUTH_VERIFICATION_FAILED");
});
test("expired OAuth state cannot be used", async () => {
  const r = await post("google/start", {}), d = (await r.json()).data, o = local.provider.oauth(d.authorize_url, randomUUID() + "@local.example"); await local.db.prepare("UPDATE auth_google_flows SET created_at=1,expires_at=2 WHERE consumed_at IS NULL").run();
  await expectError(await local.fetch(o.path, "GET", undefined, { Cookie: responseCookie(r, "__Host-vp-google") }), 400, "AUTH_VERIFICATION_FAILED");
});
test("two callback tabs fail closed when browser binding changes", async () => {
  const a = await post("google/start", {}), b = await post("google/start", {}), o = local.provider.oauth((await a.json()).data.authorize_url, randomUUID() + "@local.example");
  await expectError(await local.fetch(o.path, "GET", undefined, { Cookie: responseCookie(b, "__Host-vp-google") }), 400, "AUTH_VERIFICATION_FAILED");
});
test("concurrent callback attempts consume state only once", async () => {
  const r = await post("google/start", {}), d = (await r.json()).data, o = local.provider.oauth(d.authorize_url, randomUUID() + "@local.example"), cookie = responseCookie(r, "__Host-vp-google");
  const results = await Promise.all([local.fetch(o.path, "GET", undefined, { Cookie: cookie }), local.fetch(o.path, "GET", undefined, { Cookie: cookie })]); assert.deepEqual(results.map(r => r.status).sort(), [303, 400]);
});
test("concurrent profile confirms create exactly one member", async () => { const p = await googleProof(local), before = await count("members"); const r = await Promise.all([confirm(p), confirm(p)]); assert.equal(r.filter(x => x.status === 200).length, 1); assert.equal(await count("members"), before + 1); });
test("Google and pending password enrollment cannot create parallel member histories", async () => {
  const { begin } = await import("../scripts/lib/local-auth-runtime.mjs"); const setup = await begin(local); const p = await googleProof(local, setup.email); await expectError(p.callback, 409, "AUTH_IDENTITY_CONFLICT");
});
test("add password requires explicit consent and fresh Google session", async () => { const m = await googleMember(local); await expectError(await post("password/add/start", {}, m.headers), 400, "AUTH_VERIFICATION_FAILED"); await local.db.prepare("UPDATE auth_sessions SET google_authenticated_until=0 WHERE member_id=?").bind(m.member.member_id).run(); await expectError(await post("password/add/start", { confirmed: true }, m.headers), 403, "AUTH_GOOGLE_REAUTH_REQUIRED"); });
test("incomplete password setup keeps Google usable and password login disabled", async () => {
  const m = await googleMember(local), s = await passwordSetup(m); assert.ok(s.otpauth_uri); const p = await googleProof(local, m.email); const r = await confirm(p); assert.equal(r.status, 200);
  await expectError(await post("login", { email: m.email, password: s.password }), 401, "AUTH_LOGIN_FAILED");
  assert.equal(await count("member_credentials", m.member.member_id), 0);
});
test("Google add password completes same member only after TOTP and recovery creation", async () => {
  const m = await googleMember(local), s = await passwordSetup(m); const r = await finishPassword(s); assert.equal(r.status, 200); const d = (await r.json()).data;
  assert.equal(d.member.member_id, m.member.member_id); assert.equal(d.recovery_codes.length, 10); assert.equal(await count("auth_identities", m.member.member_id), 1);
  const p = await googleProof(local, m.email); assert.equal((await (await confirm(p)).json()).data.member.member_id, m.member.member_id);
  const password = await post("login", { email: m.email, password: s.password }); assert.equal(password.status, 202); assert.equal((await password.json()).data.status, "MFA_REQUIRED");
});
test("wrong TOTP does not write password at provider", async () => { const m = await googleMember(local), s = await passwordSetup(m), calls = local.provider.calls.length; await expectError(await post("password/add/verify", { transaction_id: s.transaction_id, new_password: s.password, code: "bad" }, s.headers), 400, "AUTH_VERIFICATION_FAILED"); assert.equal(local.provider.calls.length, calls); });
test("provider password failure keeps disabled flag and Google login operational", async () => {
  const m = await googleMember(local), s = await passwordSetup(m); local.provider.failures.set("/auth/v1/admin/users/" + m.provider.id, { status: 503, once: true });
  await expectError(await finishPassword(s), 502, "AUTH_PROVIDER_UNAVAILABLE"); assert.equal((await local.db.prepare("SELECT password_enabled FROM auth_identities WHERE member_id=?").bind(m.member.member_id).first()).password_enabled, 0);
  assert.equal((await local.fetch("/api/auth/me", "GET", undefined, m.headers)).status, 200); assert.equal((await finishPassword(s)).status, 200);
});
test("concurrent add password transactions cannot enable conflicting passwords", async () => { const m = await googleMember(local), s = await passwordSetup(m); const r = await Promise.all([finishPassword(s), finishPassword(s)]); assert.equal(r.filter(x => x.status === 200).length, 1); assert.equal(await count("member_credentials", m.member.member_id), 1); });
test("Google member email registration is generic before proof and offers add password after proof", async () => {
  const m = await googleMember(local), headers = loginHeaders(), r = await post("register/start", { email: m.email, turnstile_token: randomUUID() }, headers); assert.equal(r.status, 202); const d = (await r.json()).data;
  assert.ok(!JSON.stringify(d).includes("Google")); const v = await post("register/verify-email", { challenge_id: d.challenge_id, code: local.provider.codeFor(m.email) }, { ...headers, Cookie: responseCookie(r, LOGIN_COOKIE) }); assert.equal(v.status, 202); const verified = (await v.json()).data; assert.equal(verified.status, "ADD_PASSWORD_REQUIRED");
  const start = await post("password/add/start", { transaction_id: verified.transaction_id, confirmed: true }, { ...headers, Cookie: responseCookie(v, LOGIN_COOKIE) }); assert.equal(start.status, 202); const s = (await start.json()).data;
  const finish = await post("password/add/verify", { transaction_id: s.transaction_id, code: URI.parse(s.otpauth_uri).generate(), new_password: randomBytes(24).toString("base64url") }, { ...headers, Cookie: responseCookie(start, LOGIN_COOKIE) }); assert.equal(finish.status, 200); assert.equal((await finish.json()).data.member.member_id, m.member.member_id); assert.equal(await count("auth_identities", m.member.member_id), 1);
});
test("Google login security exposes only own safe method state", async () => { const m = await googleMember(local), r = await local.fetch("/api/auth/login-security", "GET", undefined, m.headers); assert.equal(r.headers.get("cache-control"), "no-store"); const d = (await r.json()).data; assert.deepEqual(d.google, { connected: true, email: m.email }); assert.equal(d.password.configured, false); assert.equal(d.authenticator.configured, false); assert.equal(d.unlink_supported, false); });
test("no unlink endpoint can remove last method", async () => { const m = await googleMember(local); await expectError(await post("google/unlink", {}, m.headers), 404, "NOT_FOUND"); });
test("Google login never grants admin elevation; Google-only admin needs TOTP", async () => {
  const m = await googleMember(local); const now = new Date().toISOString(); await local.db.prepare("INSERT INTO admin_memberships(id,member_id,role,status,created_at,updated_at) VALUES(?,?,'admin','active',?,?)").bind(randomUUID(), m.member.member_id, now, now).run();
  await expectError(await local.fetch("/api/admin/leaderboards", "GET", undefined, m.headers), 403, "ADMIN_STEP_UP_REQUIRED"); const p = await googleProof(local, m.email, m, "security"); await expectError(await post("google/step-up", { transaction_id: p.result.transaction_id, code: "000000" }, p.headers), 403, "AUTH_MFA_ENROLLMENT_REQUIRED");
});
test("Google-only admin TOTP enrollment then fresh Google+TOTP permits existing RBAC", async () => {
  const m = await googleMember(local), now = new Date().toISOString(); await local.db.prepare("INSERT INTO admin_memberships(id,member_id,role,status,created_at,updated_at) VALUES(?,?,'reviewer','active',?,?)").bind(randomUUID(), m.member.member_id, now, now).run();
  const start = await post("google/totp/enroll/start", { confirmed: true }, m.headers); assert.equal(start.status, 202); const d = (await start.json()).data, otp = URI.parse(d.otpauth_uri), headers = { ...m.headers, Cookie: m.cookie + "; " + responseCookie(start, LOGIN_COOKIE) };
  const verify = await post("google/totp/enroll/verify", { transaction_id: d.transaction_id, code: otp.generate() }, headers); assert.equal(verify.status, 200);
  await expectError(await local.fetch("/api/admin/cases", "GET", undefined, m.headers), 403, "ADMIN_STEP_UP_REQUIRED");
  const p = await googleProof(local, m.email, m, "security"); const step = await post("google/step-up", { transaction_id: p.result.transaction_id, code: otp.generate({ timestamp: Date.now() + 30000 }) }, p.headers); assert.equal(step.status, 200);
  assert.equal((await local.fetch("/api/admin/cases", "GET", undefined, m.headers)).status, 200);
  assert.equal((await local.db.prepare("SELECT password_enabled FROM auth_identities WHERE member_id=?").bind(m.member.member_id).first()).password_enabled, 0);
});
test("Google member suspended state remains rejected", async () => { const m = await googleMember(local); await local.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(m.member.member_id).run(); const p = await googleProof(local, m.email); await expectError(p.callback, 403, "MEMBER_SUSPENDED"); });
test("Google start mutations enforce Origin and authenticated CSRF", async () => { await expectError(await post("google/start", {}, { ...loginHeaders(), Origin: "https://wrong.example" }), 403, "CSRF_REJECTED"); const m = await googleMember(local); await expectError(await post("google/start", { purpose: "connect", confirmed: true }, { ...m.headers, "X-CSRF-Token": "wrong" }), 403, "CSRF_REJECTED"); });
test("logged-in login route refuses silent account switching", async () => { const m = await googleMember(local); await expectError(await post("google/start", {}, m.headers), 409, "AUTH_IDENTITY_CONFLICT"); });
test("Google provider outage preserves Guest and password auth", async () => {
  const m = await login(local); local.provider.failures.set("/auth/v1/token", { status: 503, once: true }); const p = await googleProof(local); await expectError(p.callback, 502, "AUTH_PROVIDER_UNAVAILABLE");
  for (const path of ["/api/health", "/api/campaigns", "/api/leaderboards"]) assert.equal((await local.fetch(path)).status, 200);
  assert.equal((await post("login", { email: m.email, password: m.password })).status, 202);
});
test("Google member cases and Guest lookup retain own authorization and query credential", async () => {
  const m = await googleMember(local), upload = await local.upload(), body = guestBody(upload), r = await local.fetch("/api/cases", "POST", body, { ...m.headers, "Idempotency-Key": randomUUID() }); assert.equal(r.status, 201); const d = (await r.json()).data;
  assert.equal((await local.db.prepare("SELECT member_id FROM cases WHERE case_id=?").bind(d.case_id).first()).member_id, m.member.member_id);
  assert.equal((await local.fetch("/api/cases/" + d.case_id + "?key=" + d.query_key)).status, 200); assert.equal((await local.fetch("/api/me/cases/" + d.case_id, "GET", undefined, m.headers)).status, 200);
});
test("provider tokens/passwords/state verifiers do not persist in database or API", async () => {
  const m = await googleMember(local); const rows = [];
  for (const table of ["auth_transactions", "auth_google_flows", "auth_identities", "auth_identity_events", "auth_sessions", "auth_method_setups"]) rows.push((await local.db.prepare(`SELECT * FROM ${table}`).all()).results);
  const data = JSON.stringify(rows); for (const token of local.provider.tokens) assert.ok(!data.includes(token));
  const verified = local.provider.calls.filter(c => c.path === "/auth/v1/token" && c.body.code_verifier); for (const c of verified) assert.ok(!data.includes(c.body.code_verifier));
  assert.ok(!data.includes(local.provider.config.SUPABASE_SECRET_KEY)); assert.equal(m.recovery_codes, undefined);
});
test("new Google proofs in two browsers converge to the same UUID/member", async () => {
  const email = randomUUID() + "@local.example", a = await googleProof(local, email), b = await googleProof(local, email), before = await count("members");
  const results = await Promise.all([confirm(a), confirm(b)]), successful = [];
  for (const r of results) if (r.status === 200) successful.push((await r.json()).data.member.member_id);
  assert.ok(successful.length >= 1); assert.equal(new Set(successful).size, 1); assert.equal(await count("members"), before + 1);
});
test("concurrent authenticated links cannot publish an identity after initiating session revoked", async () => {
  const m = await login(local), a = await googleProof(local, m.email, m), b = await googleProof(local, m.email, m);
  const result = await Promise.all([confirm(a), confirm(b)]); assert.equal(result.filter(r => r.status === 200).length, 1); assert.equal(await count("auth_identities", m.member.member_id), 1);
});
test("add-password D1 failure after provider write keeps Google usable until durable retry", async () => {
  const m = await googleMember(local), s = await passwordSetup(m);
  await local.db.prepare("CREATE TRIGGER local_method_failure BEFORE INSERT ON member_credentials BEGIN SELECT RAISE(ABORT,'local fixture failure'); END").run();
  try { await expectError(await finishPassword(s), 503, "AUTH_SERVICE_UNAVAILABLE"); }
  finally { await local.db.prepare("DROP TRIGGER local_method_failure").run(); }
  assert.equal(local.provider.users.get(m.provider.id).password === s.password, true);
  assert.equal((await local.fetch("/api/auth/me", "GET", undefined, m.headers)).status, 200);
  await expectError(await post("login", { email: m.email, password: s.password }), 401, "AUTH_LOGIN_FAILED");
  assert.equal((await finishPassword(s)).status, 200);
});
test("identity mappings and audit cannot be rewritten", async () => {
  const m = await googleMember(local);
  await assert.rejects(local.db.prepare("UPDATE auth_identities SET provider_subject=? WHERE member_id=?").bind(randomUUID(), m.member.member_id).run());
  await assert.rejects(local.db.prepare("UPDATE auth_identity_events SET action='google_cancelled' WHERE member_id=?").bind(m.member.member_id).run());
});
test("password-to-Google linking preserves actual cases ledger and tier", async () => {
  const m = await login(local), r = await local.fetch("/api/cases", "POST", guestBody(await local.upload()), { ...m.headers, "Idempotency-Key": randomUUID() }); assert.equal(r.status, 201); const c = (await r.json()).data;
  await local.db.prepare("INSERT INTO point_transactions(transaction_id,created_at,member_id,category,points,reason,created_by,idempotency_hash,request_hash) VALUES(?,?,?,'manual_adjustment',12,'local identity fixture',?,?,?)")
    .bind(randomUUID(), new Date().toISOString(), m.member.member_id, m.member.member_id, randomBytes(32).toString("hex"), randomBytes(32).toString("hex")).run();
  const before = await (await local.fetch("/api/me/points", "GET", undefined, m.headers)).json(); const p = await googleProof(local, m.email), result = await confirm(p); assert.equal(result.status, 200); const d = (await result.json()).data;
  const headers = { ...loginHeaders(), Cookie: responseCookie(result, SESSION_COOKIE), "X-CSRF-Token": d.csrf_token };
  const after = await (await local.fetch("/api/me/points", "GET", undefined, headers)).json(); assert.deepEqual(after, before);
  assert.equal((await local.fetch("/api/me/cases/" + c.case_id, "GET", undefined, headers)).status, 200); assert.equal(await count("point_transactions", m.member.member_id), 1);
});
test("callback and confirm reject a member signed in from another tab during OAuth", async () => {
  const m = await googleMember(local), p = await googleProof(local);
  await expectError(await confirm({ ...p, headers: { ...p.headers, Cookie: p.headers.Cookie + "; " + m.cookie, "X-CSRF-Token": m.csrf_token } }), 409, "AUTH_IDENTITY_CONFLICT");
});
test("Google-only TOTP member cannot gain password through recovery", async () => {
  const m = await googleMember(local), start = await post("google/totp/enroll/start", { confirmed: true }, m.headers), data = (await start.json()).data, otp = URI.parse(data.otpauth_uri);
  const verify = await post("google/totp/enroll/verify", { transaction_id: data.transaction_id, code: otp.generate() }, { ...m.headers, Cookie: m.cookie + "; " + responseCookie(start, LOGIN_COOKIE) }); assert.equal(verify.status, 200); const codes = (await verify.json()).data.recovery_codes;
  const r = await post("recovery/password/start", { email: m.email, code: otp.generate({ timestamp: Date.now() + 30000 }), recovery_code: codes[0] }); assert.equal(r.status, 202); const tx = (await r.json()).data;
  await expectError(await post("recovery/password/finish", { transaction_id: tx.transaction_id, new_password: randomBytes(24).toString("base64url") }, { ...loginHeaders(), Cookie: responseCookie(r, LOGIN_COOKIE) }), 400, "AUTH_VERIFICATION_FAILED");
  assert.equal((await local.db.prepare("SELECT password_enabled FROM auth_identities WHERE member_id=?").bind(m.member.member_id).first()).password_enabled, 0);
});
