import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { localCaseRuntime, guestBody } from "../scripts/lib/local-case-runtime.mjs";
import { login, expectError } from "../scripts/lib/local-auth-runtime.mjs";
import { createCase } from "../src/api/cases.js";
import { sessionHash } from "../src/lib/auth-session.js";

let local;
// Node lacks the Workers-specific constant-time Web Crypto extension.
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
before(async () => { local = await localCaseRuntime(); });
after(async () => { await local?.runtime.dispose(); });
async function memberCase(member, reference, key = randomUUID(), extra = {}) {
  const body = { ...guestBody(reference), ...extra }, headers = { ...member.headers, "Idempotency-Key": key };
  const response = await local.fetch("/api/cases", "POST", body, headers); assert.equal(response.status, 201);
  return { data: (await response.json()).data, body, headers, key };
}

test("profile supports trimmed validated nickname/player_id, never exposes email or internal id", async () => {
  const member = await login(local), response = await local.fetch("/api/me/profile", "PATCH", { nickname: "  新暱稱  ", player_id: "  PLAYER  " }, member.headers);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const data = (await response.json()).data.member;
  assert.equal(data.nickname, "新暱稱"); assert.equal(data.player_id, "PLAYER"); assert.equal(data.member_id, member.member.member_id);
  for (const key of ["id", "email", "token_hash"]) assert.equal(Object.hasOwn(data, key), false);
});
for (const [name, body] of [["blank nickname", { nickname: " " }], ["long nickname", { nickname: "長".repeat(51) }],
  ["blank player", { player_id: " " }], ["long player", { player_id: "a".repeat(101) }], ["control", { nickname: "a\n" }],
  ["non-string", { nickname: 1 }], ["empty", {}], ["email", { email: "other@example.test" }],
  ["member_id", { member_id: "other" }], ["status", { status: "active" }]]) {
  test("profile rejects " + name, async () => {
    const member = await login(local);
    await expectError(await local.fetch("/api/me/profile", "PATCH", body, member.headers), 400, "INVALID_AUTH_REQUEST");
  });
}
test("profile accepts Unicode boundary lengths and independent concurrent partial updates", async () => {
  const member = await login(local), responses = await Promise.all([
    local.fetch("/api/me/profile", "PATCH", { nickname: "🦊".repeat(50) }, member.headers),
    local.fetch("/api/me/profile", "PATCH", { player_id: "a".repeat(100) }, member.headers),
  ]); for (const response of responses) assert.equal(response.status, 200);
  const data = (await (await local.fetch("/api/auth/me", "GET", undefined, member.headers)).json()).data.member;
  assert.equal(data.nickname, "🦊".repeat(50)); assert.equal(data.player_id, "a".repeat(100));
});
test("member case binds server identity, preserves B3 logical response and metadata snapshots", async () => {
  const member = await login(local), created = await memberCase(member, await local.upload());
  assert.deepEqual(Object.keys(created.data).sort(), ["case_id", "query_key", "status"]);
  const row = await local.db.prepare("SELECT * FROM cases WHERE case_id=?").bind(created.data.case_id).first();
  assert.equal(row.member_id, member.member.member_id); assert.equal(row.source, "member");
  assert.equal(row.nickname, created.body.nickname); assert.equal(row.player_id, created.body.player_id);
  await local.fetch("/api/me/profile", "PATCH", { nickname: "Changed", player_id: "Changed" }, member.headers);
  const found = (await (await local.fetch(`/api/me/cases/${created.data.case_id}`, "GET", undefined, member.headers)).json()).data;
  assert.equal(found.nickname, created.body.nickname); assert.equal(JSON.stringify(found).includes("query_key"), false);
});
test("client supplied member_id cannot bind or impersonate another member", async () => {
  const a = await login(local), b = await login(local), reference = await local.upload();
  await expectError(await local.fetch("/api/cases", "POST", { ...guestBody(reference), member_id: b.member.member_id }, a.headers), 400, "INVALID_CASE_REQUEST");
  const created = await memberCase(a, reference);
  assert.equal((await local.db.prepare("SELECT member_id FROM cases WHERE case_id=?").bind(created.data.case_id).first()).member_id, a.member.member_id);
});
test("owner-only case queries deny other member, absent id and Guest cases uniformly", async () => {
  const a = await login(local), b = await login(local), created = await memberCase(a, await local.upload());
  assert.equal((await local.fetch(`/api/me/cases/${created.data.case_id}`, "GET", undefined, a.headers)).status, 200);
  const denied = await expectError(await local.fetch(`/api/me/cases/${created.data.case_id}`, "GET", undefined, b.headers), 404, "CASE_NOT_FOUND");
  const absent = created.data.case_id.slice(0, 12) + "A".repeat(16);
  assert.deepEqual(await expectError(await local.fetch(`/api/me/cases/${absent}`, "GET", undefined, b.headers), 404, "CASE_NOT_FOUND"), denied);
  const guest = (await (await local.fetch("/api/cases", "POST", guestBody(await local.upload()))).json()).data;
  await expectError(await local.fetch(`/api/me/cases/${guest.case_id}`, "GET", undefined, a.headers), 404, "CASE_NOT_FOUND");
});
test("paginated list is owner-scoped, stable for timestamp ties and has private field whitelist", async () => {
  const a = await login(local), b = await login(local), ids = [];
  for (let i = 0; i < 3; i++) ids.push((await memberCase(a, await local.upload())).data.case_id);
  await memberCase(b, await local.upload());
  await local.db.prepare("UPDATE cases SET created_at='2026-10-01T00:00:00.000Z' WHERE member_id=?").bind(a.member.member_id).run();
  const page = (await (await local.fetch("/api/me/cases?limit=2", "GET", undefined, a.headers)).json()).data;
  assert.equal(page.cases.length, 2); assert.ok(page.next_cursor);
  const next = (await (await local.fetch("/api/me/cases?limit=2&cursor=" + page.next_cursor, "GET", undefined, a.headers)).json()).data;
  assert.equal(next.cases.length, 1); assert.equal(next.next_cursor, null);
  assert.deepEqual([...page.cases, ...next.cases].map(c => c.case_id).sort(), ids.sort());
  for (const row of [...page.cases, ...next.cases]) {
    assert.deepEqual(Object.keys(row).sort(), ["case_id", "created_at", "nickname", "campaign_id", "vote_type", "vote_date", "status", "points_awarded", "files"].sort());
    assert.deepEqual(row.files, [{ content_type: "image/png", size: 3 }]);
  }
  const empty = await login(local);
  assert.deepEqual((await (await local.fetch("/api/me/cases", "GET", undefined, empty.headers)).json()).data, { cases: [], next_cursor: null });
});
test("invalid pagination and client member_id cannot alter list authorization", async () => {
  const member = await login(local);
  for (const query of ["limit=0", "limit=51", "limit=-1", "limit=1.5", "limit=1&limit=2", "cursor=bad", "member_id=other", "cursor=" + "a".repeat(201)])
    await expectError(await local.fetch("/api/me/cases?" + query, "GET", undefined, member.headers), 400, "INVALID_PAGINATION");
});
test("Member and Guest cases remain query-key accessible independently of login", async () => {
  const member = await login(local), created = await memberCase(member, await local.upload());
  assert.equal((await local.fetch(`/api/cases/${created.data.case_id}?key=${created.data.query_key}`)).status, 200);
  await expectError(await local.fetch(`/api/cases/${created.data.case_id}?key=wrong`), 404, "CASE_NOT_FOUND");
  const reference = await local.upload(), key = randomUUID(), body = guestBody(reference);
  const guest = (await (await local.fetch("/api/cases", "POST", body, { "Idempotency-Key": key })).json()).data;
  const replay = (await (await local.fetch("/api/cases", "POST", body, { "Idempotency-Key": key })).json()).data;
  assert.deepEqual(replay, guest); assert.equal((await local.fetch(`/api/cases/${guest.case_id}?key=${guest.query_key}`)).status, 200);
  assert.equal((await local.db.prepare("SELECT member_id FROM cases WHERE case_id=?").bind(guest.case_id).first()).member_id, null);
});
test("member idempotency retains logical credential across profile/session changes", async () => {
  const a = await login(local), created = await memberCase(a, await local.upload());
  await local.fetch("/api/me/profile", "PATCH", { nickname: "updated" }, a.headers);
  const same = await local.fetch("/api/cases", "POST", created.body, created.headers);
  assert.equal(same.status, 201); assert.deepEqual((await same.json()).data, created.data);
  const fresh = await login(local, a.email);
  const replay = await local.fetch("/api/cases", "POST", created.body, { ...fresh.headers, "Idempotency-Key": created.key });
  assert.equal(replay.status, 201); assert.deepEqual((await replay.json()).data, created.data);
  await expectError(await local.fetch("/api/cases", "POST", { ...created.body, note: "different" }, { ...fresh.headers, "Idempotency-Key": created.key }), 409, "IDEMPOTENCY_CONFLICT");
});
test("same idempotency key for Member A/B or Guest cannot replay another owner's credential", async () => {
  const a = await login(local), b = await login(local), key = randomUUID(), created = await memberCase(a, await local.upload(), key);
  await expectError(await local.fetch("/api/cases", "POST", created.body, { ...b.headers, "Idempotency-Key": key }), 409, "UPLOAD_ALREADY_USED");
  await expectError(await local.fetch("/api/cases", "POST", created.body, { "Idempotency-Key": key }), 409, "UPLOAD_ALREADY_USED");
  const second = await memberCase(b, await local.upload(), key);
  assert.notEqual(second.data.case_id, created.data.case_id); assert.notEqual(second.data.query_key, created.data.query_key);
});
test("concurrent member submissions produce one case and preserve upload consumption constraint", async () => {
  const member = await login(local), body = guestBody(await local.upload()), key = randomUUID(), headers = { ...member.headers, "Idempotency-Key": key };
  const responses = await Promise.all(Array.from({ length: 3 }, () => local.fetch("/api/cases", "POST", body, headers)));
  const payloads = [];
  for (const response of responses) { assert.equal(response.status, 201); payloads.push((await response.json()).data); }
  for (const payload of payloads) assert.deepEqual(payload, payloads[0]);
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM cases WHERE member_id=?").bind(member.member.member_id).first()).n, 1);
  await expectError(await local.fetch("/api/cases", "POST", body, member.headers), 409, "UPLOAD_ALREADY_USED");
});
test("member mutations reject missing/bad/other session CSRF tokens and cross-site origin", async () => {
  const member = await login(local), other = await login(local), body = guestBody(await local.upload());
  for (const fields of [{ "X-CSRF-Token": undefined }, { "X-CSRF-Token": "bad" }, { "X-CSRF-Token": other.csrf_token }, { Origin: "https://attacker.example" }]) {
    const h = { ...member.headers, ...fields }; for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    await expectError(await local.fetch("/api/cases", "POST", body, h), 403, "CSRF_REJECTED");
    await expectError(await local.fetch("/api/me/profile", "PATCH", { nickname: "changed" }, h), 403, "CSRF_REJECTED");
  }
});
test("unauthenticated member-only APIs reject, invalid session cannot downgrade a case to Guest", async () => {
  for (const path of ["/api/me/cases", "/api/me/cases/unknown", "/api/auth/me"])
    await expectError(await local.fetch(path), 401, "AUTH_REQUIRED");
  await expectError(await local.fetch("/api/me/profile", "PATCH", { nickname: "guest" }), 401, "AUTH_REQUIRED");
  await expectError(await local.fetch("/api/cases", "POST", guestBody(await local.upload()), { Cookie: "__Host-vp-session=" + randomBytes(32).toString("base64url") }), 401, "AUTH_REQUIRED");
});
test("suspension blocks every member API/case/replay while Guest query/create continue", async () => {
  const member = await login(local), created = await memberCase(member, await local.upload());
  await local.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(member.member.member_id).run();
  for (const path of ["/api/me/cases", `/api/me/cases/${created.data.case_id}`, "/api/auth/me"])
    await expectError(await local.fetch(path, "GET", undefined, member.headers), 403, "MEMBER_SUSPENDED");
  await expectError(await local.fetch("/api/me/profile", "PATCH", { nickname: "changed" }, member.headers), 403, "MEMBER_SUSPENDED");
  await expectError(await local.fetch("/api/cases", "POST", created.body, created.headers), 403, "MEMBER_SUSPENDED");
  assert.equal((await local.fetch(`/api/cases/${created.data.case_id}?key=${created.data.query_key}`, "GET", undefined, member.headers)).status, 200);
  assert.equal((await local.fetch("/api/cases", "POST", guestBody(await local.upload()))).status, 201);
});
test("suspension or session revocation during R2 copy cannot race the D1 ownership guard", async () => {
  for (const suspend of [true, false]) {
    const member = await login(local), reference = await local.upload(), before = (await local.bucket.list({ prefix: "proofs/cases/" })).objects.length;
    const bucket = { get: local.bucket.get.bind(local.bucket), delete: local.bucket.delete.bind(local.bucket),
      put: async (...args) => {
        const result = await local.bucket.put(...args);
        if (suspend) await local.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(member.member.member_id).run();
        else await local.db.prepare("UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?").bind(Math.floor(Date.now()/1000), await sessionHash(member.cookie.split("=")[1])).run();
        return result;
      } };
    const response = await createCase({ DB: local.db, PROOFS_BUCKET: bucket, AUTH_SECRET: local.authSecret, AUTH_ORIGIN: "https://voteproof.example" }, null,
      new Request("https://voteproof.example/api/cases", { method: "POST", headers: { ...member.headers, "Content-Type": "application/json" }, body: JSON.stringify(guestBody(reference)) }));
    await expectError(response, suspend ? 403 : 401, suspend ? "MEMBER_SUSPENDED" : "AUTH_REQUIRED");
    assert.equal((await local.bucket.list({ prefix: "proofs/cases/" })).objects.length, before);
  }
});
