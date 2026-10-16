import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { unstable_splitSqlQuery } from "wrangler";
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";

const migration = await readFile(
  new URL("../migrations/0019_solo_target_registry.sql", import.meta.url),
  "utf8",
);
test("0019 SQL is additive, forward-only and independent of new Campaigns", () => {
  const statements = unstable_splitSqlQuery(migration).map((s) =>
    s.replace(/--[^\n]*/g, "").trim(),
  );
  assert.equal(statements.length, 3);
  assert.match(statements[0], /^CREATE TABLE solo_targets\s*\(/i);
  assert.match(
    statements[1],
    /^CREATE TRIGGER solo_targets_stable_identity BEFORE UPDATE OF target_id ON solo_targets\b/i,
  );
  assert.match(statements[2], /^INSERT INTO solo_targets\b/i);
  assert.doesNotMatch(
    migration,
    /\b(?:DROP|ALTER|DELETE|REPLACE)\b|^\s*UPDATE\b|2026_MAMA_FANS_CHOICE/im,
  );
});
test("real Miniflare: populated 0018 accepts 0019 without changing historical schema or data", async () => {
  const h = await localAdminRuntime({ migrationThrough: "0018_direct_intent_cases.sql" }),
    l = h.local,
    db = l.db;
  try {
    const member = await h.identity({ role: "super_admin" });
    await l.campaign({
      campaign_id: "HISTORICAL-UNKNOWN",
      solo_target: "legacy_unknown",
      points_per_proof: 10,
      daily_limit: null,
    });
    const proof = await h.makeCase({ member, metadata: { campaign_id: "HISTORICAL-UNKNOWN" } });
    const approved = await h.review(member, proof.case_id, "approve");
    assert.equal(approved.status, 200);
    const schema = async () =>
      (
        await db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
          )
          .all()
      ).results;
    const tables = [
      "campaigns",
      "cases",
      "case_files",
      "members",
      "auth_sessions",
      "admin_audit_logs",
      "point_transactions",
      "proof_backups",
      "submission_settings",
    ];
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => [
            table,
            (await db.prepare("SELECT * FROM " + table).all()).results
              .map((row) => JSON.stringify(row))
              .sort(),
          ]),
        ),
      );
    const beforeSchema = await schema(),
      before = await snapshot();
    assert.equal(before.point_transactions.length, 1);
    await db.batch(unstable_splitSqlQuery(migration).map((s) => db.prepare(s)));
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      (await schema()).filter(
        (r) => !["solo_targets", "solo_targets_stable_identity"].includes(r.name),
      ),
      beforeSchema,
    );
    const targets = (
      await db
        .prepare(
          "SELECT target_id,display_name,active,sort_order FROM solo_targets ORDER BY sort_order",
        )
        .all()
    ).results;
    assert.deepEqual(
      targets,
      ["miyeon", "minnie", "soyeon", "yuqi", "shuhua"].map((target_id, i) => ({
        target_id,
        display_name: target_id.toUpperCase(),
        active: 1,
        sort_order: i + 1,
      })),
    );
    assert.equal(
      (
        await db
          .prepare("SELECT solo_target FROM campaigns WHERE campaign_id='HISTORICAL-UNKNOWN'")
          .first()
      ).solo_target,
      "legacy_unknown",
    );
    const read = await l.fetch(
      "/api/admin/campaigns/HISTORICAL-UNKNOWN",
      "GET",
      undefined,
      member.headers,
    );
    assert.equal(read.status, 200);
    assert.equal((await read.json()).data.solo_target, "legacy_unknown");
    const owner = await l.fetch("/api/me/cases/" + proof.case_id, "GET", undefined, member.headers);
    assert.equal(owner.status, 200);
    assert.equal((await owner.json()).data.points_awarded, 10);
    // All 0019 schema/data assertions precede the upgrade required by current
    // leaderboard code. Keep the historical compatibility read on latest schema.
    await db.batch(unstable_splitSqlQuery(await readFile(new URL('../migrations/0020_current_comeback.sql',import.meta.url),'utf8')).map(s=>db.prepare(s)));
    const board = await l.fetch("/api/leaderboards?id=system-solo");
    assert.equal(board.status, 200);
    assert.equal((await board.json()).data.leaderboards[0].rankings[0].points, 10);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.equal((await db.prepare("PRAGMA quick_check").first()).quick_check, "ok");
  } finally {
    await l.runtime.dispose();
  }
});
