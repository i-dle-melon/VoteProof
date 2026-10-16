import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";
import { createDirectCase } from "../src/api/cases.js";
import { putUpload } from "../src/api/uploads.js";
import { cleanupFinalUploads } from "../src/lib/immutable-uploads.js";
import { manifestCSV, entryFilename } from "../public/js/export-format.js";
import { ZipStore } from "../public/js/zip-store.js";
import worker from "../src/index.js";

crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const origin = "https://voteproof.example",
  bytes = new Uint8Array([1, 2, 3]),
  sha = (b) => createHash("sha256").update(b).digest("hex");
let h, l, member, admin;
before(async () => {
  h = await localAdminRuntime({ directIntent: true });
  l = h.local;
  member = await h.identity();
  admin = await h.identity({ role: "admin" });
  await l.campaign({ campaign_id: "DIRECT-POINTS", points_per_proof: 10, daily_limit: null });
  await l.setAuthConfig({
    GOOGLE_DRIVE_BACKUP_ENABLED: "true",
    DRIVE_BACKUP_RELAY_SECRET: "a".repeat(64),
  });
});
after(async () => {
  await l?.runtime.dispose();
});
const headers = (actor) => ({ Origin: origin, ...actor?.headers });
const env = () => ({ ...l.authConfig, DB: l.db, PROOFS_BUCKET: l.bucket });
async function data(r, status = 200) {
  const v = await r.json();
  assert.equal(r.status, status, JSON.stringify(v));
  return v.data;
}
const reference = (p) => ({
  session_id: p.session_id,
  keys: [p.uploads[0].key],
  ...(p.capability ? { capability: p.capability } : {}),
});
const body = (p, extra = {}) => ({
  campaign_id: "DIRECT-POINTS",
  vote_date: new Date().toISOString().slice(0, 10),
  upload_session: reference(p),
  ...extra,
});
async function prepared(actor, extra = {}) {
  return data(
    await l.fetch(
      "/api/uploads/prepare",
      "POST",
      {
        storage_version: 2,
        completion_mode: "direct",
        campaign_id: "DIRECT-POINTS",
        turnstile_token: "synthetic",
        files: [
          { name: "x.png", type: "image/png", size: 3, algorithm: "sha256", sha256: sha(bytes) },
        ],
        ...extra,
      },
      headers(actor),
    ),
  );
}
async function uploaded(actor, extra) {
  const p = await prepared(actor, extra);
  await l.put(p.uploads[0], bytes, headers(actor));
  return p;
}
const create = (p, actor, key = randomUUID(), extra = {}) =>
  l.fetch("/api/cases/direct", "POST", body(p, extra), {
    ...headers(actor),
    "Idempotency-Key": key,
  });
const direct = (p, e, actor, key = randomUUID()) =>
  createDirectCase(
    e,
    null,
    new Request(origin + "/api/cases/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers(actor), "Idempotency-Key": key },
      body: JSON.stringify(body(p)),
    }),
  );
async function cleanRows(p) {
  return l.db
    .prepare(
      `SELECT
 (SELECT count(*) FROM cases WHERE upload_intent_id=?) cases,
 (SELECT count(*) FROM case_files WHERE upload_intent_id=?) files,
 (SELECT count(*) FROM completed_uploads WHERE session_id=?) completed,
 (SELECT count(*) FROM completed_upload_files WHERE session_id=?) snapshots,
 (SELECT count(*) FROM proof_upload_checksums WHERE object_key=?) checksums,
 (SELECT count(*) FROM proof_exact_hashes WHERE file_id=?) hashes,
 (SELECT count(*) FROM proof_duplicate_jobs WHERE file_id=?) jobs,
 (SELECT count(*) FROM proof_duplicate_requests r JOIN proof_duplicate_jobs j USING(file_id) WHERE j.file_id=?) requests,
 (SELECT count(*) FROM proof_duplicate_groups WHERE canonical_file_id=?) groups`,
    )
    .bind(
      p.session_id,
      p.session_id,
      p.session_id,
      p.session_id,
      p.uploads[0].key,
      p.proof_id,
      p.proof_id,
      p.proof_id,
      p.proof_id,
    )
    .first();
}
async function untouched(p) {
  const r = await cleanRows(p);
  assert.equal(r.cases, 0);
  assert.equal(r.files, 0);
  assert.equal(
    (
      await l.db
        .prepare("SELECT consumed_case_id FROM proof_upload_intents WHERE session_id=?")
        .bind(p.session_id)
        .first()
    ).consumed_case_id,
    null,
  );
}

