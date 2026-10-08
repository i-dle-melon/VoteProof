// Always creates a new ignored LOCAL database. Never uses --remote.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repository = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const persistTo = resolve(repository, ".wrangler", "b5a-schema-" + randomUUID());
assert.equal(existsSync(persistTo), false, "Migration verification requires a fresh local directory");
function run(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args, "--local", "--persist-to", persistTo], {
    cwd: repository, encoding: "utf8", windowsHide: true, timeout: 60000,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
  // Only fixed schema/count queries on an empty database; diagnostic output
  // cannot contain auth/user rows, credential values or uploaded object keys.
  if (result.error || result.status !== 0) throw new Error("Local Wrangler schema verification failed: " +
    (result.error?.message || result.stderr || result.stdout || "exit " + result.status));
  return result.stdout;
}
function query(sql) {
  const data = JSON.parse(run(["d1", "execute", "voteproof-cases", "--command", sql, "--json"]));
  assert.ok(data.every(result => result.success));
  return data.flatMap(result => result.results);
}
assert.deepEqual(query("SELECT name FROM sqlite_master WHERE type = 'table'"), []);
run(["d1", "migrations", "apply", "voteproof-cases"]);
const schemaQueries = [
  "SELECT name FROM d1_migrations ORDER BY id",
  "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  "PRAGMA table_info(cases)", "PRAGMA foreign_key_list(admin_memberships)", "PRAGMA foreign_key_list(cases)",
  "PRAGMA foreign_key_list(admin_audit_logs)",
  "SELECT (SELECT COUNT(*) FROM cases) + (SELECT COUNT(*) FROM members) + (SELECT COUNT(*) FROM admin_memberships) + (SELECT COUNT(*) FROM admin_audit_logs) AS n",
  "PRAGMA foreign_key_check", "PRAGMA quick_check",
];
const results = JSON.parse(run(["d1", "execute", "voteproof-cases", "--command", schemaQueries.join(";\n"), "--json"]));
assert.equal(results.length, schemaQueries.length);
assert.ok(results.every(result => result.success));
const rows = results.map(result => result.results);
const applied = rows[0].map(row => row.name);
assert.deepEqual(applied, ["0001_cases.sql", "0002_case_idempotency.sql", "0003_member_identity.sql", "0004_admin_review.sql"]);
const tables = rows[1].map(row => row.name);
for (const name of ["cases", "case_files", "completed_uploads", "completed_upload_files", "case_idempotency", "members", "auth_sessions", "auth_challenges", "auth_rate_limits", "admin_memberships", "admin_audit_logs"]) assert.ok(tables.includes(name));
const indexes = rows[2].map(row => row.name);
for (const name of ["idx_cases_admin_queue", "idx_cases_last_review", "idx_cases_duplicate_target", "idx_admin_audit_cursor", "idx_admin_audit_actor", "idx_admin_audit_target"]) assert.ok(indexes.includes(name));
const triggers = rows[3].map(row => row.name);
assert.deepEqual(triggers, ["admin_audit_no_delete", "admin_audit_no_replace", "admin_audit_no_update", "cases_duplicate_insert", "cases_duplicate_update"]);
const caseColumns = rows[4].map(row => row.name);
for (const name of ["version", "status_reason", "status_updated_at", "status_updated_by", "duplicate_of_case_id", "reviewed_at", "reviewer_id", "last_review_id"]) assert.ok(caseColumns.includes(name));
const membershipFks = rows[5];
assert.ok(membershipFks.some(row => row.from === "member_id" && row.table === "members" && row.to === "member_id"));
assert.ok(membershipFks.some(row => row.from === "created_by" && row.table === "members"));
const caseFks = rows[6];
assert.ok(caseFks.some(row => row.from === "duplicate_of_case_id" && row.table === "cases"));
assert.ok(caseFks.some(row => row.from === "status_updated_by" && row.table === "members"));
assert.ok(rows[7].some(row => row.from === "admin_member_id" && row.table === "members"));
assert.equal(rows[8][0].n, 0);
assert.deepEqual(rows[9], []);
assert.equal(rows[10][0].quick_check, "ok");
console.log(JSON.stringify({ result: "PASS", migrations: applied, tables, indexes, triggers, foreign_key_check: "PASS", quick_check: "ok", fixture_rows: 0, production_used: false }, null, 2));
