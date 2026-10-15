import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

// Local D1 cannot reproduce the remote /query CASE parser defect. These tests
// verify that the actual migration trigger retains its consumption/abort policy;
// remote migration validation is recorded separately in the release runbook.
test("0018 consumption trigger preserves legacy/direct behavior and aborts an unconsumed direct Case", async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "",
      d1Databases: ["DB"],
    }),
  );
  try {
    const db = await runtime.getD1Database("DB");
    const sql = await readFile(
      new URL("../migrations/0018_direct_intent_cases.sql", import.meta.url),
      "utf8",
    );
    const trigger = unstable_splitSqlQuery(sql).find((s) =>
      /^CREATE TRIGGER final_case_consume\b/.test(s.trim()),
    );
    assert.ok(trigger);
    await db.batch([
      db.prepare(
        "CREATE TABLE cases(id TEXT PRIMARY KEY,upload_session_id TEXT,upload_intent_id TEXT,created_at TEXT)",
      ),
      db.prepare(
        "CREATE TABLE proof_upload_intents(session_id TEXT PRIMARY KEY,completion_mode TEXT,state TEXT,consumed_case_id TEXT,consumed_at TEXT)",
      ),
      db.prepare(trigger),
    ]);
    const intent = (id, mode, state) =>
      db
        .prepare("INSERT INTO proof_upload_intents VALUES(?,?,?,NULL,NULL)")
        .bind(id, mode, state)
        .run();
    const insert = (id, legacy, direct) =>
      db.prepare("INSERT INTO cases VALUES(?,?,?,'synthetic-time')").bind(id, legacy, direct).run();

    await intent("legacy", "legacy", "sealed");
    await insert("legacy-case", "legacy", null);
    assert.deepEqual(
      await db
        .prepare(
          "SELECT state,consumed_case_id,consumed_at FROM proof_upload_intents WHERE session_id='legacy'",
        )
        .first(),
      { state: "consumed", consumed_case_id: "legacy-case", consumed_at: "synthetic-time" },
    );

    await intent("direct", "direct", "prepared");
    await insert("direct-case", null, "direct");
    assert.deepEqual(
      await db
        .prepare(
          "SELECT state,consumed_case_id,consumed_at FROM proof_upload_intents WHERE session_id='direct'",
        )
        .first(),
      { state: "consumed", consumed_case_id: "direct-case", consumed_at: "synthetic-time" },
    );

    await assert.rejects(
      insert("missing-case", null, "missing"),
      /Direct intent consumption failed/,
    );
    await assert.rejects(insert("second-case", null, "direct"), /Direct intent consumption failed/);
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM cases WHERE id IN ('missing-case','second-case')")
          .first()
      ).n,
      0,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT consumed_case_id FROM proof_upload_intents WHERE session_id='direct'")
          .first()
      ).consumed_case_id,
      "direct-case",
    );

    await intent("ignored", "direct", "prepared");
    await db
      .prepare(
        "CREATE TRIGGER ignored_consume BEFORE UPDATE ON proof_upload_intents WHEN OLD.session_id='ignored' BEGIN SELECT RAISE(IGNORE); END",
      )
      .run();
    await assert.rejects(
      insert("ignored-case", null, "ignored"),
      /Direct intent consumption failed/,
    );
    assert.equal(
      (await db.prepare("SELECT count(*) n FROM cases WHERE id='ignored-case'").first()).n,
      0,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT state FROM proof_upload_intents WHERE session_id='ignored'")
          .first()
      ).state,
      "prepared",
    );
    assert.equal((await db.prepare("PRAGMA quick_check").first()).quick_check, "ok");
  } finally {
    await runtime.dispose();
  }
});
