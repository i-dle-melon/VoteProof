import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";
import {
  capacityPut,
  reserveStorage,
  inventoryPage,
  capacityRow,
  evaluateCapacity,
  storageSummary,
  storageAudit,
  STORAGE,
  nowSeconds,
} from "../src/lib/storage-capacity.js";
import {
  coldContext,
  readColdProof,
  storageSignature,
  shaBytes,
  cleanupDryRun,
} from "../src/lib/cold-storage.js";
import { quotaSnapshot } from "../src/api/storage.js";
import { processStorageAlerts, storageRecipients } from "../src/lib/storage-alerts.js";
import { ensureCaseBackups } from "../src/lib/proof-backup-store.js";
import worker from "../src/index.js";
import { encryptEmail, emailHash } from "../src/lib/auth-identity.js";
import { countDatabase } from "../scripts/lib/drive-backup-fixture.mjs";
import { errorMessage } from "../public/js/api.js";
import { adminPath } from "../public/js/member-api.js";
import { privateProofResponse } from "../src/api/admin.js";
let h, db, actor;
const secret = randomBytes(32).toString("hex");
const env = () => ({
  ...h.local.authConfig,
  DB: db,
  PROOFS_BUCKET: h.local.bucket,
  GOOGLE_DRIVE_BACKUP_ENABLED: "true",
  DRIVE_BACKUP_RELAY_SECRET: secret,
  R2_EXCLUSIVE_WRITER_CONFIRMED: "true",
  DRIVE_COLD_RELAY_URL: "https://"+"script.google.com"+"/macros/s/fixture/exec",
});
before(async () => {
  h = await localAdminRuntime({ submissionsEnabled: false, directIntent:true });
  db = h.local.db;
  actor = await h.identity({ role: "admin" });
});
after(async () => {
  await h.local.runtime.dispose();
});
async function normal(bytes = 0) {
  await db.prepare("DELETE FROM storage_reservations").run();
  await db
    .prepare(
      "UPDATE storage_capacity SET used_bytes=?,reserved_bytes=0,blocked=0,trusted_until=?,observed_at=0,inventory_id=NULL,inventory_cursor=NULL,anomaly=NULL,cleanup_requested=0 WHERE id=1",
    )
    .bind(bytes, nowSeconds() + 600)
    .run();
}
const write = (key = "other/" + randomUUID(), size = 3, bucket = h.local.bucket) =>
  capacityPut(
    { ...env(), PROOFS_BUCKET: bucket },
    key,
    new Uint8Array(size),
    { httpMetadata: { contentType: "image/png" } },
    size,
  );
test("decimal budget and unknown default, expired snapshot and D1 failure all block before PUT", async () => {
  assert.equal(STORAGE.budget, 10000000000);
  let calls = 0;
  const bucket = {
    put: async () => {
      calls++;
    },
  };
  await normal();
  await db.prepare("UPDATE storage_capacity SET trusted_until=0 WHERE id=1").run();
  await assert.rejects(
    write("expired", 3, bucket),
    (e) => e.code === "R2_STORAGE_CAPACITY_EXCEEDED",
  );
  await assert.rejects(
    capacityPut(
      {
        DB: {
          prepare() {
            throw Error();
          },
        },
        PROOFS_BUCKET: bucket,
      },
      "db-down",
      new Uint8Array(3),
      {},
      3,
    ),
  );
  assert.equal(calls, 0);
});
test("known zero-write admission distinguishes active inventory, stale snapshot and real capacity stop",async()=>{
  await normal();
  const held=randomUUID();
  await db.prepare("UPDATE storage_capacity SET inventory_id=?,inventory_phase='scan',trusted_until=0 WHERE id=1").bind(held).run();
  let puts=0;
  const bucket={put:async()=>{puts++;throw Error('R2 was reached');}};
  await assert.rejects(write('inventory-admission',3,bucket),e=>
    e.code==='R2_STORAGE_INVENTORY_BUSY' && e.noWrite===true);
  assert.equal(puts,0);
  await db.prepare("UPDATE storage_capacity SET inventory_id=NULL,inventory_phase=NULL WHERE id=1").run();
  await assert.rejects(write('stale-admission',3,bucket),e=>
    e.code==='R2_STORAGE_SNAPSHOT_STALE' && e.noWrite===true);
  assert.equal(puts,0);
  await normal(STORAGE.stop);
  await assert.rejects(write('full-admission',3,bucket),e=>
    e.code==='R2_STORAGE_CAPACITY_EXCEEDED' && e.noWrite===true);
  assert.equal(puts,0);
});

