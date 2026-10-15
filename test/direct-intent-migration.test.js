import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { unstable_splitSqlQuery } from "wrangler";
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";
import { rememberCompletedUpload } from "../src/lib/completed-uploads.js";
import { applyReview } from "../src/lib/admin-store.js";
import { reviewInput } from "../src/lib/case-review.js";

test("0018 preserves populated V1/V2 data, indexes, trigger policies and private objects; legacy readers/review/points/export remain usable", async () => {
  const h = await localAdminRuntime({ migrationThrough: "0017_immutable_final_uploads.sql" }),
    l = h.local;
  try {
    await l.setAuthConfig({
      GOOGLE_DRIVE_BACKUP_ENABLED: "true",
      DRIVE_BACKUP_RELAY_SECRET: "a".repeat(64),
    });
    const db = l.db,
      member = await h.identity(),
      admin = await h.identity({ role: "admin" });
    await db
      .prepare(
        "UPDATE campaigns SET points_per_proof=10,daily_limit=NULL WHERE campaign_id='LOCAL-TEST'",
      )
      .run();
    const v1 = await h.makeCase({ member });
    const session = randomUUID(),
      proof = randomUUID(),
      key = `proofs/final/${session}/${proof}.png`,
      bytes = new Uint8Array([1, 2, 3]);
    const sha = createHash("sha256").update(bytes).digest("hex"),
      now = new Date().toISOString(),
      expiry = new Date(Date.now() + 86400000).toISOString();
    await db
      .prepare(
        `INSERT INTO proof_upload_intents(session_id,proof_id,object_key,campaign_id,member_id,content_type,size,expected_sha256,created_at,expires_at,grant_expires)
   VALUES(?,?,?,'LOCAL-TEST',?,'image/png',3,?,?,?,?)`,
      )
      .bind(
        session,
        proof,
        key,
        member.memberId,
        sha,
        now,
        expiry,
        Math.floor(Date.now() / 1000) + 300,
      )
      .run();
    const obj = await l.bucket.put(key, bytes, {
      sha256: sha,
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "image/png" },
    });
    await rememberCompletedUpload(
      { DB: db },
      session,
      [{ key, type: "image/png", size: 3, sha256: sha, etag: obj.etag }],
      { expires_at: expiry },
    );
    const body = {
      campaign_id: "LOCAL-TEST",
      vote_type: "Solo",
      vote_date: now.slice(0, 10),
      upload_session: { session_id: session, keys: [key] },
    };
    const response = await l.fetch("/api/cases", "POST", body, {
      ...member.headers,
      "Idempotency-Key": randomUUID(),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const v2 = (await response.json()).data;
    // Exercise the unchanged domain write against the old schema before upgrade.
    const row = await db.prepare("SELECT * FROM cases WHERE id=?").bind(v1.id).first();
    await applyReview(
      db,
      { member: { member_id: admin.memberId, tokenHash: admin.hash }, role: "admin" },
      row,
      reviewInput({ action: "approve", expected_version: 0 }, "admin"),
    );
    await db.prepare("UPDATE submission_settings SET submissions_enabled=0 WHERE id=1").run();
    const tables = (
      await db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
        )
        .all()
    ).results.map((r) => r.name);
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (t) => [
            t,
            (await db.prepare('SELECT * FROM "' + t + '"').all()).results
              .map(({ upload_intent_id, completion_mode, ...r }) => JSON.stringify(r))
              .sort(),
          ]),
        ),
      );
    const before = await snapshot(),
      schema = (
        await db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
      ).results;
    const sql = await readFile(
      new URL("../migrations/0018_direct_intent_cases.sql", import.meta.url),
      "utf8",
    );
    await db.batch(unstable_splitSqlQuery(sql).map((s) => db.prepare(s)));
    assert.deepEqual(await snapshot(), before);
    const after = (
      await db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
    ).results;
    const adjusted = new Set([
      "final_case_guard",
      "final_case_consume",
      "final_case_file_guard",
      "final_intent_state",
    ]);
    const normalize = (s) => s.replaceAll('"', "").replace(/\s+/g, " ").trim();
    for (const original of schema) {
      const restored = after.find((r) => r.name === original.name);
      assert.ok(restored, original.name);
      if (!adjusted.has(original.name))
        assert.equal(normalize(restored.sql), normalize(original.sql), original.name);
    }
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.equal((await db.prepare("PRAGMA quick_check").first()).quick_check, "ok");
    assert.equal(
      (await db.prepare("SELECT submissions_enabled FROM submission_settings").first())
        .submissions_enabled,
      0,
    );
    assert.equal((await db.prepare("SELECT sum(points) n FROM point_transactions").first()).n, 10);
    assert.equal((await db.prepare("SELECT count(*) n FROM proof_backups").first()).n, 2);
    for (const c of [v1, v2]) {
      const detail = await l.fetch(
        "/api/admin/cases/" + c.case_id,
        "GET",
        undefined,
        admin.headers,
      );
      assert.equal(detail.status, 200);
      const d = (await detail.json()).data;
      assert.notEqual(d.duplicate_evidence, null);
      assert.equal(
        (
          await l.fetch(
            `/api/admin/cases/${c.case_id}/files/${d.files[0].file_id}`,
            "GET",
            undefined,
            admin.headers,
          )
        ).status,
        200,
      );
      assert.equal(
        (await l.fetch("/api/me/cases/" + c.case_id, "GET", undefined, member.headers)).status,
        200,
      );
    }
    assert.equal((await h.review(admin, v2.case_id, "approve")).status, 200);
    assert.equal(
      (await h.review(admin, v1.case_id, "revoke", 1, { reason: "Legacy reversal" })).status,
      200,
    );
    assert.equal((await db.prepare("SELECT sum(points) n FROM point_transactions").first()).n, 10);
    const exported = await l.fetch(
      "/api/admin/image-exports/jobs",
      "POST",
      {
        job_id: randomUUID(),
        filters: {
          campaign_id: "LOCAL-TEST",
          entire_campaign: true,
          statuses: ["pending", "approved", "rejected", "other"],
          vote_types: ["Solo", "團體"],
          sources: ["member", "guest"],
        },
      },
      admin.headers,
    );
    assert.equal(exported.status, 200, await exported.clone().text());
    const items = (await db.prepare("SELECT case_id,file_id,sha256 FROM export_job_items").all())
      .results;
    assert.deepEqual(items.map((x) => x.case_id).sort(), [v1.case_id, v2.case_id].sort());
    assert.ok(items.every((x) => x.sha256 === null));
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    await l.runtime.dispose();
  }
});
