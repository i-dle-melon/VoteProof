import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { localCaseRuntime, guestBody } from "../scripts/lib/local-case-runtime.mjs";
import { sha256, CASE_ID_PATTERN, QUERY_KEY_PATTERN } from "../src/lib/case-keys.js";
import worker from "../src/index.js";
import { createCase } from "../src/api/cases.js";

let local;
before(async () => { local = await localCaseRuntime(); });
after(async () => { await local?.runtime.dispose(); });

async function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const body = await response.json(); assert.equal(body.ok, false); assert.equal(body.error.code, code); return body;
}
async function create(reference, extra = {}) {
  const response = await local.fetch("/api/cases", "POST", { ...guestBody(reference), ...extra });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()).data;
}
const fakeKey = () => randomBytes(32).toString("base64url");
const get = (created, key = created.query_key) => local.fetch(`/api/cases/${created.case_id}?key=${key}`);

test("B3 migration creates required tables, guest indexes and one-use constraints", async () => {
  const tables = (await local.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map(row => row.name);
  for (const name of ["cases", "case_files", "completed_uploads", "completed_upload_files"]) assert.ok(tables.includes(name));
  const indexes = (await local.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()).results.map(row => row.name);
  for (const name of ["idx_cases_guest_lookup", "idx_cases_created_at", "idx_cases_status", "idx_cases_campaign_id"]) assert.ok(indexes.includes(name));
});

test("normal Guest case uses server ids, only a hashed query key, pending status and immutable private copies", async () => {
  const reference = await local.upload({ count: 2 });
  const created = await create(reference, { nickname: "  測試訪客  ", player_id: "  local-player  ", note: "  本機測試  " });
  assert.match(created.case_id, CASE_ID_PATTERN); assert.match(created.query_key, QUERY_KEY_PATTERN);
  assert.equal(Buffer.from(created.query_key, "base64url").length, 32);
  assert.deepEqual(Object.keys(created).sort(), ["case_id", "query_key", "status"]); assert.equal(created.status, "pending");
  const row = await local.db.prepare("SELECT * FROM cases WHERE case_id = ?").bind(created.case_id).first();
  assert.equal(row.query_key_hash, await sha256(created.query_key));
  assert.equal(JSON.stringify(row).includes(created.query_key), false);
  assert.equal(row.nickname, "測試訪客"); assert.equal(row.player_id, "local-player"); assert.equal(row.note, "本機測試");
  assert.equal(row.member_id, null); assert.equal(row.source, "guest"); assert.equal(row.status, "pending");
  assert.equal(row.points_awarded, 0); assert.equal(row.duplicate_flag, 0); assert.equal(row.reviewer_id, null);
  const files = (await local.db.prepare("SELECT * FROM case_files WHERE case_id = ?").bind(row.id).all()).results;
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.match(file.object_key, /^proofs\/cases\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
    assert.equal(file.original_name, null); assert.ok(file.etag);
    assert.deepEqual(new Uint8Array(await (await local.bucket.get(file.object_key)).arrayBuffer()), new Uint8Array([1, 2, 3]));
    assert.equal(await local.bucket.head(file.upload_object_key), null);
    // A valid, still-live staging PUT cannot overwrite the case's archived proof.
    await local.bucket.put(file.upload_object_key, "changed", { httpMetadata: { contentType: "image/png" } });
    assert.equal((await local.bucket.head(file.object_key)).size, 3);
  }
  assert.equal((await local.db.prepare("SELECT consumed_case_id FROM completed_uploads WHERE session_id = ?").bind(reference.session_id).first()).consumed_case_id, row.id);
});

test("case creation supports five B2 files and the official 團體 vote type", async () => {
  const created = await create(await local.upload({ count: 5 }), { vote_type: "團體", note: null });
  const data = (await (await get(created)).json()).data;
  assert.equal(data.files.length, 5); assert.equal(data.vote_type, "團體");
});

const invalidFields = [
  ["missing nickname", { nickname: undefined }], ["blank nickname", { nickname: "  " }],
  ["long nickname", { nickname: "長".repeat(51) }], ["missing player id", { player_id: undefined }],
  ["long player id", { player_id: "a".repeat(101) }], ["control character", { player_id: "a\u0000b" }],
  ["missing campaign", { campaign_id: undefined }], ["long campaign", { campaign_id: "A".repeat(101) }],
  ["invalid campaign format", { campaign_id: "../campaign" }], ["wrong vote type", { vote_type: "solo" }],
  ["invalid calendar date", { vote_date: "2026-02-30" }], ["non-ISO date", { vote_date: "2026/10/08" }],
  ["distant future date", { vote_date: "2199-01-01" }], ["implausible past date", { vote_date: "1999-12-31" }],
  ["long note", { note: "a".repeat(501) }], ["non-string note", { note: {} }],
  ["client approved status", { status: "approved" }], ["client case id", { case_id: "chosen" }],
  ["client points", { points_awarded: 100 }], ["client member identity", { member_id: "chosen" }],
  ["missing upload reference", { upload_session: undefined }], ["raw arbitrary object keys", { files: [{ key: "chosen" }] }],
];
for (const [name, fields] of invalidFields) test("case rejects " + name, async () => {
  await error(await local.fetch("/api/cases", "POST", { ...guestBody({ session_id: crypto.randomUUID(), keys: [] }), ...fields }), 400, "INVALID_CASE_REQUEST");
});

test("cases reject malformed JSON, wrong Content-Type, array bodies and oversized metadata", async () => {
  await error(await local.fetch("/api/cases", "POST", "{"), 400, "INVALID_JSON");
  await error(await local.fetch("/api/cases", "POST", "{}", { "Content-Type": "text/plain" }), 400, "INVALID_JSON");
  await error(await local.fetch("/api/cases", "POST", []), 400, "INVALID_CASE_REQUEST");
  await error(await local.fetch("/api/cases", "POST", " ".repeat(16 * 1024 + 1)), 413, "INVALID_CASE_REQUEST");
});

test("R2 existence without a successful persisted B2 complete cannot create a case", async () => {
  const reference = await local.upload({ completed: false });
  await error(await local.fetch("/api/cases", "POST", guestBody(reference)), 400, "UPLOAD_NOT_COMPLETED");
});

test("case rejects forged keys, traversal, other sessions and completed subsets", async () => {
  const reference = await local.upload({ count: 2 });
  for (const bad of [
    { ...reference, keys: ["../outside"] },
    { ...reference, keys: [reference.keys[0].replace(reference.session_id, crypto.randomUUID())] },
  ]) await error(await local.fetch("/api/cases", "POST", guestBody(bad)), 400, "INVALID_UPLOAD_REFERENCE");
  await error(await local.fetch("/api/cases", "POST", guestBody({ ...reference, keys: reference.keys.slice(0, 1) })), 400, "INVALID_UPLOAD_REFERENCE");
  const unknownKey = reference.keys[0].replace(/[^/]+\.png$/, crypto.randomUUID() + ".png");
  await error(await local.fetch("/api/cases", "POST", guestBody({ ...reference, keys: [unknownKey, reference.keys[1]] })), 400, "INVALID_UPLOAD_REFERENCE");
});

test("repeat complete is stable; changing the recorded completed manifest is rejected", async () => {
  const reference = await local.upload();
  assert.equal((await local.fetch("/api/uploads/complete", "POST", reference)).status, 200);
  await local.bucket.put(reference.keys[0], new Uint8Array([9, 8, 7]), { httpMetadata: { contentType: "image/png" } });
  await error(await local.fetch("/api/uploads/complete", "POST", reference), 409, "UPLOAD_SESSION_CONFLICT");
  await error(await local.fetch("/api/cases", "POST", guestBody(reference)), 409, "UPLOAD_CHANGED");
});

test("failed completion persistence never succeeds or leaves a partial completed session", async () => {
  const reference = await local.upload({ completed: false });
  await local.db.prepare("CREATE TRIGGER test_abort_completed_files BEFORE INSERT ON completed_upload_files BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
  try { await error(await local.fetch("/api/uploads/complete", "POST", reference), 500, "DATABASE_ERROR"); }
  finally { await local.db.prepare("DROP TRIGGER test_abort_completed_files").run(); }
  assert.equal(await local.db.prepare("SELECT session_id FROM completed_uploads WHERE session_id = ?").bind(reference.session_id).first(), null);
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM completed_upload_files WHERE session_id = ?").bind(reference.session_id).first()).n, 0);
  assert.equal((await local.fetch("/api/uploads/complete", "POST", reference)).status, 200);
});

test("actual oversize or wrong MIME after complete is rejected and deleted at case creation", async () => {
  for (const [body, type] of [[new Uint8Array(5 * 1024 * 1024 + 1), "image/png"], ["invalid", "image/svg+xml"]]) {
    const reference = await local.upload();
    await local.bucket.put(reference.keys[0], body, { httpMetadata: { contentType: type } });
    await error(await local.fetch("/api/cases", "POST", guestBody(reference)), 400, "UPLOAD_VALIDATION_FAILED");
    assert.equal(await local.bucket.head(reference.keys[0]), null);
    assert.equal((await local.db.prepare("SELECT consumed_case_id FROM completed_uploads WHERE session_id = ?").bind(reference.session_id).first()).consumed_case_id, null);
  }
});

test("completed but subsequently missing object cannot create a case", async () => {
  const reference = await local.upload(); await local.bucket.delete(reference.keys[0]);
  await error(await local.fetch("/api/cases", "POST", guestBody(reference)), 400, "UPLOAD_INCOMPLETE");
});

test("same completed upload cannot create another case, including changed payload and complete replay", async () => {
  const reference = await local.upload(); await create(reference);
  await error(await local.fetch("/api/cases", "POST", guestBody(reference)), 409, "UPLOAD_ALREADY_USED");
  await error(await local.fetch("/api/cases", "POST", { ...guestBody(reference), nickname: "另一位" }), 409, "UPLOAD_ALREADY_USED");
  await local.bucket.put(reference.keys[0], new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
  await error(await local.fetch("/api/uploads/complete", "POST", reference), 409, "UPLOAD_ALREADY_USED");
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM cases WHERE upload_session_id = ?").bind(reference.session_id).first()).n, 1);
});

test("simultaneous submissions atomically create exactly one case and discard losing private copies", async () => {
  const reference = await local.upload();
  const before = (await local.bucket.list({ prefix: "proofs/cases/" })).objects.length;
  const responses = await Promise.all(Array.from({ length: 4 }, () => local.fetch("/api/cases", "POST", guestBody(reference))));
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409, 409, 409]);
  const rows = (await local.db.prepare("SELECT id FROM cases WHERE upload_session_id = ?").bind(reference.session_id).all()).results;
  assert.equal(rows.length, 1);
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM case_files WHERE upload_object_key = ?").bind(reference.keys[0]).first()).n, 1);
  const stored = (await local.db.prepare("SELECT object_key FROM case_files WHERE case_id = ?").bind(rows[0].id).all()).results;
  assert.equal((await local.bucket.head(stored[0].object_key)).size, 3);
  assert.equal((await local.bucket.list({ prefix: "proofs/cases/" })).objects.length, before + 1);
});

test("a partially failed R2 archive leaves no case, no consumption and no abandoned private copies", async () => {
  const reference = await local.upload({ count: 2 });
  const before = (await local.bucket.list({ prefix: "proofs/cases/" })).objects.length;
  let puts = 0;
  const bucket = { get: (...args) => local.bucket.get(...args), delete: (...args) => local.bucket.delete(...args),
    put: (...args) => ++puts === 2 ? Promise.reject(new Error("Unavailable")) : local.bucket.put(...args) };
  const response = await createCase({ DB: local.db, PROOFS_BUCKET: bucket }, null,
    new Request("https://voteproof.example/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(guestBody(reference)) }));
  await error(response, 500, "R2_STORAGE_ERROR");
  assert.equal((await local.bucket.list({ prefix: "proofs/cases/" })).objects.length, before);
  assert.equal((await local.db.prepare("SELECT consumed_case_id FROM completed_uploads WHERE session_id = ?").bind(reference.session_id).first()).consumed_case_id, null);
  await create(reference);
});

test("actual D1 batch failure rolls back case, files and consumption; private copies are cleaned", async () => {
  const reference = await local.upload();
  const before = (await local.bucket.list({ prefix: "proofs/cases/" })).objects.length;
  await local.db.prepare("CREATE TRIGGER test_abort_case_files BEFORE INSERT ON case_files BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
  try { await error(await local.fetch("/api/cases", "POST", guestBody(reference)), 500, "DATABASE_ERROR"); }
  finally { await local.db.prepare("DROP TRIGGER test_abort_case_files").run(); }
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM cases WHERE upload_session_id = ?").bind(reference.session_id).first()).n, 0);
  assert.equal((await local.db.prepare("SELECT consumed_case_id FROM completed_uploads WHERE session_id = ?").bind(reference.session_id).first()).consumed_case_id, null);
  assert.equal((await local.bucket.list({ prefix: "proofs/cases/" })).objects.length, before);
  assert.ok(await local.bucket.head(reference.keys[0]));
  await create(reference); // The fully rolled-back operation can be retried.
});

test("a lost D1 acknowledgement does not delete committed proof files", async () => {
  const reference = await local.upload();
  const db = { prepare: sql => local.db.prepare(sql), batch: async statements => { await local.db.batch(statements); throw new Error("Lost acknowledgement"); } };
  const response = await createCase({ DB: db, PROOFS_BUCKET: local.bucket }, null,
    new Request("https://voteproof.example/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(guestBody(reference)) }));
  assert.equal(response.status, 201);
  const created = (await response.json()).data;
  const row = await local.db.prepare("SELECT id FROM cases WHERE case_id = ?").bind(created.case_id).first();
  const file = await local.db.prepare("SELECT object_key FROM case_files WHERE case_id = ?").bind(row.id).first();
  assert.ok(await local.bucket.head(file.object_key));
});

test("unverifiable D1 acknowledgement preserves possibly committed case files", async () => {
  const reference = await local.upload();
  let offline = false;
  const db = { prepare: sql => { if (offline) throw new Error("Offline"); return local.db.prepare(sql); },
    batch: async statements => { await local.db.batch(statements); offline = true; throw new Error("Lost acknowledgement"); } };
  const response = await createCase({ DB: db, PROOFS_BUCKET: local.bucket }, null,
    new Request("https://voteproof.example/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(guestBody(reference)) }));
  await error(response, 500, "DATABASE_ERROR");
  const row = await local.db.prepare("SELECT id FROM cases WHERE upload_session_id = ?").bind(reference.session_id).first();
  assert.ok(row);
  const file = await local.db.prepare("SELECT object_key FROM case_files WHERE case_id = ?").bind(row.id).first();
  assert.ok(await local.bucket.head(file.object_key));
});

test("Idempotency-Key creates a case and replays the same successful response", async () => {
  const reference = await local.upload();
  const headers = { "Idempotency-Key": crypto.randomUUID() };
  const first = await local.fetch("/api/cases", "POST", guestBody(reference), headers);
  assert.equal(first.status, 201);
  const replay = await local.fetch("/api/cases", "POST", guestBody(reference), headers);
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), await first.json());
});

test("Guest lookup whitelists fields, excludes private metadata and supports safer header authentication", async () => {
  const created = await create(await local.upload(), { note: "private note" });
  const response = await get(created); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload.data).sort(), ["case_id", "created_at", "nickname", "campaign_id", "vote_type", "vote_date", "status", "points_awarded", "files"].sort());
  assert.deepEqual(payload.data.files, [{ content_type: "image/png", size: 3 }]);
  const text = JSON.stringify(payload);
  for (const name of ["query_key", "query_key_hash", "object_key", "player_id", "reviewer_id", "member_id", "note", "etag", "http", "proofs/"]) assert.equal(text.includes(name), false);
  const headerResponse = await local.fetch(`/api/cases/${created.case_id}`, "GET", undefined, { "X-Case-Query-Key": created.query_key });
  assert.equal(headerResponse.status, 200);
});

test("wrong key, missing key and nonexistent case have exactly the same 404 JSON", async () => {
  const created = await create(await local.upload());
  const wrong = await error(await get(created, fakeKey()), 404, "CASE_NOT_FOUND");
  assert.deepEqual(await error(await local.fetch(`/api/cases/${created.case_id}`), 404, "CASE_NOT_FOUND"), wrong);
  const nonexistent = created.case_id.slice(0, 12) + "A".repeat(16);
  assert.deepEqual(await error(await local.fetch(`/api/cases/${nonexistent}?key=${created.query_key}`), 404, "CASE_NOT_FOUND"), wrong);
  assert.deepEqual(await error(await get(created, "short"), 404, "CASE_NOT_FOUND"), wrong);
  await error(await local.fetch(`/api/cases/${created.case_id}?key=${created.query_key}&key=${created.query_key}`), 404, "CASE_NOT_FOUND");
  await error(await local.fetch(`/api/cases/${created.case_id}?key=${created.query_key}`, "GET", undefined, { "X-Case-Query-Key": fakeKey() }), 404, "CASE_NOT_FOUND");
});

test("Cases methods and unknown nested API routes preserve 405/404 behavior", async () => {
  const created = await create(await local.upload());
  const collection = await local.fetch("/api/cases"); assert.equal(collection.headers.get("allow"), "POST");
  await error(collection, 405, "METHOD_NOT_ALLOWED");
  const item = await local.fetch(`/api/cases/${created.case_id}`, "POST", {}); assert.equal(item.headers.get("allow"), "GET");
  await error(item, 405, "METHOD_NOT_ALLOWED");
  await error(await local.fetch(`/api/cases/${created.case_id}/download`), 404, "NOT_FOUND");
  await error(await local.fetch("/api/unknown"), 404, "NOT_FOUND");
});

test("missing D1 and storage failures are sanitized; no request/env data leaks", async () => {
  const reference = await local.upload();
  const req = () => new Request("https://voteproof.example/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(guestBody(reference)) });
  await error(await worker.fetch(req(), {}), 503, "DB_NOT_CONFIGURED");
  const secret = randomBytes(32).toString("hex");
  const badDb = { prepare() { throw new Error(secret); }, batch() {} };
  const payload = await error(await worker.fetch(req(), { DB: badDb }), 500, "DATABASE_ERROR");
  assert.equal(JSON.stringify(payload).includes(secret), false);
});