test("concurrent reservations cannot overbook and accepted reservations include staging/admin/other bytes", async () => {
  await normal(STORAGE.stop - 10);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => reserveStorage(env(), "kind/" + i, 3)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  const row = await capacityRow(db);
  assert.equal(row.reserved_bytes, 9);
  assert.ok(row.used_bytes + row.reserved_bytes < STORAGE.stop);
});
test("95% blocks every write and at 90% upload remains allowed absent a latched block", async () => {
  await normal(STORAGE.stop);
  let calls = 0;
  for (const key of [
    "proofs/staging/guest",
    "proofs/staging/member",
    "proofs/final/direct",
    "proofs/cases/legacy",
    "campaign-assets/admin",
  ])
    await assert.rejects(
      write(key, 3, {
        put: async () => {
          calls++;
        },
      }),
      (e) => e.code === "R2_STORAGE_CAPACITY_EXCEEDED",
    );
  assert.equal(calls, 0);
  await normal(STORAGE.cleanupStart);
  await write();
  assert.equal((await capacityRow(db)).cleanup_requested, 1);
});
test("committed PUT is conservatively counted, failed/uncertain PUT is pinned and never expires automatically", async () => {
  await normal();
  await write("committed");
  assert.equal((await capacityRow(db)).used_bytes, 3);
  assert.equal((await capacityRow(db)).reserved_bytes, 0);
  await assert.rejects(
    write("uncertain", 3, {
      put: async () => {
        throw Error("lost ACK");
      },
    }),
  );
  assert.equal((await capacityRow(db)).reserved_bytes, 3);
  await db.prepare("UPDATE storage_reservations SET created_at=0").run();
  await assert.rejects(inventoryPage(env()), (e) => e.code === "STORAGE_WRITER_BUSY");
});
test("full bucket inventory includes orphan, staging and non-proof objects; resume needs <90 and preserves submissions OFF", async () => {
  await normal();
  for (const key of ["proofs/staging/orphan", "proofs/cases/orphan", "unrelated/object"])
    await h.local.bucket.put(key, new Uint8Array(7));
  await db.prepare("UPDATE storage_capacity SET blocked=1 WHERE id=1").run();
  const result = await inventoryPage(env());
  assert.equal(result.complete, true);
  const row = await capacityRow(db);
  assert.equal(row.blocked, 0);
  const listed = await h.local.bucket.list();
  assert.equal(
    row.used_bytes,
    listed.objects.reduce((n, o) => n + o.size, 0),
  );
  const hist = await db
    .prepare(
      "SELECT * FROM storage_history WHERE id=(SELECT id FROM storage_history ORDER BY rowid DESC LIMIT 1)",
    )
    .first();
  assert.ok(hist.staging_bytes >= 7);
  assert.ok(hist.other_bytes >= 7);
  assert.equal(
    (await db.prepare("SELECT submissions_enabled FROM submission_settings WHERE id=1").first())
      .submissions_enabled,
    0,
  );
});
test("inventory requires writer attestation; unexpected growth remains latched on later scans", async () => {
  await normal();
  await assert.rejects(
    inventoryPage({ ...env(), R2_EXCLUSIVE_WRITER_CONFIRMED: undefined }),
    (e) => e.code === "STORAGE_WRITER_UNVERIFIED",
  );
  await inventoryPage(env());
  await h.local.bucket.put("untracked/new", new Uint8Array(20));
  await inventoryPage(env());
  assert.equal((await capacityRow(db)).anomaly, "UNACCOUNTED_GROWTH");
  await inventoryPage(env());
  assert.equal((await capacityRow(db)).blocked, 1);
});
test("inventory page crash resumes cursor and concurrent page application commits only once", async () => {
  await normal();
  const fake = {
    list: async ({ cursor }) =>
      cursor
        ? { objects: [{ key: "last", size: 4 }], truncated: false }
        : { objects: [{ key: "first", size: 3 }], truncated: true, cursor: "page2" },
  };
  assert.equal((await inventoryPage({ ...env(), PROOFS_BUCKET: fake })).complete, false);
  assert.equal((await capacityRow(db)).inventory_cursor, "page2");
  await assert.rejects(write());
  assert.equal((await inventoryPage({ ...env(), PROOFS_BUCKET: fake })).bytes, 7);
  assert.equal((await capacityRow(db)).used_bytes, 7);
});
test("90/95 alerts deduplicate durably and immutable storage audit cannot be rewritten", async () => {
  await normal(STORAGE.stop);
  await evaluateCapacity(db);
  await evaluateCapacity(db);
  const rows = (
    await db
      .prepare(
        "SELECT kind,count(*) n FROM storage_alerts WHERE episode=(SELECT episode FROM storage_capacity) GROUP BY kind",
      )
      .all()
  ).results;
  assert.ok(rows.filter((r) => ["90", "95"].includes(r.kind)).every((r) => r.n === 1));
  await storageAudit(db, "test", "fixture");
  await assert.rejects(db.prepare("UPDATE storage_audit SET action='edit'").run());
  await assert.rejects(db.prepare("DELETE FROM storage_audit").run());
  assert.equal((await processStorageAlerts(env())).state, "disabled");
});
test("Drive quota unknown/unlimited/error stay unknown, stale is visible and invalid numbers fail closed", async () => {
  for (const state of ["unknown", "unlimited", "error"]) {
    await quotaSnapshot(env(), {
      id: randomUUID(),
      observed_at: nowSeconds(),
      state,
      total_bytes: null,
      used_bytes: null,
    });
    assert.equal((await storageSummary(db)).drive_quota.remaining_percent, null);
  }
  await quotaSnapshot(env(), {
    id: randomUUID(),
    observed_at: nowSeconds(),
    state: "known",
    total_bytes: 100,
    used_bytes: 70,
  });
  assert.equal((await storageSummary(db)).drive_quota.remaining_percent, 30);
  await assert.rejects(
    quotaSnapshot(env(), {
      id: randomUUID(),
      observed_at: nowSeconds(),
      state: "known",
      total_bytes: 100,
      used_bytes: 101,
    }),
  );
});
test("Admin storage GET/POST preserve role, MFA, Origin and CSRF; no guest/reviewer access", async () => {
  assert.equal((await h.local.fetch("/api/admin/storage")).status, 401);
  for (const role of ["reviewer", undefined]) {
    const a = await h.identity({ role });
    assert.equal(
      (await h.local.fetch("/api/admin/storage", "GET", undefined, a.headers)).status,
      403,
    );
  }
  const stale = await h.identity({ role: "admin", elevated: false });
  assert.equal(
    (await h.local.fetch("/api/admin/storage", "GET", undefined, stale.headers)).status,
    403,
  );
  assert.equal(
    (await h.local.fetch("/api/admin/storage", "GET", undefined, actor.headers)).status,
    200,
  );
  assert.equal(
    (
      await h.local.fetch(
        "/api/admin/storage/dry-run",
        "POST",
        {},
        { Cookie: actor.headers.Cookie },
      )
    ).status,
    403,
  );
});
async function coldFixture() {
  await db
    .prepare("UPDATE cases SET status_updated_at=? WHERE status='completed'")
    .bind(new Date().toISOString())
    .run();
  await normal();
  await db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
  let c;
  try {
    c = await h.makeCase();
  } finally {
    await db.prepare("UPDATE submission_settings SET submissions_enabled=0 WHERE id=1").run();
  }
  const f = await db.prepare("SELECT * FROM case_files WHERE case_id=?").bind(c.id).first();
  await db
    .prepare(
      "UPDATE cases SET status='completed',reviewed_at='2020-01-01T00:00:00.000Z',status_updated_at='2020-01-01T00:00:00.000Z' WHERE id=?",
    )
    .bind(c.id)
    .run();
  await ensureCaseBackups(env(), c.id);
  const b = await db.prepare("SELECT id FROM proof_backups WHERE file_id=?").bind(f.id).first();
  await db.batch([
    db
      .prepare("INSERT INTO drive_backup_folders VALUES(?,?,?,?,?,?)")
      .bind("root", "campaign:" + c.id, "campaign_" + f.id, "root", "fixture", nowSeconds()),
    db
      .prepare("INSERT INTO drive_backup_folders VALUES(?,?,?,?,?,?)")
      .bind("root", "date:" + c.id, "day_" + f.id, "campaign_" + f.id, "fixture", nowSeconds()),
    db
      .prepare(
        "UPDATE proof_backups SET status='confirmed',root_folder_id='root',drive_file_id=?,drive_folder_id=?,completed_at=?,lease_until=NULL WHERE id=?",
      )
      .bind("file_" + f.id, "day_" + f.id, nowSeconds(), b.id),
  ]);
  return coldContext(db, f.object_key);
}
async function bridge(row, { corrupt = false, alter = () => {}, wrongSignature = false } = {}) {
  const bytes = new Uint8Array([1, 2, 3]);
  return async (_url, init) => {
    const req = JSON.parse(init.body);
    const data = {
      metadata: {
        id: row.drive_file_id,
        trashed: false,
        name: row.case_id + ".png",
        size: 3,
        mimeType: "image/png",
        parents: [row.drive_folder_id],
        appProperties: {
          source: "voteproof",
          storage_source: "r2",
          voteproof_case_id: row.case_id,
          voteproof_proof_id: row.file_id,
        },
      },
      base64: btoa(String.fromCharCode(...(corrupt ? new Uint8Array([9, 8, 7]) : bytes))),
      root_folder_id: row.root_folder_id,
      campaign_folder_id: row.campaign_folder_id,
      date_folder_id: row.drive_folder_id,
      campaign_key_hash: await shaBytes(new TextEncoder().encode(row.campaign_key)),
      date_key_hash: await shaBytes(new TextEncoder().encode(row.date_key)),
    };
    alter(data);
    const r = { nonce: req.nonce, timestamp: nowSeconds(), payload: JSON.stringify(data) };
    r.signature = wrongSignature
      ? "x".repeat(43)
      : await storageSignature(
          secret,
          JSON.stringify(["VoteProof/storage-read-result", r.nonce, r.timestamp, r.payload]),
        );
    return Response.json(r);
  };
}
test("confirmed Drive backup is never enough: downloaded bytes, signature, folder, identity, MIME and size must match", async () => {
  const row = await coldFixture();
  const sha = await shaBytes(new Uint8Array([1, 2, 3]));
  assert.deepEqual(
    await readColdProof(env(), row, sha, { fetcher: await bridge(row) }),
    new Uint8Array([1, 2, 3]),
  );
  for (const options of [
    { corrupt: true },
    { wrongSignature: true },
    { alter: (p) => (p.metadata.appProperties.voteproof_case_id = "wrong") },
    { alter: (p) => (p.metadata.mimeType = "image/jpeg") },
    { alter: (p) => (p.metadata.size = 4) },
    { alter: (p) => (p.root_folder_id = "wrong") },
    { alter: (p) => (p.metadata.parents = ["public"]) },
  ])
    await assert.rejects(readColdProof(env(), row, sha, { fetcher: await bridge(row, options) }));
});
test("dry-run verifies exact bytes and R2 version, persists result and never deletes; stale lease resumes idempotently", async () => {
  const row = await coldFixture();
  await normal(STORAGE.cleanupStart);
  let readCount = 0;
  const read = async (e, r, sha) => {
    readCount++;
    return readColdProof(e, r, sha, { fetcher: await bridge(r) });
  };
  const a = await cleanupDryRun(env(), { read });
  assert.ok(
    a.items.some((i) => i.file_id === row.file_id && i.would_delete),
    JSON.stringify({
      a,
      state: await db
        .prepare("SELECT * FROM cold_proofs WHERE file_id=?")
        .bind(row.file_id)
        .first(),
      readCount,
    }),
  );
  assert.ok(await h.local.bucket.head(row.object_key));
  assert.equal(
    (await cleanupDryRun(env(), { read })).items.some((i) => i.file_id === row.file_id),
    false,
  );
  assert.equal(readCount, 1);
  await db
    .prepare("UPDATE cold_proofs SET state='verifying',lease_until=0 WHERE file_id=?")
    .bind(row.file_id)
    .run();
  await cleanupDryRun(env(), { read });
  assert.equal(
    (await db.prepare("SELECT state FROM cold_proofs WHERE file_id=?").bind(row.file_id).first())
      .state,
    "dry_run",
  );
  assert.ok(await h.local.bucket.head(row.object_key));
});
test("Drive confirmed but content mismatch or R2 replaced during verification blocks cleanup and emits failure only once", async () => {
  const row = await coldFixture();
  await normal(STORAGE.cleanupStart);
  const bad = await cleanupDryRun(env(), {
    read: async (e, r, sha) =>
      readColdProof(e, r, sha, { fetcher: await bridge(r, { corrupt: true }) }),
  });
  assert.ok(bad.items.some((i) => i.file_id === row.file_id && !i.would_delete));
  assert.ok(await h.local.bucket.head(row.object_key));
  await cleanupDryRun(env(), {
    read: async () => {
      await h.local.bucket.put(row.object_key, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "image/png" },
      });
    },
  });
  assert.equal(
    (await db.prepare("SELECT state FROM cold_proofs WHERE file_id=?").bind(row.file_id).first())
      .state,
    "blocked",
  );
});
test("missing R2 proof never invokes automatic Drive cold-read; archived proofs return a clear 410", async () => {
  const row = await coldFixture();
  await h.local.bucket.delete(row.object_key);
  await assert.rejects(privateProofResponse(env(), row), e => e.code === "PROOF_NOT_FOUND");
  await db.prepare("INSERT INTO cold_proofs(file_id,state,updated_at) VALUES(?,'cold',?) ON CONFLICT(file_id) DO UPDATE SET state='cold',updated_at=excluded.updated_at")
    .bind(row.file_id, nowSeconds()).run();
  await assert.rejects(privateProofResponse(env(), row),
    e => e.code === "PROOF_ARCHIVED_IN_DRIVE" && e.status === 410);
});
test("storage alerts have fixed sender, dedup recipients, durable send reservation and no retries after ambiguous send", async () => {
  assert.deepEqual(await storageRecipients(env()), [
    "a0909323005@gmail.com",
    "idle.voteproof.verify@gmail.com",
  ]);
  await db.prepare("UPDATE storage_alerts SET state='disabled'").run();
  await db
    .prepare("INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,999,'90',?)")
    .bind(randomUUID(), nowSeconds())
    .run();
  let sends = 0;
  const e = {
    ...env(),
    STORAGE_ALERT_ENABLED: "true",
    STORAGE_ALERT_RELAY_URL: "https://"+"script.google.com"+"/macros/s/alerts/exec",
    STORAGE_ALERT_RELAY_SECRET: randomBytes(32).toString("hex"),
  };
  const result = await processStorageAlerts(e, {
    send: async () => {
      sends++;
      return "ambiguous";
    },
  });
  assert.equal(result.state, "ambiguous");
  await processStorageAlerts(e, { send: async () => assert.fail("Never retry ambiguous") });
  assert.equal(sends, 2);
  assert.equal(
    (await db.prepare("SELECT submissions_enabled FROM submission_settings WHERE id=1").first())
      .submissions_enabled,
    0,
  );
});

