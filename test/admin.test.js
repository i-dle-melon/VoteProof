import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";
import { newCaseId } from "../src/lib/case-keys.js";
import { applyReview, adminCase } from "../src/lib/admin-store.js";
import { reviewInput } from "../src/lib/case-review.js";
import { getAdminCase } from "../src/api/admin.js";

let h, local, reviewer, admin, superAdmin, normal;
before(async () => {
  h = await localAdminRuntime(); local = h.local;
  reviewer = await h.identity({ role: "reviewer" }); admin = await h.identity({ role: "admin" });
  superAdmin = await h.identity({ role: "super_admin" }); normal = await h.identity();
});
after(async () => { await local?.runtime.dispose(); });
const get = (path, actor = reviewer) => local.fetch(path, "GET", undefined, actor.headers);
async function error(response, status, code) {
  assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).error.code, code);
}
const countAudit = async caseId => (await local.db.prepare("SELECT COUNT(*) AS n FROM admin_audit_logs WHERE target_id = ?").bind(caseId).first()).n;
const state = async caseId => local.db.prepare("SELECT * FROM cases WHERE case_id = ?").bind(caseId).first();
const sensitiveFields = ["query_key", "query_key_hash", "object_key", "upload_object_key", "tokenHash", "token_hash", "last_review_id", "email", "upload_session_id"];
function safeJson(data, credentials = []) {
  const text = JSON.stringify(data);
  for (const field of sensitiveFields) assert.ok(!text.includes('"' + field + '"'), field);
  for (const value of [local.authSecret, local.querySecret, ...credentials]) assert.ok(!text.includes(value));
  assert.ok(!/X-Amz-|proofs\//.test(text));
}

test("B5A schema preserves previous migrations and has RBAC, review, immutable audit constraints", async () => {
  const tables = (await local.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map(r => r.name);
  for (const name of ["members", "cases", "case_idempotency", "completed_uploads", "admin_memberships", "admin_audit_logs"]) assert.ok(tables.includes(name));
  const cols = (await local.db.prepare("PRAGMA table_info(cases)").all()).results.map(r => r.name);
  for (const name of ["status_reason", "status_updated_at", "status_updated_by", "duplicate_of_case_id", "version", "reviewer_id", "reviewed_at"]) assert.ok(cols.includes(name));
  assert.deepEqual((await local.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  const triggers = (await local.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).results.map(r => r.name);
  for (const name of ["admin_audit_no_delete", "admin_audit_no_replace", "admin_audit_no_update", "cases_duplicate_insert", "cases_duplicate_update"]) assert.ok(triggers.includes(name));
});

for (const [name, options, status, code] of [
  ["ordinary member", {}, 403, "ADMIN_FORBIDDEN"],
  ["disabled membership", { role: "admin", membershipStatus: "disabled" }, 403, "ADMIN_FORBIDDEN"],
  ["suspended administrator", { role: "super_admin", status: "suspended" }, 403, "MEMBER_SUSPENDED"],
  ["expired session", { role: "admin", expired: true }, 401, "AUTH_REQUIRED"],
  ["revoked session", { role: "admin", revoked: true }, 401, "AUTH_REQUIRED"],
]) test(`admin endpoints deny ${name}`, async () => {
  const actor = await h.identity(options);
  const endpoints = ["/api/admin/me", "/api/admin/cases", "/api/admin/cases/unknown", "/api/admin/cases/unknown/files/unknown", "/api/admin/audit-logs"];
  for (const path of endpoints) await error(await get(path, actor), status, code);
  await error(await h.review(actor, "unknown", "approve"), status, code);
});
test("all admin endpoints deny absent or forged session and client role/member spoofing", async () => {
  for (const path of ["/api/admin/me", "/api/admin/cases", "/api/admin/cases/unknown", "/api/admin/cases/unknown/files/unknown", "/api/admin/audit-logs"]) {
    await error(await local.fetch(path), 401, "AUTH_REQUIRED");
    await error(await local.fetch(path, "GET", undefined, { "X-Role": "super_admin", "X-Member-Id": admin.memberId }), 401, "AUTH_REQUIRED");
  }
  await error(await local.fetch("/api/admin/me", "GET", undefined, { Cookie: "__Host-vp-session=" + normal.token.replace(/^./, normal.token[0] === "A" ? "B" : "A") }), 401, "AUTH_REQUIRED");
  await error(await local.fetch("/api/admin/cases/unknown/review", "POST", { action: "approve" }), 401, "AUTH_REQUIRED");
});
for (const role of ["reviewer", "admin", "super_admin"]) test(`${role} identity is verified server-side without email provider configuration`, async () => {
  const actor = await h.identity({ role });
  const response = await get("/api/admin/me", actor); assert.equal(response.status, 200);
  const data = (await response.json()).data; assert.equal(data.role, role); assert.equal(data.member_id, actor.memberId);
  assert.equal(data.csrf_token, actor.csrf); safeJson(data, [actor.token]);
});
test("admin membership is unique per member and constrained by FK/role/status", async () => {
  const timestamp = new Date().toISOString();
  const statement = () => local.db.prepare("INSERT INTO admin_memberships (id, member_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  await assert.rejects(statement().bind(randomUUID(), admin.memberId, "reviewer", "active", timestamp, timestamp).run());
  await assert.rejects(statement().bind(randomUUID(), "M-" + randomUUID(), "admin", "active", timestamp, timestamp).run());
  for (const [role, status] of [["root", "active"], ["reviewer", "unknown"]]) {
    const member = await h.identity();
    await assert.rejects(statement().bind(randomUUID(), member.memberId, role, status, timestamp, timestamp).run());
  }
});

test("queue puts pending before other statuses and uses stable UUID tie ordering across pages", async () => {
  const campaign = "QUEUE-" + randomUUID(), a = await h.makeCase({ metadata: { campaign_id: campaign } }),
    b = await h.makeCase({ metadata: { campaign_id: campaign } }), c = await h.makeCase({ metadata: { campaign_id: campaign } });
  assert.equal((await h.review(reviewer, a.case_id, "approve")).status, 200);
  await local.db.prepare("UPDATE cases SET created_at = ? WHERE campaign_id = ?").bind("2026-10-01T00:00:00.000Z", campaign).run();
  let cursor = null; const rows = [];
  do {
    const response = await get(`/api/admin/cases?campaign_id=${campaign}&limit=1${cursor ? "&cursor=" + cursor : ""}`);
    assert.equal(response.status, 200); const data = (await response.json()).data; safeJson(data);
    rows.push(...data.cases); cursor = data.next_cursor;
  } while (cursor);
  const orderedPending = [b, c].sort((x, y) => y.id.localeCompare(x.id)).map(x => x.case_id);
  assert.deepEqual(rows.map(r => r.case_id), [...orderedPending, a.case_id]);
  assert.equal(new Set(rows.map(r => r.case_id)).size, 3);
  const repeated = (await (await get(`/api/admin/cases?campaign_id=${campaign}`)).json()).data.cases;
  assert.deepEqual(repeated.map(r => r.case_id), rows.map(r => r.case_id));
});
test("queue supports status, campaign, vote type, duplicate flag and UTC date range filters", async () => {
  const campaign = "FILTER-" + randomUUID();
  const a = await h.makeCase({ metadata: { campaign_id: campaign, vote_type: "團體" } });
  const b = await h.makeCase({ metadata: { campaign_id: campaign, vote_type: "Solo" } });
  assert.equal((await h.review(reviewer, a.case_id, "approve")).status, 200);
  const date = new Date().toISOString().slice(0, 10);
  const query = `campaign_id=${campaign}&status=approved&vote_type=${encodeURIComponent("團體")}&duplicate_flag=0&created_from=${date}&created_to=${date}`;
  const response = await get("/api/admin/cases?" + query); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.cases.map(r => r.case_id), [a.case_id]);
  const empty = (await (await get(`/api/admin/cases?campaign_id=${campaign}&status=revoked`)).json()).data.cases;
  assert.deepEqual(empty, []); assert.ok(b.case_id);
});
for (const query of ["limit=0", "limit=51", "limit=1&limit=2", "cursor=broken", "cursor=" + "a".repeat(1025), "status=other", "campaign_id=%27%20OR%201=1--", "vote_type=other", "duplicate_flag=2", "created_from=2026-02-30", "created_from=2026-10-08&created_to=2026-10-01", "role=super_admin"]) {
  test(`queue rejects malformed input: ${query.slice(0, 55)}`, async () => { await error(await get("/api/admin/cases?" + query), 400, "INVALID_ADMIN_QUERY"); });
}
test("queue cursor cannot silently change filter scope and supports UTF-8 vote type", async () => {
  const campaign = "CURSOR-" + randomUUID();
  await h.makeCase({ metadata: { campaign_id: campaign, vote_type: "團體" } });
  await h.makeCase({ metadata: { campaign_id: campaign, vote_type: "團體" } });
  const base = `/api/admin/cases?campaign_id=${campaign}&vote_type=${encodeURIComponent("團體")}&limit=1`;
  const data = (await (await get(base)).json()).data; assert.ok(data.next_cursor);
  const page = (await (await get(base + "&cursor=" + data.next_cursor)).json()).data;
  assert.equal(page.cases.length, 1); assert.notEqual(page.cases[0].case_id, data.cases[0].case_id);
  await error(await get(`/api/admin/cases?cursor=${data.next_cursor}`), 400, "INVALID_ADMIN_QUERY");
});

test("review approve records actor, optimistic version, safe audit and preserves Guest contract and points", async () => {
  const fixture = await h.makeCase();
  const response = await h.review(reviewer, fixture.case_id, "approve", 0, { reason: "已核對" }); assert.equal(response.status, 200);
  const data = (await response.json()).data; safeJson(data, [fixture.query_key, reviewer.token]);
  assert.equal(data.status, "approved"); assert.equal(data.version, 1);
  const row = await state(fixture.case_id); assert.equal(row.reviewer_id, reviewer.memberId); assert.equal(row.status_updated_by, reviewer.memberId);
  assert.equal(row.points_awarded, 0); assert.equal(row.status_reason, "已核對"); assert.ok(row.reviewed_at);
  const audit = await local.db.prepare("SELECT * FROM admin_audit_logs WHERE target_id = ?").bind(fixture.case_id).first();
  assert.equal(audit.admin_role, "reviewer"); assert.equal(audit.admin_member_id, reviewer.memberId); assert.equal(audit.action, "approve");
  assert.deepEqual(JSON.parse(audit.before_json), { status: "pending", version: 0, duplicate_of_case_id: null, points_awarded: 0, point_status: null });
  assert.equal(JSON.parse(audit.after_json).status, "approved"); safeJson(audit, [fixture.query_key, reviewer.token]);
  const guest = await local.fetch(`/api/cases/${fixture.case_id}?key=${fixture.query_key}`); assert.equal(guest.status, 200);
  const guestData = (await guest.json()).data; assert.equal(guestData.status, "approved"); safeJson(guestData);
  for (const name of ["version", "reviewer_id", "status_reason", "status_updated_by", "duplicate_of_case_id"]) assert.ok(!Object.hasOwn(guestData, name));
});
test("reject is pending-only and requires a reason", async () => {
  const fixture = await h.makeCase();
  await error(await h.review(reviewer, fixture.case_id, "reject"), 400, "INVALID_REVIEW_REQUEST");
  const response = await h.review(reviewer, fixture.case_id, "reject", 0, { reason: "票據不完整" }); assert.equal(response.status, 200);
  assert.equal((await state(fixture.case_id)).status, "rejected");
  await error(await h.review(admin, fixture.case_id, "approve", 1), 409, "CASE_STATUS_CONFLICT");
});
test("duplicate uses an existing approved canonical case and keeps flag/reference/audit consistent", async () => {
  const target = await h.makeCase(), duplicate = await h.makeCase(); await h.review(reviewer, target.case_id, "approve");
  const response = await h.review(reviewer, duplicate.case_id, "mark_duplicate", 0, { reason: "相同票據", duplicate_of_case_id: target.case_id });
  assert.equal(response.status, 200); const data = (await response.json()).data; assert.equal(data.duplicate_of_case_id, target.case_id);
  const row = await state(duplicate.case_id); assert.equal(row.duplicate_flag, 1); assert.equal(row.duplicate_of_case_id, target.id);
  assert.equal(await countAudit(duplicate.case_id), 1);
  const filter = (await (await get(`/api/admin/cases?duplicate_flag=1`)).json()).data.cases;
  assert.ok(filter.some(c => c.case_id === duplicate.case_id));
});
test("duplicate rejects missing target, self, nonexistent, pending and already duplicate references", async () => {
  const fixture = await h.makeCase(), pending = await h.makeCase(), canonical = await h.makeCase(), duplicate = await h.makeCase();
  await h.review(reviewer, canonical.case_id, "approve");
  await h.review(reviewer, duplicate.case_id, "mark_duplicate", 0, { reason: "重複", duplicate_of_case_id: canonical.case_id });
  for (const target of [undefined, fixture.case_id, newCaseId(), pending.case_id, duplicate.case_id]) {
    await error(await h.review(reviewer, fixture.case_id, "mark_duplicate", 0, { reason: "重複", ...(target ? { duplicate_of_case_id: target } : {}) }), 400, "INVALID_DUPLICATE_TARGET");
  }
  assert.equal((await state(fixture.case_id)).status, "pending"); assert.equal(await countAudit(fixture.case_id), 0);
});
test("database rejects inconsistent duplicate fields and self references", async () => {
  const fixture = await h.makeCase();
  await assert.rejects(local.db.prepare("UPDATE cases SET duplicate_flag = 1 WHERE id = ?").bind(fixture.id).run());
  await assert.rejects(local.db.prepare("UPDATE cases SET status = 'duplicate', duplicate_flag = 1, duplicate_of_case_id = id WHERE id = ?").bind(fixture.id).run());
  assert.deepEqual((await local.db.prepare("PRAGMA foreign_key_check").all()).results, []);
});
test("reviewer cannot complete or revoke; administrator supports approved→completed→revoked", async () => {
  const fixture = await h.makeCase(); await h.review(reviewer, fixture.case_id, "approve");
  await error(await h.review(reviewer, fixture.case_id, "complete", 1), 403, "ADMIN_FORBIDDEN");
  assert.equal((await h.review(admin, fixture.case_id, "complete", 1)).status, 200);
  await error(await h.review(reviewer, fixture.case_id, "revoke", 2, { reason: "需撤銷" }), 403, "ADMIN_FORBIDDEN");
  assert.equal((await h.review(superAdmin, fixture.case_id, "revoke", 2, { reason: "已確認無效" })).status, 200);
  assert.equal((await state(fixture.case_id)).status, "revoked"); assert.equal((await state(fixture.case_id)).points_awarded, 0);
  await error(await h.review(admin, fixture.case_id, "approve", 3), 409, "CASE_STATUS_CONFLICT");
});
test("administrator can revoke approved cases directly", async () => {
  const fixture = await h.makeCase(); await h.review(reviewer, fixture.case_id, "approve");
  assert.equal((await h.review(admin, fixture.case_id, "revoke", 1, { reason: "資料無效" })).status, 200);
});
test("invalid transitions and stale version return 409 without extra audit", async () => {
  const fixture = await h.makeCase();
  await error(await h.review(admin, fixture.case_id, "complete"), 409, "CASE_STATUS_CONFLICT");
  await error(await h.review(reviewer, fixture.case_id, "approve", 1), 409, "CASE_STATUS_CONFLICT");
  await h.review(reviewer, fixture.case_id, "approve");
  await error(await h.review(reviewer, fixture.case_id, "reject", 0, { reason: "過期" }), 409, "CASE_STATUS_CONFLICT");
  assert.equal(await countAudit(fixture.case_id), 1);
});
test("simultaneous approve/reject has one winner, one 409, one revision and one audit", async () => {
  const fixture = await h.makeCase(), other = await h.identity({ role: "reviewer" });
  const responses = await Promise.all([h.review(reviewer, fixture.case_id, "approve"), h.review(other, fixture.case_id, "reject", 0, { reason: "不同判斷" })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const row = await state(fixture.case_id); assert.equal(row.version, 1); assert.equal(await countAudit(fixture.case_id), 1);
  const winner = responses[0].status === 200 ? reviewer : other; assert.equal(row.reviewer_id, winner.memberId);
});
test("audit insert failure rolls back the case mutation atomically without internal errors", async () => {
  const fixture = await h.makeCase();
  await local.db.prepare("CREATE TRIGGER local_test_audit_fail BEFORE INSERT ON admin_audit_logs BEGIN SELECT RAISE(ABORT, 'local test storage failure'); END").run();
  try {
    const response = await h.review(reviewer, fixture.case_id, "approve"); await error(response, 503, "ADMIN_SERVICE_UNAVAILABLE");
    assert.equal((await state(fixture.case_id)).version, 0); assert.equal((await state(fixture.case_id)).status, "pending");
    assert.equal(await countAudit(fixture.case_id), 0);
  } finally { await local.db.prepare("DROP TRIGGER local_test_audit_fail").run(); }
});
for (const change of ["disabled", "suspended", "revoked", "role"]) test(`review transaction rejects authorization changed after identity read: ${change}`, async () => {
  const actor = await h.identity({ role: "admin" }), fixture = await h.makeCase();
  const row = await adminCase(local.db, fixture.case_id);
  if (change === "disabled") await local.db.prepare("UPDATE admin_memberships SET status = 'disabled' WHERE member_id = ?").bind(actor.memberId).run();
  if (change === "suspended") await local.db.prepare("UPDATE members SET status = 'suspended' WHERE member_id = ?").bind(actor.memberId).run();
  if (change === "revoked") await local.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?").bind(Math.floor(Date.now() / 1000), actor.hash).run();
  if (change === "role") await local.db.prepare("UPDATE admin_memberships SET role = 'reviewer' WHERE member_id = ?").bind(actor.memberId).run();
  await assert.rejects(applyReview(local.db, { role: "admin", member: { member_id: actor.memberId, tokenHash: actor.hash } }, row,
    reviewInput({ action: "approve", expected_version: 0 }, "admin")), e => e.code === "CASE_STATUS_CONFLICT");
  assert.equal(await countAudit(fixture.case_id), 0); assert.equal((await state(fixture.case_id)).version, 0);
});

for (const [name, patch] of [["missing Origin", { Origin: undefined }], ["foreign Origin", { Origin: "https://other.example" }],
  ["missing CSRF", { "X-CSRF-Token": undefined }], ["wrong CSRF", { "X-CSRF-Token": "f".repeat(64) }], ["cross-site", { "Sec-Fetch-Site": "cross-site" }]]) {
  test(`review CSRF rejects ${name}`, async () => {
    const fixture = await h.makeCase(), headers = { ...reviewer.headers, ...patch };
    for (const [key, value] of Object.entries(headers)) if (value === undefined) delete headers[key];
    await error(await local.fetch(`/api/admin/cases/${fixture.case_id}/review`, "POST", { action: "approve", expected_version: 0 }, headers), 403, "CSRF_REJECTED");
    assert.equal(await countAudit(fixture.case_id), 0);
  });
}
for (const body of [{ action: "approve" }, { action: "approve", expected_version: -1 }, { action: "approve", expected_version: 0.5 },
  { action: "unknown", expected_version: 0 }, { action: "approve", expected_version: 0, member_id: "forged" },
  { action: "approve", expected_version: 0, role: "super_admin" }, { action: "approve", expected_version: 0, status: "completed" },
  { action: "approve", expected_version: 0, reason: "a".repeat(501) }, { action: "reject", expected_version: 0, reason: "\n" },
  { action: "approve", expected_version: 0, duplicate_of_case_id: "wrong" }]) {
  test(`review rejects unknown fields or invalid action/version/reason: ${Object.keys(body).join("/")}/${JSON.stringify(body).length}`, async () => {
    const fixture = await h.makeCase();
    await error(await local.fetch(`/api/admin/cases/${fixture.case_id}/review`, "POST", body, reviewer.headers), 400, "INVALID_REVIEW_REQUEST");
  });
}
test("review body is bounded, JSON only, and nonexistent cases do not leak metadata", async () => {
  const fixture = await h.makeCase(), path = `/api/admin/cases/${fixture.case_id}/review`;
  await error(await local.fetch(path, "POST", "{", reviewer.headers), 400, "INVALID_JSON");
  await error(await local.fetch(path, "POST", "a".repeat(17000), reviewer.headers), 413, "INVALID_REVIEW_REQUEST");
  await error(await local.fetch(path, "POST", {}, { ...reviewer.headers, "Content-Type": "text/plain" }), 400, "INVALID_JSON");
  await error(await h.review(reviewer, newCaseId(), "approve"), 404, "CASE_NOT_FOUND");
  await error(await get("/api/admin/cases/invalid"), 404, "CASE_NOT_FOUND");
});

test("detail returns review metadata and file IDs without any private keys or identity credentials", async () => {
  const fixture = await h.makeCase({ member: normal, metadata: { note: "本機票據" } });
  const response = await get(`/api/admin/cases/${fixture.case_id}`); assert.equal(response.status, 200);
  const data = (await response.json()).data; safeJson(data, [fixture.query_key, normal.token]);
  assert.equal(data.member_id, normal.memberId); assert.equal(data.note, "本機票據");
  assert.equal(data.files.length, 1); assert.equal(data.files[0].content_type, "image/png"); assert.equal(data.version, 0);
  assert.ok(data.files[0].file_id); assert.equal(data.id, undefined);
});
test("authorized reviewer streams only that case's private raster proof without public URL/cache", async () => {
  const fixture = await h.makeCase(); const row = await local.db.prepare("SELECT id, object_key FROM case_files WHERE case_id = ?").bind(fixture.id).first();
  const response = await get(`/api/admin/cases/${fixture.case_id}/files/${row.id}`); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(response.headers.get("location"), null); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  await error(await get(`/api/admin/cases/${fixture.case_id}/files/${row.id}`, normal), 403, "ADMIN_FORBIDDEN");
  await error(await local.fetch(`/api/admin/cases/${fixture.case_id}/files/${row.id}`), 401, "AUTH_REQUIRED");
  assert.equal((await local.fetch("/api/" + row.object_key)).status, 404);
});
test("proof endpoint rejects wrong case/file relationship, missing R2 object and invalid IDs", async () => {
  const a = await h.makeCase(), b = await h.makeCase();
  const file = await local.db.prepare("SELECT id, object_key FROM case_files WHERE case_id = ?").bind(a.id).first();
  await error(await get(`/api/admin/cases/${b.case_id}/files/${file.id}`), 404, "PROOF_NOT_FOUND");
  await error(await get(`/api/admin/cases/${a.case_id}/files/${randomUUID()}`), 404, "PROOF_NOT_FOUND");
  await error(await get(`/api/admin/cases/${a.case_id}/files/not-a-uuid`), 404, "PROOF_NOT_FOUND");
  await local.bucket.delete(file.object_key);
  await error(await get(`/api/admin/cases/${a.case_id}/files/${file.id}`), 404, "PROOF_NOT_FOUND");
});
test("proof streaming rejects R2 metadata/body tampering instead of returning untrusted content", async () => {
  const fixture = await h.makeCase(), file = await local.db.prepare("SELECT id, object_key FROM case_files WHERE case_id = ?").bind(fixture.id).first();
  await local.bucket.put(file.object_key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/svg+xml" } });
  await error(await get(`/api/admin/cases/${fixture.case_id}/files/${file.id}`), 409, "PROOF_INTEGRITY_ERROR");
});

test("reviewer cannot read audit, admin/super_admin can filter safe append-only records", async () => {
  const fixture = await h.makeCase(); await h.review(reviewer, fixture.case_id, "approve");
  await error(await get("/api/admin/audit-logs"), 403, "ADMIN_FORBIDDEN");
  for (const actor of [admin, superAdmin]) {
    const response = await get(`/api/admin/audit-logs?action=approve&target_type=case&target_id=${fixture.case_id}&admin_member_id=${reviewer.memberId}`, actor);
    assert.equal(response.status, 200); const data = (await response.json()).data; assert.equal(data.logs.length, 1); safeJson(data, [fixture.query_key, reviewer.token]);
    assert.equal(data.logs[0].before.status, "pending"); assert.equal(data.logs[0].after.status, "approved");
  }
});
test("audit pagination is stable and API supplies no mutation/delete route", async () => {
  const fixture = await h.makeCase(); await h.review(reviewer, fixture.case_id, "approve"); await h.review(admin, fixture.case_id, "complete", 1);
  const base = `/api/admin/audit-logs?target_id=${fixture.case_id}&limit=1`;
  const a = (await (await get(base, admin)).json()).data; assert.equal(a.logs.length, 1); assert.ok(a.next_cursor);
  const b = (await (await get(base + "&cursor=" + a.next_cursor, admin)).json()).data; assert.equal(b.logs.length, 1);
  assert.notEqual(a.logs[0].id, b.logs[0].id); assert.equal(b.next_cursor, null);
  for (const method of ["POST", "PATCH", "DELETE"]) await error(await local.fetch("/api/admin/audit-logs", method, {}, admin.headers), 405, "METHOD_NOT_ALLOWED");
  await error(await local.fetch("/api/admin/audit-logs/" + a.logs[0].id, "DELETE", undefined, admin.headers), 404, "NOT_FOUND");
  await assert.rejects(local.db.prepare("UPDATE admin_audit_logs SET reason = 'changed' WHERE id = ?").bind(a.logs[0].id).run());
  await assert.rejects(local.db.prepare("DELETE FROM admin_audit_logs WHERE id = ?").bind(a.logs[0].id).run());
});
test("append-only audit rejects INSERT OR REPLACE through either primary ID or target/version", async () => {
  const fixture = await h.makeCase(); await h.review(reviewer, fixture.case_id, "approve");
  const record = await local.db.prepare("SELECT * FROM admin_audit_logs WHERE target_id = ?").bind(fixture.case_id).first();
  for (const id of [record.id, randomUUID()]) {
    await assert.rejects(local.db.prepare(`INSERT OR REPLACE INTO admin_audit_logs
      (id, created_at, admin_member_id, admin_role, action, target_type, target_id, target_version, before_json, after_json, reason)
      SELECT ?, created_at, admin_member_id, admin_role, action, target_type, target_id, target_version, before_json, after_json, 'changed'
      FROM admin_audit_logs WHERE id = ?`).bind(id, record.id).run());
  }
  assert.deepEqual(await local.db.prepare("SELECT * FROM admin_audit_logs WHERE id = ?").bind(record.id).first(), record);
});
test("unexpected storage exceptions never leak request/env credentials to JSON or console", async () => {
  const logged = [], original = { log: console.log, warn: console.warn, error: console.error };
  const sensitive = randomUUID(), db = {
    batch() {},
    prepare(sql) {
      if (sql.includes("JOIN members m")) return { bind: () => ({ first: async () => ({ member_id: reviewer.memberId, status: "active" }) }) };
      if (sql.includes("FROM admin_memberships")) return { bind: () => ({ first: async () => ({ role: "reviewer" }) }) };
      throw new Error(sensitive + " " + reviewer.token + " " + local.authSecret);
    },
  };
  try {
    for (const name of Object.keys(original)) console[name] = (...args) => logged.push(args);
    const url = new URL("https://voteproof.example/api/admin/cases/" + newCaseId());
    const response = await getAdminCase({ DB: db, AUTH_SECRET: local.authSecret }, url, new Request(url, { headers: reviewer.headers }));
    assert.equal(response.status, 503); const text = await response.text();
    for (const value of [sensitive, reviewer.token, local.authSecret]) assert.ok(!text.includes(value));
    assert.equal(JSON.parse(text).error.code, "ADMIN_SERVICE_UNAVAILABLE"); assert.deepEqual(logged, []);
  } finally { Object.assign(console, original); }
});
for (const query of ["action=bad", "target_type=bad", "admin_member_id=bad", "target_id=%27OR1=1", "cursor=bad", "role=admin"]) {
  test(`audit rejects malformed filters: ${query}`, async () => { await error(await get("/api/admin/audit-logs?" + query, admin), 400, "INVALID_ADMIN_QUERY"); });
}
test("Guest query protection and Member owner queries retain B3/B4 behavior after review", async () => {
  const fixture = await h.makeCase({ member: normal }); await h.review(reviewer, fixture.case_id, "approve");
  assert.equal((await get(`/api/me/cases/${fixture.case_id}`, normal)).status, 200);
  await error(await get(`/api/me/cases/${fixture.case_id}`, admin), 404, "CASE_NOT_FOUND");
  const list = (await (await get("/api/me/cases", normal)).json()).data.cases; assert.ok(list.some(c => c.case_id === fixture.case_id));
  const replay = await local.fetch("/api/cases", "POST", fixture.body, fixture.headers); assert.equal(replay.status, 201);
  const data = (await replay.json()).data; assert.equal(data.case_id, fixture.case_id); assert.equal(data.query_key, fixture.query_key);
  await error(await local.fetch(`/api/cases/${fixture.case_id}`), 404, "CASE_NOT_FOUND");
  await error(await local.fetch(`/api/cases/${fixture.case_id}?key=${"A".repeat(43)}`), 404, "CASE_NOT_FOUND");
});
test("admin unknown API/methods retain 404/405 and B5A fixtures send no email", async () => {
  await error(await local.fetch("/api/admin/unknown"), 404, "NOT_FOUND");
  await error(await local.fetch("/api/unknown"), 404, "NOT_FOUND");
  await error(await local.fetch("/api/admin/me", "POST", {}, reviewer.headers), 405, "METHOD_NOT_ALLOWED");
  assert.equal(local.emails.length, 0);
  assert.equal((await local.fetch("/api/health")).status, 200);
  assert.equal((await local.fetch("/api/campaigns")).status, 200);
});