for (const kind of ["member", "guest"])
  test(`${kind}: Prepare -> PUT -> Case without Complete or intermediate/evidence rows`, async () => {
    const actor = kind === "member" ? member : undefined,
      p = await uploaded(actor);
    const intent = await l.db
      .prepare("SELECT * FROM proof_upload_intents WHERE session_id=?")
      .bind(p.session_id)
      .first();
    assert.equal(intent.state, "prepared");
    assert.equal(intent.uploaded_at, null);
    assert.equal(intent.sealed_at, null);
    assert.equal(intent.write_token, null);
    assert.equal(intent.completion_mode, "direct");
    const result = await data(await create(p, actor), 201);
    assert.equal(result.status, "pending");
    assert.deepEqual(await cleanRows(p), {
      cases: 1,
      files: 1,
      completed: 0,
      snapshots: 0,
      checksums: 0,
      hashes: 0,
      jobs: 0,
      requests: 0,
      groups: 0,
    });
    const c = await l.db
      .prepare("SELECT * FROM cases WHERE case_id=?")
      .bind(result.case_id)
      .first();
    assert.equal(c.upload_session_id, null);
    assert.equal(c.upload_intent_id, p.session_id);
    assert.equal(c.member_id, actor?.memberId ?? null);
    assert.equal(c.vote_type, "Solo");
    if (!actor) {
      assert.equal(c.nickname, "匿名投稿");
      assert.equal(c.player_id, "匿名投稿");
    }
    assert.equal(
      (
        await l.db
          .prepare("SELECT state FROM proof_upload_intents WHERE session_id=?")
          .bind(p.session_id)
          .first()
      ).state,
      "consumed",
    );
    assert.equal(
      (
        await l.db
          .prepare("SELECT count(*) n FROM proof_backups WHERE file_id=?")
          .bind(p.proof_id)
          .first()
      ).n,
      1,
    );
    assert.equal(
      (
        await l.db
          .prepare("SELECT count(*) n FROM point_transactions WHERE case_id=?")
          .bind(c.id)
          .first()
      ).n,
      0,
    );
    assert.equal(
      (
        await l.fetch("/api/cases/" + result.case_id, "GET", undefined, {
          "X-Case-Query-Key": result.query_key,
        })
      ).status,
      200,
    );
    if (actor)
      assert.equal(
        (await l.fetch("/api/me/cases/" + result.case_id, "GET", undefined, actor.headers)).status,
        200,
      );
  });
