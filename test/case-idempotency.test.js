import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { localCaseRuntime, guestBody } from "../scripts/lib/local-case-runtime.mjs";
import { createCase } from "../src/api/cases.js";
import { sha256 } from "../src/lib/case-keys.js";
import { COMPLETED_UPLOAD_TTL_SECONDS } from "../src/lib/completed-uploads.js";
import { cleanPrivateCopies } from "../src/lib/case-files.js";

let local;
before(async () => { local = await localCaseRuntime(); });
after(async () => { await local?.runtime.dispose(); });
const headers = key => ({ "Idempotency-Key": key });
const submit = (body, key) => local.fetch("/api/cases", "POST", body, headers(key));
const key = () => crypto.randomUUID();
const count = async (table, session) => (await local.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE upload_session_id = ?`).bind(session).first()).n;
async function success(response) {
  assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json(); assert.equal(body.ok, true); return body;
}
async function failure(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["ok", "error"]); assert.equal(body.ok, false);
  assert.equal(body.error.code, code); assert.deepEqual(Object.keys(body.error), ["code", "message"]);
  return body;
}
const request = (body, token) => new Request("https://voteproof.example/api/cases", {
  method: "POST", headers: { "Content-Type": "application/json", ...(token === undefined ? {} : headers(token)) }, body: JSON.stringify(body),
});

test("first idempotent creation persists hashes and random seed, never either raw credential", async () => {
  const reference = await local.upload(), token = key();
  const created = await success(await submit(guestBody(reference), token));
  const row = await local.db.prepare("SELECT * FROM cases WHERE case_id = ?").bind(created.data.case_id).first();
  const stored = await local.db.prepare("SELECT * FROM case_idempotency WHERE case_id = ?").bind(row.id).first();
  assert.equal(stored.key_hash, await sha256("VoteProof/case-idempotency/v1:" + token));
  assert.match(stored.request_hash, /^[a-f0-9]{64}$/); assert.match(stored.query_seed, /^[a-f0-9]{64}$/);
  assert.equal(row.query_key_hash, await sha256(created.data.query_key));
  for (const value of [token, created.data.query_key]) assert.equal(JSON.stringify([row, stored]).includes(value), false);
  assert.equal(Buffer.from(created.data.query_key, "base64url").length, 32);
});

test("replay recovers the identical effective credential after staging deletion and status changes", async () => {
  const reference = await local.upload(), body = guestBody(reference), token = key();
  const first = await success(await submit(body, token));
  assert.equal(await local.bucket.head(reference.keys[0]), null);
  await local.db.prepare("UPDATE cases SET status = 'approved' WHERE case_id = ?").bind(first.data.case_id).run();
  const replay = await success(await submit(body, token));
  assert.deepEqual(replay, first);
  const lookup = await local.fetch(`/api/cases/${replay.data.case_id}`, "GET", undefined, { "X-Case-Query-Key": replay.data.query_key });
  assert.equal(lookup.status, 200); assert.equal((await lookup.json()).data.status, "approved");
  assert.equal(await count("cases", reference.session_id), 1);
});

test("normalized whitespace, null notes, JSON property order and file order share one response", async () => {
  const reference = await local.upload({ count: 2 }), token = key();
  const first = await success(await submit({ ...guestBody(reference), nickname: "  測試訪客  ", note: "  " }, token));
  const body = guestBody({ ...reference, keys: [...reference.keys].reverse() });
  const replay = await success(await submit(Object.fromEntries(Object.entries({ ...body, note: null }).reverse()), token));
  assert.deepEqual(replay, first);
});

test("same key with any changed normalized case field or upload is a conflict", async () => {
  const reference = await local.upload(), token = key(), body = guestBody(reference);
  await success(await submit(body, token));
  const other = await local.upload();
  for (const fields of [{ nickname: "Changed" }, { player_id: "Changed" }, { campaign_id: "CHANGED" },
    { vote_type: "團體" }, { vote_date: "2000-01-01" }, { note: "changed" }, { upload_session: other }]) {
    await failure(await submit({ ...body, ...fields }, token), 409, "IDEMPOTENCY_CONFLICT");
  }
  assert.equal(await count("cases", other.session_id), 0);
});

for (const [name, value] of [["empty", ""], ["short", "a".repeat(15)], ["long", "a".repeat(129)],
  ["spaces", "abcdefghijklmnop qr"], ["punctuation", "abcdefghijklmnop/qr"], ["combined headers", "abcdefghijklmnop,qrstuvwxyz123456"]]) {
  test("Idempotency-Key rejects " + name, async () => {
    const reference = await local.upload();
    // The HTTP harness strips an empty header. Exercise that raw Request directly.
    const response = value === "" ? await createCase({}, null, request(guestBody(reference), value)) : await submit(guestBody(reference), value);
    await failure(response, 400, "INVALID_IDEMPOTENCY_KEY");
    assert.equal(await count("cases", reference.session_id), 0);
  });
}

test("Idempotency-Key accepts its documented length boundaries", async () => {
  for (const length of [16, 128]) await success(await submit(guestBody(await local.upload()), randomBytes(length / 2).toString("hex")));
});

test("missing or invalid dedicated Secret fails closed before copying or consuming", async () => {
  const reference = await local.upload(), body = guestBody(reference);
  for (const secret of [undefined, "", randomBytes(10).toString("hex")]) {
    await failure(await createCase({ DB: local.db, PROOFS_BUCKET: local.bucket, CASE_QUERY_KEY_SECRET: secret,
      TURNSTILE_SECRET_KEY: randomBytes(32).toString("hex"), R2_SECRET_ACCESS_KEY: randomBytes(32).toString("hex") }, null,
    request(body, key())), 503, "IDEMPOTENCY_NOT_CONFIGURED");
  }
  assert.equal(await count("cases", reference.session_id), 0);
});

test("concurrent identical requests all replay one case and leave only winning private copies", async () => {
  const reference = await local.upload({ count: 2 }), token = key(), body = guestBody(reference);
  const before = (await local.bucket.list({ prefix: "proofs/cases/" })).objects.length;
  const responses = await Promise.all(Array.from({ length: 4 }, () => submit(body, token)));
  const values = await Promise.all(responses.map(success));
  for (const value of values) assert.deepEqual(value, values[0]);
  assert.equal(await count("cases", reference.session_id), 1);
  assert.equal((await local.bucket.list({ prefix: "proofs/cases/" })).objects.length, before + 2);
});

test("concurrent same key and different sessions creates one winner and one conflict", async () => {
  const refs = [await local.upload(), await local.upload()], token = key();
  const before = (await local.bucket.list({ prefix: "proofs/cases/" })).objects.length;
  const responses = await Promise.all(refs.map(ref => submit(guestBody(ref), token)));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  await failure(responses.find(response => response.status === 409), 409, "IDEMPOTENCY_CONFLICT");
  assert.equal(await count("cases", refs[0].session_id) + await count("cases", refs[1].session_id), 1);
  assert.equal((await local.bucket.list({ prefix: "proofs/cases/" })).objects.length, before + 1);
});

test("another Idempotency-Key cannot consume an already used upload", async () => {
  const reference = await local.upload(), body = guestBody(reference);
  await success(await submit(body, key()));
  await failure(await submit(body, key()), 409, "UPLOAD_ALREADY_USED");
  assert.equal(await count("cases", reference.session_id), 1);
});

test("D1 failure after copies rolls back idempotency, all case files and consumption and cleans copies", async () => {
  const reference = await local.upload({ count: 2 }), token = key(), body = guestBody(reference);
  const before = (await local.bucket.list({ prefix: "proofs/cases/" })).objects.length;
  await local.db.prepare("CREATE TRIGGER abort_idempotency BEFORE INSERT ON case_idempotency BEGIN SELECT RAISE(ABORT, 'failure'); END").run();
  try { await failure(await submit(body, token), 500, "DATABASE_ERROR"); }
  finally { await local.db.prepare("DROP TRIGGER abort_idempotency").run(); }
  assert.equal(await count("cases", reference.session_id), 0);
  assert.equal(await local.db.prepare("SELECT case_id FROM case_idempotency WHERE key_hash = ?")
    .bind(await sha256("VoteProof/case-idempotency/v1:" + token)).first(), null);
  assert.equal((await local.db.prepare("SELECT count(*) AS n FROM case_files WHERE upload_object_key IN (?, ?)")
    .bind(...reference.keys).first()).n, 0);
  assert.equal((await local.db.prepare("SELECT consumed_case_id FROM completed_uploads WHERE session_id = ?").bind(reference.session_id).first()).consumed_case_id, null);
  assert.equal((await local.bucket.list({ prefix: "proofs/cases/" })).objects.length, before);
  await success(await submit(body, token));
});

test("second copy failure attempts all request deletes even when the first delete fails", async () => {
  const reference = await local.upload({ count: 2 }), attempted = [], emitted = [], sensitive = randomBytes(24).toString("hex");
  let puts = 0;
  const bucket = { get: (...args) => local.bucket.get(...args),
    put: (...args) => ++puts === 2 ? Promise.reject(new Error(sensitive)) : local.bucket.put(...args),
    delete: async objectKey => { attempted.push(objectKey); if (attempted.length === 1) throw new Error(sensitive + objectKey); await local.bucket.delete(objectKey); } };
  const warn = console.warn; console.warn = (...args) => emitted.push(args);
  let payload;
  try { payload = await failure(await createCase({ DB: local.db, PROOFS_BUCKET: bucket }, null,
    request(guestBody(reference))), 500, "R2_STORAGE_ERROR"); }
  finally { console.warn = warn; }
  assert.equal(attempted.length, 2);
  assert.deepEqual(emitted, [["VoteProof object cleanup incomplete", { failed_count: 1 }]]);
  const safe = JSON.stringify([payload, emitted]);
  assert.equal(safe.includes(sensitive), false);
  for (const objectKey of attempted) assert.equal(safe.includes(objectKey), false);
  assert.equal(await count("cases", reference.session_id), 0);
  // Clean the deliberately failed test delete; no fixture orphan remains.
  for (const objectKey of attempted) await local.bucket.delete(objectKey);
});

test("even a failed logger cannot turn best-effort cleanup into an API failure", async () => {
  const warn = console.warn; console.warn = () => { throw new Error("logger failure"); };
  try { await cleanPrivateCopies({ delete: async () => { throw new Error("delete failure"); } }, ["local-test-object"]); }
  finally { console.warn = warn; }
});

test("completed sessions have a fixed 24 hour lifetime which repeat complete cannot refresh", async () => {
  const reference = await local.upload();
  const first = await local.db.prepare("SELECT completed_at, expires_at FROM completed_uploads WHERE session_id = ?").bind(reference.session_id).first();
  assert.equal(Date.parse(first.expires_at) - Date.parse(first.completed_at), COMPLETED_UPLOAD_TTL_SECONDS * 1000);
  assert.equal((await local.fetch("/api/uploads/complete", "POST", reference)).status, 200);
  assert.deepEqual(await local.db.prepare("SELECT completed_at, expires_at FROM completed_uploads WHERE session_id = ?").bind(reference.session_id).first(), first);
});

test("stale unconsumed session rejects creation and repeat complete without refreshing TTL", async () => {
  const reference = await local.upload();
  await local.db.prepare("UPDATE completed_uploads SET expires_at = ? WHERE session_id = ?")
    .bind("2000-01-01T00:00:00.000Z", reference.session_id).run();
  await failure(await submit(guestBody(reference), key()), 409, "UPLOAD_SESSION_EXPIRED");
  await failure(await local.fetch("/api/uploads/complete", "POST", reference), 409, "UPLOAD_SESSION_EXPIRED");
  assert.equal(await count("cases", reference.session_id), 0);
});

test("successful idempotency replay survives completed-upload expiry", async () => {
  const reference = await local.upload(), body = guestBody(reference), token = key();
  const first = await success(await submit(body, token));
  await local.db.prepare("UPDATE completed_uploads SET expires_at = ? WHERE session_id = ?")
    .bind("2000-01-01T00:00:00.000Z", reference.session_id).run();
  assert.deepEqual(await success(await submit(body, token)), first);
});

test("migration constraints reject duplicate idempotency hashes and duplicate case associations", async () => {
  const reference = await local.upload(), created = await success(await submit(guestBody(reference), key()));
  const stored = await local.db.prepare("SELECT i.* FROM case_idempotency i JOIN cases c ON c.id = i.case_id WHERE c.case_id = ?")
    .bind(created.data.case_id).first();
  await assert.rejects(local.db.prepare("INSERT INTO case_idempotency VALUES (?, ?, ?, ?, ?)")
    .bind(stored.key_hash, stored.request_hash, stored.case_id, stored.query_seed, stored.created_at).run());
  await assert.rejects(local.db.prepare("INSERT INTO case_idempotency VALUES (?, ?, ?, ?, ?)")
    .bind(randomBytes(32).toString("hex"), stored.request_hash, stored.case_id, stored.query_seed, stored.created_at).run());
});

test("Worker restart retains persistent replay; changing the dedicated Secret fails closed", async () => {
  const reference = await local.upload(), token = key(), body = guestBody(reference);
  const first = await success(await submit(body, token));
  const secret = local.querySecret;
  try {
    await local.setQuerySecret(secret); // Restart workerd; only D1 holds replay state.
    assert.deepEqual(await success(await submit(body, token)), first);
    await local.setQuerySecret(randomBytes(32).toString("hex"));
    const denied = await failure(await submit(body, token), 503, "IDEMPOTENCY_NOT_CONFIGURED");
    assert.equal(JSON.stringify(denied).includes(first.data.query_key), false);
    await local.setQuerySecret(secret);
    assert.deepEqual(await success(await submit(body, token)), first);
  } finally { await local.setQuerySecret(secret); }
});

test("a session expiring during R2 copying cannot be consumed by the atomic batch", async () => {
  const reference = await local.upload();
  const before = (await local.bucket.list({ prefix: "proofs/cases/" })).objects.length;
  const bucket = { get: (...args) => local.bucket.get(...args), delete: (...args) => local.bucket.delete(...args),
    put: async (...args) => {
      const copy = await local.bucket.put(...args);
      await local.db.prepare("UPDATE completed_uploads SET expires_at = ? WHERE session_id = ?")
        .bind("2000-01-01T00:00:00.000Z", reference.session_id).run();
      return copy;
    } };
  await failure(await createCase({ DB: local.db, PROOFS_BUCKET: bucket }, null, request(guestBody(reference))), 409, "UPLOAD_SESSION_EXPIRED");
  assert.equal(await count("cases", reference.session_id), 0);
  assert.equal((await local.bucket.list({ prefix: "proofs/cases/" })).objects.length, before);
});

test("lost D1 acknowledgement still returns a recoverable persistent idempotent response", async () => {
  const reference = await local.upload(), token = key(), body = guestBody(reference);
  const db = { prepare: sql => local.db.prepare(sql), batch: async statements => {
    await local.db.batch(statements); throw new Error("Acknowledgement lost");
  } };
  const first = await success(await createCase({ DB: db, PROOFS_BUCKET: local.bucket,
    CASE_QUERY_KEY_SECRET: local.querySecret }, null, request(body, token)));
  assert.deepEqual(await success(await submit(body, token)), first);
});

test("unknown commit acknowledgement preserves proofs and normal retry recovers query credential", async () => {
  const reference = await local.upload(), token = key(), body = guestBody(reference);
  let unavailable = false;
  const db = { prepare: sql => { if (unavailable) throw new Error("Database offline"); return local.db.prepare(sql); },
    batch: async statements => { await local.db.batch(statements); unavailable = true; throw new Error("Acknowledgement lost"); } };
  await failure(await createCase({ DB: db, PROOFS_BUCKET: local.bucket, CASE_QUERY_KEY_SECRET: local.querySecret }, null,
    request(body, token)), 500, "DATABASE_ERROR");
  const replay = await success(await submit(body, token));
  assert.equal((await local.fetch(`/api/cases/${replay.data.case_id}`, "GET", undefined,
    { "X-Case-Query-Key": replay.data.query_key })).status, 200);
  const file = await local.db.prepare("SELECT object_key FROM case_files WHERE case_id = (SELECT id FROM cases WHERE case_id = ?)")
    .bind(replay.data.case_id).first();
  assert.ok(await local.bucket.head(file.object_key));
});

test("D1 rejection with cleanup failures preserves the database error and logs no private metadata", async () => {
  const reference = await local.upload({ count: 2 }), attempted = [], logs = [], privateError = randomBytes(32).toString("hex");
  const db = { prepare: sql => local.db.prepare(sql), batch: async () => { throw new Error(privateError); } };
  const bucket = { get: (...args) => local.bucket.get(...args), put: (...args) => local.bucket.put(...args),
    delete: async objectKey => { attempted.push(objectKey); throw new Error(privateError + objectKey); } };
  const warn = console.warn; console.warn = (...args) => logs.push(args);
  let payload;
  try { payload = await failure(await createCase({ DB: db, PROOFS_BUCKET: bucket }, null,
    request(guestBody(reference))), 500, "DATABASE_ERROR"); }
  finally { console.warn = warn; }
  assert.equal(attempted.length, 2);
  assert.deepEqual(logs, [["VoteProof object cleanup incomplete", { failed_count: 2 }]]);
  const serialized = JSON.stringify([payload, logs]);
  for (const value of [privateError, ...attempted]) assert.equal(serialized.includes(value), false);
  assert.equal(await count("cases", reference.session_id), 0);
  for (const objectKey of attempted) await local.bucket.delete(objectKey);
});
