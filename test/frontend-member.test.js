import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { MemberSession, emailValue, passwordValue, codeValue, authMessage } from "../public/js/member-api.js";
import { enrollmentKey, drawEnrollment, clearEnrollment } from "../public/js/qr.js";
import { Submission } from "../public/js/submission.js";
import { PublicError } from "../public/js/api.js";

const sessionData = (member_id = randomUUID()) => ({ member: { member_id, nickname: "會員", player_id: "player", status: "active", email: "hidden", token_hash: "hidden" },
  csrf_token: randomBytes(32).toString("hex"), expires_in: 600 });
test("member transport uses Worker-relative cookies, CSRF, no-store and safe errors", async () => {
  let options;
  const session = new MemberSession({ fetcher: async (_path, opt) => { options = opt; return Response.json({ ok: true, data: {} }); } });
  const data = sessionData(); session.accept(data);
  await session.request("/api/me/profile", { method: "PATCH", body: { nickname: "會員" } });
  assert.equal(options.credentials, "same-origin"); assert.equal(options.headers["X-CSRF-Token"] === data.csrf_token, true);
  assert.equal(options.headers["X-VoteProof-Request"], "1"); assert.equal(options.cache, "no-store"); assert.equal(options.referrerPolicy, "no-referrer");
  assert.deepEqual(Object.keys(session.member).sort(), ["member_id", "nickname", "player_id"]); session.clear();
});
test("member transport rejects absolute/provider/R2/admin paths before fetch", async () => {
  let calls = 0; const session = new MemberSession({ fetcher: () => { calls++; } });
  for (const path of ["https://provider.example/api/auth/login", "//other.example/api/auth/me", "/api/admin/leaderboards", "/api/auth/me#token", "/api/auth/../me"])
    await assert.rejects(session.request(path), { code: "INVALID_AUTH_REQUEST" });
  assert.equal(calls, 0);
});
test("session invalidated once without an automatic request loop", async () => {
  let calls = 0;
  const session = new MemberSession({ fetcher: async () => { calls++; return Response.json({ ok: false, error: { code: "AUTH_REQUIRED", message: "internal" } }, { status: 401 }); } });
  session.accept(sessionData()); await assert.rejects(session.refresh(), { code: "AUTH_REQUIRED" });
  assert.equal(session.member, null); assert.equal(calls, 1);
});
test("suspended member clears only session state", async () => {
  const session = new MemberSession({ fetcher: async () => Response.json({ ok: false, error: { code: "MEMBER_SUSPENDED" } }, { status: 403 }) });
  session.accept(sessionData()); await assert.rejects(session.request("/api/me/points"), { code: "MEMBER_SUSPENDED" }); assert.equal(session.member, null);
});
test("old failed request cannot clear a newly accepted login", async () => {
  let finish; const session = new MemberSession({ fetcher: () => new Promise(resolve => { finish = resolve; }) });
  session.accept(sessionData()); const old = session.refresh(); const next = sessionData(); session.accept(next);
  finish(Response.json({ ok: false, error: { code: "AUTH_REQUIRED" } }, { status: 401 }));
  await assert.rejects(old); assert.equal(session.member.member_id, next.member.member_id); session.clear();
});
test("session deadline logs out locally without polling", async () => {
  const session = new MemberSession(); session.accept({ ...sessionData(), expires_in: .001 });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(session.member, null);
});
test("member case sender pins identity, refreshes CSRF and refuses cross-tab owner change", async () => {
  const first = sessionData(), second = sessionData(); let me = first, posts = 0;
  const session = new MemberSession({ fetcher: async path => {
    if (path === "/api/auth/me") return Response.json({ ok: true, data: me });
    posts++; return Response.json({ ok: true, data: {} });
  } });
  session.accept(first); const send = session.caseSender(); await send("/api/cases", { method: "POST", body: {} }); assert.equal(posts, 1);
  me = second; await assert.rejects(send("/api/cases", { method: "POST", body: {} }), { code: "AUTH_IDENTITY_CHANGED" }); assert.equal(posts, 1); session.clear();
});
test("member pending submission cannot downgrade to Guest after logout", async () => {
  const session = new MemberSession(); session.accept(sessionData()); const send = session.caseSender(); session.clear();
  await assert.rejects(send("/api/cases", { method: "POST", body: {} }), { code: "AUTH_IDENTITY_CHANGED" });
});
test("member Submission retry retains the same case transport/body/idempotency", async () => {
  const session_id = randomUUID(), calls = [], result = { case_id: "VP-20261009-" + "A".repeat(16), query_key: randomBytes(32).toString("base64url") };
  const flow = new Submission({ api: async path => {
    if (path.endsWith("prepare")) return { session_id, expires_in: 300, uploads: [{ key: "local", method: "PUT", headers: { "Content-Type": "image/png" }, upload_url: `https://${randomBytes(16).toString("hex")}.r2.cloudflarestorage.com/local` }] };
    if (path === "/api/cases") assert.fail("Guest transport must not be used");
    return {};
  }, token: async () => randomUUID(), put: async () => {} });
  flow.start({ nickname: "會員", player_id: "player", campaign_id: "LOCAL", vote_type: "Solo", vote_date: "2026-10-09" }, [{ type: "image/png", size: 3 }],
    { caseApi: async (_path, options) => { calls.push(options); if (calls.length === 1) throw new PublicError("NETWORK_ERROR"); return result; } });
  await assert.rejects(flow.attempt()); await flow.attempt();
  assert.equal(calls[0].body === calls[1].body, true); assert.equal(calls[0].headers["Idempotency-Key"] === calls[1].headers["Idempotency-Key"], true);
  assert.equal("member_id" in JSON.parse(calls[0].body), false);
});
test("email normalization matches backend including invalid dotted addresses", () => {
  assert.equal(emailValue("  Member@Example.com "), "member@example.com");
  for (const email of [".user@example.com", "user.@example.com", "user..a@example.com", "missing", "a@-bad.example", "名@example.com"])
    assert.throws(() => emailValue(email), { code: "EMAIL_FORMAT" });
});
test("password validation preserves whitespace and Unicode codepoint contract", () => {
  assert.equal(passwordValue(" " + "a".repeat(12) + " "), " " + "a".repeat(12) + " ");
  assert.equal(passwordValue("😀".repeat(12)), "😀".repeat(12));
  for (const password of ["short", "a".repeat(129), "a".repeat(12) + "\u0000", "a".repeat(12) + "\ud800"])
    assert.throws(() => passwordValue(password), { code: "PASSWORD_FORMAT" });
  assert.throws(() => passwordValue("a".repeat(12), "b".repeat(12)), { code: "PASSWORD_MISMATCH" });
});
test("verification code accepts leading zeros and rejects other alphabets", () => {
  assert.equal(codeValue(" 001234 "), "001234");
  for (const code of ["12345", "1234567", "１２３４５６", "12 345"]) assert.throws(() => codeValue(code), { code: "CODE_FORMAT" });
});
test("auth error display never renders internal/provider messages", () => {
  assert.equal(authMessage({ code: "unknown", message: "private upstream" }).includes("private upstream"), false);
  assert.equal(authMessage({ code: "MEMBER_SUSPENDED" }), authMessage({ code: "AUTH_REQUIRED" }));
});
test("QR renderer draws actual modules locally with quiet zone and erases canvas", () => {
  const key = "A".repeat(32), uri = `otpauth://totp/VoteProof:test%40example.com?secret=${key}&issuer=VoteProof&algorithm=SHA1&digits=6&period=30`;
  const squares = [], context = { fillRect: (...args) => squares.push(args), clearRect: () => { squares.length = 0; } };
  const canvas = { getContext: () => context };
  assert.equal(enrollmentKey(uri), key); drawEnrollment(canvas, uri);
  assert.ok(canvas.width > 200); assert.ok(squares.length > 100);
  assert.ok(squares.slice(1).every(([x, y]) => x >= 20 && y >= 20));
  clearEnrollment(canvas); assert.equal(canvas.width, 0); assert.equal(squares.length, 0);
});
test("QR input rejects non-enrollment URL and invalid manual secret", () => {
  for (const uri of ["https://qr.example/private", "otpauth://hotp/VoteProof?secret=" + "A".repeat(32), "otpauth://totp/VoteProof?secret=short"])
    assert.throws(() => enrollmentKey(uri));
});
