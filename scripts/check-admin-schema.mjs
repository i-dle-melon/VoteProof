// Always creates a new ignored LOCAL database. Never uses --remote.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repository = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const persistTo = resolve(repository, ".wrangler", "b5d-schema-" + randomUUID());
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
  "PRAGMA foreign_key_check", "PRAGMA quick_check", "PRAGMA foreign_key_list(point_transactions)",
  "SELECT (SELECT COUNT(*) FROM campaigns) + (SELECT COUNT(*) FROM point_transactions) AS n",
  "PRAGMA foreign_key_list(leaderboards)", "PRAGMA foreign_key_list(leaderboard_runs)", "PRAGMA foreign_key_list(leaderboard_results)",
  "SELECT (SELECT COUNT(*) FROM leaderboards) + (SELECT COUNT(*) FROM leaderboard_runs) + (SELECT COUNT(*) FROM leaderboard_results) AS n",
  "SELECT tier_id,name,rank_order,min_points,icon_key,status FROM member_tiers ORDER BY rank_order", "PRAGMA foreign_key_list(member_tiers)",
  "PRAGMA table_info(members)", "PRAGMA foreign_key_list(member_credentials)", "PRAGMA foreign_key_list(auth_transactions)",
  "PRAGMA foreign_key_list(auth_sessions)", "PRAGMA foreign_key_list(trusted_devices)", "PRAGMA foreign_key_list(recovery_codes)",
  "SELECT (SELECT count(*) FROM member_credentials)+(SELECT count(*) FROM auth_transactions)+(SELECT count(*) FROM auth_sessions)+(SELECT count(*) FROM trusted_devices)+(SELECT count(*) FROM recovery_codes)+(SELECT count(*) FROM auth_atomic_guards) AS n",
];
const results = JSON.parse(run(["d1", "execute", "voteproof-cases", "--command", schemaQueries.join(";\n"), "--json"]));
assert.equal(results.length, schemaQueries.length);
assert.ok(results.every(result => result.success));
const rows = results.map(result => result.results);
const applied = rows[0].map(row => row.name);
assert.deepEqual(applied, ["0001_cases.sql", "0002_case_idempotency.sql", "0003_member_identity.sql", "0004_admin_review.sql", "0005_campaign_point_ledger.sql", "0006_leaderboards.sql", "0007_member_tiers.sql"]);
const tables = rows[1].map(row => row.name);
for (const name of ["cases", "case_files", "completed_uploads", "completed_upload_files", "case_idempotency", "members", "auth_sessions", "member_credentials", "auth_transactions", "trusted_devices", "recovery_codes", "auth_atomic_guards", "auth_rate_limits", "admin_memberships", "admin_audit_logs", "campaigns", "point_transactions", "leaderboards", "leaderboard_runs", "leaderboard_results", "member_tiers"]) assert.ok(tables.includes(name));
const indexes = rows[2].map(row => row.name);
for (const name of ["idx_cases_admin_queue", "idx_cases_last_review", "idx_cases_duplicate_target", "idx_admin_audit_cursor", "idx_admin_audit_actor", "idx_admin_audit_target", "idx_campaigns_public", "idx_campaigns_admin", "idx_points_member_date", "idx_points_daily", "idx_points_case", "idx_points_case_award", "idx_points_reversal"]) assert.ok(indexes.includes(name));
const triggers = rows[3].map(row => row.name);
assert.deepEqual(triggers, ["admin_audit_no_delete", "admin_audit_no_replace", "admin_audit_no_update", "campaigns_immutable_id", "campaigns_no_delete", "campaigns_no_replace", "campaigns_update_policy", "cases_duplicate_insert", "cases_duplicate_update", "cases_guest_points_insert", "cases_guest_points_update", "points_case_binding", "points_exact_reversal", "points_no_delete", "points_no_replace", "points_no_update",
  "leaderboards_no_replace", "leaderboards_no_delete", "leaderboards_policy", "leaderboards_publish", "leaderboard_runs_no_replace", "leaderboard_runs_no_delete", "leaderboard_runs_update", "leaderboard_results_no_update", "leaderboard_results_no_delete", "leaderboard_results_insert",
  "member_tiers_identity", "member_tiers_no_delete", "member_tiers_no_replace", "member_tiers_order_insert", "member_tiers_order_update"].sort());
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
for (const [from, table] of [["member_id", "members"], ["case_id", "cases"], ["campaign_id", "campaigns"], ["reference_transaction_id", "point_transactions"], ["created_by", "members"]]) assert.ok(rows[11].some(row => row.from === from && row.table === table));
assert.equal(rows[12][0].n, 0);
for (const name of ['idx_leaderboards_public','idx_leaderboards_admin','idx_leaderboard_runs_history']) assert.ok(indexes.includes(name));
assert.ok(rows[13].some(row => row.from === 'current_run_id' && row.table === 'leaderboard_runs'));
assert.ok(rows[13].some(row => row.from === 'campaign_id' && row.table === 'campaigns'));
assert.ok(rows[14].some(row => row.from === 'leaderboard_id' && row.table === 'leaderboards'));
assert.ok(rows[15].some(row => row.from === 'run_id' && row.table === 'leaderboard_runs'));
assert.ok(rows[15].some(row => row.from === 'member_id' && row.table === 'members'));
assert.equal(rows[16][0].n,0);
const tierIds = ['normal','bronze','silver','gold','platinum','emerald','diamond','stellar'];
assert.deepEqual(rows[17].map(row=>row.tier_id),tierIds);
assert.deepEqual(rows[17].map(row=>row.rank_order),[1,2,3,4,5,6,7,8]);
assert.deepEqual(rows[17].map(row=>row.min_points),[0,null,null,null,null,null,null,null]);
assert.deepEqual(rows[17].map(row=>row.status),['active','disabled','disabled','disabled','disabled','disabled','disabled','disabled']);
assert.ok(rows[17].every(row=>row.icon_key===row.tier_id));
for (const from of ['created_by','updated_by']) assert.ok(rows[18].some(row=>row.from===from && row.table==='members'));
assert.ok(rows[19].some(row=>row.name==='login_name'));
assert.ok(!rows[19].some(row=>row.name==='email'));
for(const row of rows.slice(20,25)) assert.ok(row.some(fk=>fk.from==='member_id'&&fk.table==='members'&&fk.to==='member_id'));
assert.equal(rows[25][0].n,0);
for (const name of ['auth_identities','auth_email_challenges','auth_email_sends','auth_enrollments','auth_password_operations']) assert.ok(tables.includes(name));
for (const name of ['idx_enrollment_email','idx_password_operation_pending','idx_email_send_global','idx_email_send_identity','idx_email_send_source','idx_email_challenge_expiry','idx_enrollment_expiry']) assert.ok(indexes.includes(name));
assert.ok(!query('PRAGMA table_info(member_credentials)').some(row=>row.name==='password_record'));
assert.ok(query('PRAGMA foreign_key_list(auth_identities)').some(row=>row.from==='member_id'&&row.table==='members'));
for(const name of ['idx_auth_transactions_expiration','idx_auth_transactions_member','idx_auth_sessions_member','idx_auth_sessions_expiration','idx_trusted_devices_member','idx_recovery_codes_member','idx_auth_rate_expiration','idx_cases_member_cursor'])assert.ok(indexes.includes(name));
console.log(JSON.stringify({ auth_schema:'Supabase/Gmail/TOTP/trust/recovery', result: "PASS", migrations: applied, tables, indexes, triggers, foreign_key_check: "PASS", quick_check: "ok", fixture_rows: 0,
  fixed_tier_identities:8,unapproved_thresholds:7,tier_configuration_ready:false,production_used: false }, null, 2));