test("issuance defaults OFF and cannot silently fall back to legacy", async () => {
  await l.setAuthConfig({ DIRECT_INTENT_CASE_ENABLED: undefined });
  try {
    const r = await l.fetch(
      "/api/uploads/prepare",
      "POST",
      {
        storage_version: 2,
        completion_mode: "direct",
        campaign_id: "DIRECT-POINTS",
        turnstile_token: "synthetic",
        files: [
          { name: "x.png", type: "image/png", size: 3, algorithm: "sha256", sha256: sha(bytes) },
        ],
      },
      headers(),
    );
    assert.equal(r.status, 503);
  } finally {
    await l.setAuthConfig({ DIRECT_INTENT_CASE_ENABLED: "true" });
  }
});
test("issuance OFF still drains existing direct intents", async () => {
  const p = await uploaded();
  await l.setAuthConfig({ DIRECT_INTENT_CASE_ENABLED: undefined });
  try {
    await data(await create(p), 201);
  } finally {
    await l.setAuthConfig({ DIRECT_INTENT_CASE_ENABLED: "true" });
  }
});
test("direct intent cannot be converted into a Complete snapshot or legacy Case", async () => {
  const p = await uploaded();
  assert.equal(
    (await l.fetch("/api/uploads/complete", "POST", reference(p), headers())).status,
    409,
  );
  assert.equal(
    (
      await l.fetch("/api/cases", "POST", body(p), {
        ...headers(),
        "Idempotency-Key": randomUUID(),
      })
    ).status,
    400,
  );
  await untouched(p);
});
test("direct endpoint refuses legacy V2 intents", async () => {
  const p = await prepared(undefined, { completion_mode: undefined });
  await l.put(p.uploads[0], bytes);
  assert.equal((await create(p)).status, 409);
  await untouched(p);
});
test("missing object refuses consumption", async () => {
  const p = await prepared();
  assert.equal((await create(p)).status, 400);
  await untouched(p);
});
for (const [name, object] of [
  [
    "size",
    {
      size: 4,
      httpMetadata: { contentType: "image/png" },
      checksums: { sha256: Buffer.from(sha(bytes), "hex").buffer },
      etag: "etag",
    },
  ],
  [
    "MIME",
    {
      size: 3,
      httpMetadata: { contentType: "image/jpeg" },
      checksums: { sha256: new Uint8Array(Buffer.from(sha(bytes), "hex")).buffer },
      etag: "etag",
    },
  ],
  [
    "checksum",
    {
      size: 3,
      httpMetadata: { contentType: "image/png" },
      checksums: { sha256: new Uint8Array(32).buffer },
      etag: "etag",
    },
  ],
  [
    "missing checksum",
    { size: 3, httpMetadata: { contentType: "image/png" }, checksums: {}, etag: "etag" },
  ],
  [
    "missing ETag",
    {
      size: 3,
      httpMetadata: { contentType: "image/png" },
      checksums: { sha256: new Uint8Array(Buffer.from(sha(bytes), "hex")).buffer },
      etag: "",
    },
  ],
])
  test(`HEAD ${name} mismatch fails closed without reading bytes`, async () => {
    const p = await uploaded(),
      e = env();
    e.PROOFS_BUCKET = {
      head: async () => object,
      get: () => assert.fail("No GET"),
      put: () => assert.fail("No PUT"),
    };
    assert.equal((await direct(p, e)).status, 409);
    await untouched(p);
  });