test("real legacy/final/member/guest and Admin image HTTP paths return fixed capacity error at 95%", async () => {
  await normal();
  await db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
  try {
    for (const final of [false, true, "direct"])
      for (const member of [false, true]) {
        await normal();
        const headers = member ? actor.headers : { Origin: "https://voteproof.example" };
        const body = {
          turnstile_token: "fixture",
          files: [
            {
              name: "test.png",
              type: "image/png",
              size: 3,
              algorithm: "sha256",
              sha256: await shaBytes(new Uint8Array([1, 2, 3])),
            },
          ],
          ...(final ? { storage_version: 2, campaign_id: "LOCAL-TEST",...(final==="direct"?{completion_mode:"direct"}:{}) } : {}),
        };
        const prepared = await h.local.fetch("/api/uploads/prepare", "POST", body, headers);
        assert.equal(prepared.status, 200, await prepared.clone().text());
        const u = (await prepared.json()).data.uploads[0];
        await normal(STORAGE.stop);
        const r = await h.local.runtime.dispatchFetch(u.upload_url, {
          method: "PUT",
          headers: {
            ...headers,
            Origin: "https://voteproof.example",
            ...u.headers,
            "Content-Length": "3",
          },
          body: new Uint8Array([1, 2, 3]),
        });
        assert.equal(r.status, 503);
        assert.equal((await r.json()).error.code, "R2_STORAGE_CAPACITY_EXCEEDED");
        assert.equal(await h.local.bucket.head(u.key), null);
      }
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const response = await h.local.runtime.dispatchFetch(
      "https://voteproof.example/api/admin/campaign-assets/LOCAL-TEST",
      { method: "POST", headers: { ...actor.headers, "Content-Type": "image/png" }, body: png },
    );
    assert.equal(response.status, 503, await response.clone().text());
    assert.equal((await response.json()).error.code, "R2_STORAGE_CAPACITY_EXCEEDED");
  } finally {
    await db.prepare("UPDATE submission_settings SET submissions_enabled=0 WHERE id=1").run();
  }
  assert.equal(
    errorMessage({ code: "R2_STORAGE_CAPACITY_EXCEEDED" }),
    "目前儲存空間不足，暫時停止圖片上傳，請稍後再試。",
  );
  for (const path of [
    "/api/admin/storage",
    "/api/admin/storage/dry-run",
    "/api/admin/storage/inventory",
  ])
    assert.equal(adminPath(path), true);
  assert.equal(adminPath("/api/admin/storage/delete"), false);
});
test("archived R2 proof requires manual Drive access; export rejects archived scope explicitly", async () => {
  const row = await coldFixture();
  await h.local.bucket.delete(row.object_key);
  await db.prepare("INSERT INTO cold_proofs(file_id,state,updated_at) VALUES(?,'cold',?) ON CONFLICT(file_id) DO UPDATE SET state='cold',updated_at=excluded.updated_at")
    .bind(row.file_id, nowSeconds()).run();
  const proof = "/api/admin/cases/" + row.case_id + "/files/" + row.file_id;
  const response = await worker.fetch(
    new Request("https://voteproof.example" + proof, { headers: actor.headers }), env());
  assert.equal(response.status, 410, await response.clone().text());
  assert.equal((await response.json()).error.code, "PROOF_ARCHIVED_IN_DRIVE");
  const filters = {
    from: "2020-01-01T00:00",
    to: "2030-01-01T00:00",
    campaign_id: null,
    entire_campaign: false,
    statuses: ["approved"],
    vote_types: ["Solo", "團體"],
    sources: ["guest", "member"],
  };
  const result = await h.local.fetch(
    "/api/admin/image-exports/jobs", "POST",
    { job_id: randomUUID(), filters }, actor.headers);
  assert.equal(result.status, 409, await result.clone().text());
  assert.equal((await result.json()).error.code, "EXPORT_ARCHIVED_PROOF");
});
test("verified active managers are added, normalized and deduplicated; reviewers and suspended managers are excluded", async () => {
  async function add(role, email, status = "active") {
    const a = await h.identity({ role, status });
    const id = randomUUID(),
      enc = await encryptEmail(env(), email, id);
    await db
      .prepare(
        "INSERT INTO auth_identities(provider,provider_subject,member_id,email_lookup_hash,email_ciphertext,email_iv,email_key_version,created_at) VALUES('supabase',?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        a.memberId,
        await emailHash(env(), email),
        enc.email_ciphertext,
        enc.email_iv,
        enc.email_key_version,
        nowSeconds(),
      )
      .run();
  }
  await add("admin", "a0909323005@gmail.com");
  await add("super_admin", "fixture-admin@example.invalid");
  await add("reviewer", "fixture-reviewer@example.invalid");
  await add("admin", "fixture-suspended@example.invalid", "suspended");
  assert.deepEqual(await storageRecipients(env()), [
    "a0909323005@gmail.com",
    "fixture-admin@example.invalid",
    "idle.voteproof.verify@gmail.com",
  ]);
});
test("alert quota defers unsent recipients durably rather than dropping or retrying prior sends", async () => {
  await db.prepare("UPDATE storage_alerts SET state='disabled'").run();
  const alertId = randomUUID();
  await db
    .prepare("INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,1000,'95',?)")
    .bind(alertId, nowSeconds())
    .run();
  const e = {
    ...env(),
    STORAGE_ALERT_ENABLED: "true",
    STORAGE_ALERT_RELAY_URL: "https://"+"script.google.com"+"/macros/s/alerts/exec",
    STORAGE_ALERT_RELAY_SECRET: randomBytes(32).toString("hex"),
  };
  await db.prepare("UPDATE storage_alert_deliveries SET created_at=0").run();
  for (let i = 0; i < 5; i++)
    await db
      .prepare("INSERT INTO storage_alert_deliveries VALUES(?,?,?,?, 'sent')")
      .bind(randomUUID(), alertId, "quota-" + i, nowSeconds())
      .run();
  assert.equal(
    (await processStorageAlerts(e, { send: async () => assert.fail("quota must block") })).state,
    "pending",
  );
  await db.prepare("UPDATE storage_alert_deliveries SET created_at=0").run();
  let calls = 0;
  assert.equal(
    (
      await processStorageAlerts(e, {
        send: async () => {
          calls++;
          return "sent";
        },
      })
    ).state,
    "sent",
  );
  assert.equal(calls, 3);
  assert.equal((await processStorageAlerts(e)).state, "idle");
});
test("normal PUT adds three D1 application trips and no SHA body hashing; schema remains healthy and submissions OFF", async () => {
  await normal();
  const meter = countDatabase(db);
  await capacityPut({ ...env(), DB: meter.db }, "meter/" + randomUUID(), new Uint8Array(3), {}, 3);
  assert.equal(meter.queries, 3);
  const result = await db.prepare("PRAGMA quick_check").first();
  assert.equal(result.quick_check, "ok");
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.equal(
    (await db.prepare("SELECT submissions_enabled FROM submission_settings WHERE id=1").first())
      .submissions_enabled,
    0,
  );
});

test("two scanners racing the same final cursor commit one page/history only", async () => {
  await normal();
  let release;
  const gate = new Promise((r) => (release = r));
  let waiting = 0;
  const fake = {
    list: async ({ cursor }) => {
      if (!cursor) return { objects: [{ key: "first", size: 1 }], truncated: true, cursor: "last" };
      if (++waiting === 2) release();
      await gate;
      return { objects: [{ key: "last", size: 2 }], truncated: false };
    },
  };
  await inventoryPage({ ...env(), PROOFS_BUCKET: fake });
  const results = await Promise.allSettled([
    inventoryPage({ ...env(), PROOFS_BUCKET: fake }),
    inventoryPage({ ...env(), PROOFS_BUCKET: fake }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await capacityRow(db)).used_bytes, 3);
});

test('retention is measured from closure, not an old approval timestamp',async()=>{const row=await coldFixture();await db.prepare('UPDATE cases SET status_updated_at=? WHERE id=?').bind(new Date().toISOString(),row.case_internal_id).run();await normal(STORAGE.cleanupStart);const result=await cleanupDryRun(env(),{read:async()=>assert.fail('Freshly closed case is not eligible')});assert.equal(result.items.some(i=>i.file_id===row.file_id),false);});