test("wrong key, Campaign, owner and absent/wrong guest capability cannot claim proof", async () => {
  const p = await uploaded(),
    other = await h.identity();
  await l.campaign({ campaign_id: "DIRECT-OTHER" });
  for (const [actor, extra] of [
    [other, {}],
    [undefined, { campaign_id: "DIRECT-OTHER" }],
    [undefined, { upload_session: { ...reference(p), capability: "a".repeat(43) } }],
    [undefined, { upload_session: { session_id: p.session_id, keys: [p.uploads[0].key] } }],
  ])
    assert.equal((await create(p, actor, randomUUID(), extra)).status, 403);
  assert.equal(
    (
      await create(p, undefined, randomUUID(), {
        upload_session: {
          ...reference(p),
          keys: [p.uploads[0].key.replace(p.proof_id, randomUUID())],
        },
      })
    ).status,
    409,
  );
  await untouched(p);
  const m = await uploaded(member);
  assert.equal((await create(m, other)).status, 403);
  assert.equal((await create(m)).status, 403);
  await untouched(m);
});
test("member fresh CSRF, Origin and active identity required", async () => {
  const p = await uploaded(member);
  for (const hh of [
    { ...member.headers, "X-CSRF-Token": "bad" },
    { ...member.headers, Origin: "https://evil.example" },
  ])
    assert.equal(
      (
        await l.fetch("/api/cases/direct", "POST", body(p), {
          ...hh,
          "Idempotency-Key": randomUUID(),
        })
      ).status,
      403,
    );
  const actor = await h.identity(),
    q = await uploaded(actor);
  await l.db
    .prepare("UPDATE members SET status='suspended' WHERE member_id=?")
    .bind(actor.memberId)
    .run();
  assert.equal((await create(q, actor)).status, 403);
  await untouched(q);
});
test("guest Origin required even for idempotent replay", async () => {
  const p = await uploaded(),
    key = randomUUID();
  await data(await create(p, undefined, key), 201);
  assert.equal(
    (await l.fetch("/api/cases/direct", "POST", body(p), { "Idempotency-Key": key })).status,
    403,
  );
});
test("fresh Gate OFF refuses Case", async () => {
  const p = await uploaded();
  await l.db.prepare("UPDATE submission_settings SET submissions_enabled=0 WHERE id=1").run();
  try {
    assert.equal((await create(p)).status, 503);
    await untouched(p);
  } finally {
    await l.db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
  }
});
test("Gate changes after HEAD still prevent the atomic insert", async () => {
  const p = await uploaded(),
    e = env();
  e.PROOFS_BUCKET = {
    head: async (key) => {
      const o = await l.bucket.head(key);
      await l.db.prepare("UPDATE submission_settings SET submissions_enabled=0 WHERE id=1").run();
      return o;
    },
  };
  try {
    assert.equal((await direct(p, e)).status, 503);
    await untouched(p);
  } finally {
    await l.db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
  }
});
test("Campaign version changes after HEAD prevent commit", async () => {
  const p = await uploaded(),
    e = env();
  e.PROOFS_BUCKET = {
    head: async (key) => {
      const o = await l.bucket.head(key);
      await l.db
        .prepare("UPDATE campaigns SET version=version+1 WHERE campaign_id='DIRECT-POINTS'")
        .run();
      return o;
    },
  };
  assert.equal((await direct(p, e)).status, 409);
  await untouched(p);
});
test("member session revoked after HEAD cannot commit", async () => {
  const actor = await h.identity(),
    p = await uploaded(actor),
    e = env();
  e.PROOFS_BUCKET = {
    head: async (key) => {
      const o = await l.bucket.head(key);
      await l.db
        .prepare(
          "UPDATE auth_sessions SET revoked_at=CAST(strftime('%s','now') AS INTEGER) WHERE token_hash=?",
        )
        .bind(actor.hash)
        .run();
      return o;
    },
  };
  assert.equal((await direct(p, e, actor)).status, 409);
  await untouched(p);
});
test("guest capability is checked on idempotent replay and cannot claim a profile", async () => {
  const p = await uploaded(),
    key = randomUUID();
  assert.equal((await create(p, undefined, key, { fan_id: "forged" })).status, 400);
  const first = await data(
    await create(p, undefined, key, { nickname: "Forged name", player_id: "forged" }),
    201,
  );
  assert.equal(
    (
      await create({ ...p, capability: "b".repeat(43) }, undefined, key, {
        nickname: "Forged name",
        player_id: "forged",
      })
    ).status,
    409,
  );
  const row = await l.db
    .prepare("SELECT nickname,player_id,member_id FROM cases WHERE case_id=?")
    .bind(first.case_id)
    .first();
  assert.deepEqual(row, { nickname: "匿名投稿", player_id: "匿名投稿", member_id: null });
});
test("direct PUT remains create-only on retry; different body cannot replace final bytes", async () => {
  const p = await uploaded();
  for (const source of [bytes, new Uint8Array([9, 9, 9])]) {
    const r = await l.runtime.dispatchFetch(p.uploads[0].upload_url, {
      method: "PUT",
      headers: { ...headers(), ...p.uploads[0].headers, "Content-Length": "3" },
      body: source,
    });
    assert.ok([409, 502].includes(r.status));
  }
  const object = await l.bucket.get(p.uploads[0].key);
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
  await data(await create(p), 201);
});
test("closed Campaign and mismatched fixed type refuse Case", async () => {
  await l.campaign({ campaign_id: "DIRECT-CLOSED" });
  const p = await uploaded(undefined);
  assert.equal((await create(p, undefined, randomUUID(), { vote_type: "團體" })).status, 400);
  const q = await prepared(undefined, { campaign_id: "DIRECT-CLOSED" });
  await l.put(q.uploads[0], bytes);
  await l.db
    .prepare(
      "UPDATE campaigns SET status='closed',version=version+1 WHERE campaign_id='DIRECT-CLOSED'",
    )
    .run();
  assert.equal(
    (await create(q, undefined, randomUUID(), { campaign_id: "DIRECT-CLOSED" })).status,
    400,
  );
  await untouched(q);
});
test("expired intent fails before HEAD", async () => {
  const p = await prepared(),
    row = await l.db
      .prepare("SELECT * FROM proof_upload_intents WHERE session_id=?")
      .bind(p.session_id)
      .first();
  const s = randomUUID(),
    proof = randomUUID();
  await l.db
    .prepare(
      `INSERT INTO proof_upload_intents(session_id,proof_id,object_key,campaign_id,guest_capability_hash,content_type,size,expected_sha256,created_at,expires_at,grant_expires,completion_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,'direct')`,
    )
    .bind(
      s,
      proof,
      `proofs/final/${s}/${proof}.png`,
      row.campaign_id,
      row.guest_capability_hash,
      row.content_type,
      row.size,
      row.expected_sha256,
      row.created_at,
      "2000-01-01T00:00:00.000Z",
      row.grant_expires,
    )
    .run();
  const expired = {
      ...p,
      session_id: s,
      proof_id: proof,
      uploads: [{ key: `proofs/final/${s}/${proof}.png` }],
    },
    e = env();
  e.PROOFS_BUCKET = { head: () => assert.fail("No HEAD for expired proof") };
  assert.equal((await direct(expired, e)).status, 409);
});
test("same key replays exact Case/query credential; different key cannot consume twice", async () => {
  const p = await uploaded(member),
    key = randomUUID(),
    first = await data(await create(p, member, key), 201);
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await data(await create(p, member, key), 201), first);
  assert.equal((await create(p, member)).status, 409);
  assert.equal((await cleanRows(p)).cases, 1);
  assert.equal((await create(p, member, key, { note: "changed" })).status, 409);
});
test("same-key concurrent requests converge to one Case/file", async () => {
  const p = await uploaded(),
    key = randomUUID(),
    results = await Promise.all(Array.from({ length: 4 }, () => create(p, undefined, key)));
  const values = await Promise.all(results.map((r) => data(r, 201)));
  for (const v of values) assert.deepEqual(v, values[0]);
  assert.equal((await cleanRows(p)).cases, 1);
  assert.equal((await cleanRows(p)).files, 1);
});
test("different-key concurrent requests only commit one Case/file", async () => {
  const p = await uploaded();
  const rs = await Promise.all(Array.from({ length: 4 }, () => create(p)));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal(rs.filter((r) => r.status === 409).length, 3);
  assert.equal((await cleanRows(p)).files, 1);
});
test("direct Case requires stable Idempotency-Key", async () => {
  const p = await uploaded();
  assert.equal((await l.fetch("/api/cases/direct", "POST", body(p), headers())).status, 400);
  await untouched(p);
});
for (const boundary of ["consume", "file", "idempotency"])
  test(`injected ${boundary} failure rolls back Case, file and intent consumption`, async () => {
    const p = await uploaded();
    const statement =
      boundary === "consume"
        ? `CREATE TRIGGER inject_direct_failure BEFORE UPDATE OF consumed_case_id ON proof_upload_intents WHEN NEW.session_id='${p.session_id}' BEGIN SELECT RAISE(ABORT,'Synthetic consume failure'); END`
        : boundary === "file"
          ? `CREATE TRIGGER inject_direct_failure BEFORE INSERT ON case_files WHEN NEW.upload_intent_id='${p.session_id}' BEGIN SELECT RAISE(ABORT,'Synthetic file failure'); END`
          : `CREATE TRIGGER inject_direct_failure BEFORE INSERT ON case_idempotency BEGIN SELECT RAISE(ABORT,'Synthetic idempotency failure'); END`;
    await l.db.prepare(statement).run();
    try {
      assert.equal((await create(p)).status, 500);
      await untouched(p);
    } finally {
      await l.db.prepare("DROP TRIGGER inject_direct_failure").run();
    }
    await data(await create(p), 201);
  });
test("lost Case transaction ACK recovers and still enqueues backup", async () => {
  const p = await uploaded(),
    e = env(),
    db = l.db;
  let once = false;
  e.DB = {
    prepare: (s) => db.prepare(s),
    batch: async (stmts) => {
      const r = await db.batch(stmts);
      if (!once) {
        once = true;
        throw Error("Lost ACK after commit");
      }
      return r;
    },
  };
  await data(await direct(p, e), 201);
  assert.equal((await cleanRows(p)).cases, 1);
  assert.equal(
    (
      await l.db
        .prepare("SELECT count(*) n FROM proof_backups WHERE file_id=?")
        .bind(p.proof_id)
        .first()
    ).n,
    1,
  );
});
test("native PUT success with lost ACK keeps pin; direct Case HEAD can consume", async () => {
  const p = await prepared(),
    e = env();
  e.PROOFS_BUCKET = {
    head: (...a) => l.bucket.head(...a),
    put: async (key, _stream, options) => {
      await l.bucket.put(key, bytes, options);
      throw Error("Synthetic native ACK lost");
    },
  };
  const r = await putUpload(
    e,
    new URL(p.uploads[0].upload_url),
    new Request(p.uploads[0].upload_url, {
      method: "PUT",
      headers: { ...headers(), ...p.uploads[0].headers, "Content-Length": "3" },
      body: bytes,
    }),
  );
  assert.equal(r.status, 502);
  const i = await l.db
    .prepare("SELECT state,write_token FROM proof_upload_intents WHERE session_id=?")
    .bind(p.session_id)
    .first();
  assert.equal(i.state, "prepared");
  assert.ok(i.write_token);
  await data(await create(p), 201);
  assert.ok(
    (
      await l.db
        .prepare("SELECT write_token FROM proof_upload_intents WHERE session_id=?")
        .bind(p.session_id)
        .first()
    ).write_token,
  );
});
test("cleanup wins after HEAD: transaction cannot create a Case", async () => {
  const p = await uploaded(),
    e = env();
  e.PROOFS_BUCKET = {
    head: async (...a) => {
      const o = await l.bucket.head(...a);
      for (let i = 0; i < 10; i++) {
        await cleanupFinalUploads(env(), { now: "2099-01-01T00:00:00.000Z" });
        if (
          (
            await l.db
              .prepare("SELECT state FROM proof_upload_intents WHERE session_id=?")
              .bind(p.session_id)
              .first()
          ).state === "deleted"
        )
          break;
      }
      return o;
    },
  };
  assert.equal((await direct(p, e)).status, 409);
  await untouched(p);
  assert.equal(await l.bucket.head(p.uploads[0].key), null);
});
test("Case wins: cleanup cannot delete consumed proof", async () => {
  const p = await uploaded();
  await data(await create(p), 201);
  await cleanupFinalUploads(env(), { now: "2099-01-01T00:00:00.000Z" });
  assert.ok(await l.bucket.head(p.uploads[0].key));
  assert.equal((await cleanRows(p)).cases, 1);
});
test("20 proofs produce 20 independent reviews/awards and idempotent partial batch retry", async () => {
  const proofs = [],
    cases = [];
  for (let i = 0; i < 20; i++) {
    const p = await uploaded(member);
    proofs.push(p);
    cases.push(await data(await create(p, member), 201));
  }
  assert.equal(new Set(cases.map((c) => c.case_id)).size, 20);
  const call = (items) =>
    l.fetch("/api/admin/cases/batch-approve", "POST", { cases: items }, admin.headers);
  for (let offset = 0; offset < 20; offset += 4) {
    const items = cases
      .slice(offset, offset + 4)
      .map((c) => ({ case_id: c.case_id, expected_version: 0 }));
    const result = await data(await call(items));
    assert.equal(result.succeeded, 4);
    assert.equal((await data(await call(items))).succeeded, 4);
  }
  const rows = await l.db
    .prepare(
      `SELECT COUNT(*) n,SUM(t.points) points FROM point_transactions t JOIN cases c ON c.id=t.case_id WHERE c.case_id IN (${cases.map(() => "?").join(",")})`,
    )
    .bind(...cases.map((c) => c.case_id))
    .first();
  assert.deepEqual(rows, { n: 20, points: 200 });
  const p = await uploaded(member),
    c = await data(await create(p, member), 201);
  await data(
    await h.review(admin, c.case_id, "flag_detailed", 0, { review_risk_reason: "manual_flag" }),
  );
  const partial = await data(
    await call([
      { case_id: cases[0].case_id, expected_version: 0 },
      { case_id: c.case_id, expected_version: 1 },
    ]),
  );
  assert.equal(partial.succeeded, 1);
  assert.equal(partial.failed, 1);
  await data(await h.review(admin, c.case_id, "reject", 1, { reason: "Manual rejection" }));
  await data(await h.review(admin, cases[1].case_id, "complete", 1));
  await data(await h.review(admin, cases[2].case_id, "revoke", 1, { reason: "Manual reversal" }));
  assert.equal(
    (
      await l.db
        .prepare("SELECT points_awarded FROM cases WHERE case_id=?")
        .bind(cases[2].case_id)
        .first()
    ).points_awarded,
    0,
  );
});
test("private Admin read and export work with null SHA and ZIP filename mapping", async () => {
  const p = await uploaded(member),
    c = await data(await create(p, member), 201);
  const detail = await data(
    await l.fetch("/api/admin/cases/" + c.case_id, "GET", undefined, admin.headers),
  );
  assert.equal(detail.duplicate_evidence, null);
  const image = await l.fetch(
    `/api/admin/cases/${c.case_id}/files/${p.proof_id}`,
    "GET",
    undefined,
    admin.headers,
  );
  assert.equal(image.status, 200);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), bytes);
  const filters = {
    campaign_id: "DIRECT-POINTS",
    entire_campaign: true,
    statuses: ["pending", "approved", "rejected", "other"],
    vote_types: ["Solo", "團體"],
    sources: ["member", "guest"],
  };
  const job = await data(
    await l.fetch(
      "/api/admin/image-exports/jobs",
      "POST",
      { job_id: randomUUID(), filters },
      admin.headers,
    ),
  );
  const attempt = randomUUID();
  const pkg = await data(
    await l.fetch(
      `/api/admin/image-exports/jobs/${job.id}/packages/1/start`,
      "POST",
      { attempt_id: attempt, expected_attempt_id: null },
      admin.headers,
    ),
  );
  const item = pkg.items.find((x) => x.file_id === p.proof_id);
  assert.ok(item);
  assert.equal(item.case_id, c.case_id);
  assert.equal(item.campaign_id, "DIRECT-POINTS");
  assert.equal(item.sha256, null);
  const exported = await l.fetch(
    `/api/admin/image-exports/jobs/${job.id}/packages/1/attempts/${attempt}/files/${p.proof_id}`,
    "GET",
    undefined,
    admin.headers,
  );
  assert.equal(exported.status, 200);
  const chunks = [],
    zip = new ZipStore(async (chunk) => chunks.push(chunk));
  const csv = new TextEncoder().encode(manifestCSV([item]));
  await zip.add("manifest.csv", new Blob([csv]).stream(), csv.length);
  await zip.add(entryFilename(item), new Blob([bytes]).stream(), bytes.length);
  await zip.close();
  const { unzipSync, strFromU8 } = await import("fflate");
  const files = unzipSync(Buffer.concat(chunks.map((x) => Buffer.from(x))));
  assert.deepEqual(files[entryFilename(item)], bytes);
  assert.ok(strFromU8(files["manifest.csv"]).includes(c.case_id));
});
test("foreign keys, direct file completeness and completion mode immutability", async () => {
  assert.deepEqual((await l.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  const p = await prepared();
  await assert.rejects(
    l.db
      .prepare("UPDATE proof_upload_intents SET completion_mode='legacy' WHERE session_id=?")
      .bind(p.session_id)
      .run(),
  );
  assert.equal(
    (
      await l.db
        .prepare(
          "SELECT count(*) n FROM cases WHERE upload_intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM case_files f WHERE f.upload_intent_id=cases.upload_intent_id)",
        )
        .first()
    ).n,
    0,
  );
});
test("deferred Case-to-file constraint prevents a standalone partial Case/consume commit", async () => {
  const p = await uploaded();
  await assert.rejects(
    l.db
      .prepare(
        `INSERT INTO cases(id,case_id,created_at,updated_at,nickname,player_id,campaign_id,vote_type,vote_date,query_key_hash,upload_intent_id)
 VALUES(?,?,?,?,?,?,'DIRECT-POINTS','Solo',?,?,?)`,
      )
      .bind(
        randomUUID(),
        "NO-FILE-" + randomUUID(),
        new Date().toISOString(),
        new Date().toISOString(),
        "匿名投稿",
        "匿名投稿",
        new Date().toISOString().slice(0, 10),
        "a".repeat(64),
        p.session_id,
      )
      .run(),
  );
  await untouched(p);
});

test("direct proof survives Apps Script claim, private stream, verified completion and lost ACK", async () => {
  const p = await uploaded(member), c = await data(await create(p, member), 201);
  // Only this proof is eligible; earlier tests may have left pending local jobs.
  await l.db.prepare("DELETE FROM proof_backups WHERE file_id!=?").bind(p.proof_id).run();
  const relay = (action, payload, job, extra = {}) => worker.fetch(new Request(
    origin + "/api/internal/drive-backup/" + (job ? job.backup_id + "/" : "") + action,
    {
      method: action === "content" ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + l.authConfig.DRIVE_BACKUP_RELAY_SECRET,
        ...(payload ? { "Content-Type": "application/json" } : {}), ...extra,
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    },
  ), env());
  const job = (await data(await relay("claim", { request_id: randomUUID(), root_folder_id: "integration_root" }))).job;
  assert.equal(job.case_id, c.case_id);
  assert.equal(job.proof_id, p.proof_id);
  assert.equal(/object_key|https?:/.test(JSON.stringify(job)), false);
  const proof = await relay("content", undefined, job, {
    "X-VoteProof-Backup-Lease": job.lease_token,
    "X-VoteProof-Backup-Attempt": String(job.attempt),
  });
  assert.equal(proof.status, 200);
  assert.equal(proof.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(new Uint8Array(await proof.arrayBuffer()), bytes);
  const receipt = { lease_token: job.lease_token, attempt: job.attempt };
  const ids = await data(await relay("identity", {
    ...receipt, drive_file_id: "integration_file", campaign_folder_id: "integration_campaign",
    date_folder_id: "integration_date",
  }, job));
  const completion = {
    ...receipt, drive_file_id: ids.drive_file_id, drive_folder_id: ids.drive_folder_id,
    verification: {
      name: job.filename, size: job.size, mime: job.mime, parents: [ids.drive_folder_id],
      appProperties: { source: "voteproof", storage_source: "r2", voteproof_case_id: c.case_id, voteproof_proof_id: p.proof_id },
    },
  };
  assert.equal((await data(await relay("complete", completion, job))).state, "confirmed");
  const snapshot = await l.db.prepare("SELECT * FROM proof_backups WHERE id=?").bind(job.backup_id).first();
  assert.equal((await data(await relay("complete", completion, job))).state, "already_confirmed");
  assert.deepEqual(await l.db.prepare("SELECT * FROM proof_backups WHERE id=?").bind(job.backup_id).first(), snapshot);
  assert.ok(await l.bucket.head(p.uploads[0].key));
  const detail = await data(await l.fetch("/api/admin/cases/" + c.case_id, "GET", undefined, admin.headers));
  const backups = await data(await l.fetch("/api/admin/cases/" + c.case_id + "/backups", "GET", undefined, admin.headers));
  assert.equal(backups.backups.find(b => b.file_id === p.proof_id).status, "confirmed");
  assert.equal(detail.points_awarded, 0);
  const rows = await cleanRows(p);
  for (const key of ["completed", "snapshots", "checksums", "hashes", "jobs", "requests", "groups"]) assert.equal(rows[key], 0, key);
});
