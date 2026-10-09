import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";
import { localCaseRuntime, guestBody } from "../scripts/lib/local-case-runtime.mjs";
import { campaignInput } from "../src/lib/campaign-policy.js";
import { createCase } from "../src/api/cases.js";
import worker from "../src/index.js";
import { applyReview, adminCase } from "../src/lib/admin-store.js";
import { reviewInput } from "../src/lib/case-review.js";
import { adjustPoints, adjustmentIdentity } from "../src/lib/point-ledger.js";

let h, local, admin, reviewer, superAdmin;
before(async () => { h = await localAdminRuntime(); local = h.local; admin = await h.identity({ role: "admin" });
  reviewer = await h.identity({ role: "reviewer" }); superAdmin = await h.identity({ role: "super_admin" }); });
after(async () => { await local?.runtime.dispose(); });
export const campaignBody = (extra = {}) => ({ campaign_id: "C-" + randomUUID(), name: "本機活動", category: "投票",
  start_at: "2000-01-01T00:00:00.000Z", end_at: "2100-01-01T00:00:00.000Z", campaign_timezone: "UTC",
  points_per_proof: 10, daily_limit: 3, status: "active", ...extra });
const get = (path, actor = admin) => local.fetch(path, "GET", undefined, actor.headers);
async function error(response, status, code) { assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
  const json = await response.json(); assert.equal(json.error.code, code); return json; }
async function campaign(extra = {}) { const body = campaignBody(extra), response = await local.fetch("/api/admin/campaigns", "POST", body, admin.headers);
  assert.equal(response.status, 201); return (await response.json()).data; }
function updateBody(row, extra = {}) { return { ...Object.fromEntries(["name", "category", "start_at", "end_at", "campaign_timezone", "points_per_proof", "daily_limit", "status", "note"].map(k => [k, row[k]])), expected_version: row.version, ...extra }; }
const update = (row, extra = {}, actor = admin) => local.fetch(`/api/admin/campaigns/${row.campaign_id}/update`, "POST", updateBody(row, extra), actor.headers);
const ledger = async id => (await local.db.prepare("SELECT * FROM point_transactions WHERE case_id = ? ORDER BY created_at, transaction_id").bind(id).all()).results;
const caseState = async id => local.db.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first();
const memberTotal = async member => (await (await get("/api/me/points", member)).json()).data.total_points;
async function make(c, member, metadata = {}) { return h.makeCase({ member, metadata: { campaign_id: c.campaign_id, ...metadata } }); }
const adjustment = (actor, member, points, key = randomUUID(), reason = "本機調整") => local.fetch("/api/admin/points/adjustments", "POST",
  { member_id: member.memberId, points, reason }, { ...actor.headers, "Idempotency-Key": key });

test("Campaign create persists validated fields, actor/version and safe audit atomically", async () => {
  const c = await campaign(); assert.equal(c.version, 0); assert.equal(c.created_by, admin.memberId); assert.equal(c.updated_by, admin.memberId);
  assert.equal(c.last_mutation_id, undefined); assert.equal(c.vote_end_date, "2099-12-31");
  const audit = await local.db.prepare("SELECT * FROM admin_audit_logs WHERE target_type = 'campaign' AND target_id = ?").bind(c.campaign_id).first();
  assert.equal(audit.action, "campaign_create"); assert.deepEqual(JSON.parse(audit.before_json), {});
  assert.equal(JSON.parse(audit.after_json).points_per_proof, 10); assert.equal(audit.admin_member_id, admin.memberId);
});
for (const [name, changes] of [
  ["invalid id", { campaign_id: "../campaign" }], ["long id", { campaign_id: "a".repeat(101) }], ["invalid name", { name: "" }],
  ["category too long", { category: "a".repeat(51) }], ["invalid instant", { start_at: "2026-02-30T00:00:00.000Z" }],
  ["equal dates", { end_at: "2000-01-01T00:00:00.000Z" }], ["reverse dates", { start_at: "2101-01-01T00:00:00.000Z" }],
  ["negative points", { points_per_proof: -1 }], ["fractional points", { points_per_proof: 1.5 }], ["numeric string points", { points_per_proof: "10" }],
  ["points too high", { points_per_proof: 1000001 }], ["negative limit", { daily_limit: -1 }], ["fractional limit", { daily_limit: 1.5 }],
  ["limit too high", { daily_limit: 1001 }], ["null limit", { daily_limit: null }], ["invalid timezone", { campaign_timezone: "Invalid/Zone" }],
  ["invalid status", { status: "open" }], ["closed creation", { status: "closed" }], ["extra actor", { created_by: "forged" }],
  ["control character", { note: "bad\n" }],
]) test(`Campaign validation rejects ${name}`, async () => {
  await error(await local.fetch("/api/admin/campaigns", "POST", campaignBody(changes), admin.headers), 400, "INVALID_CAMPAIGN_REQUEST");
});
test("Campaign create/update are elevated-only; reviewer can read metadata", async () => {
  const c = await campaign(), normal = await h.identity();
  assert.equal((await get(`/api/admin/campaigns/${c.campaign_id}`, reviewer)).status, 200);
  assert.equal((await get("/api/admin/campaigns", reviewer)).status, 200);
  await error(await local.fetch("/api/admin/campaigns", "POST", campaignBody(), reviewer.headers), 403, "ADMIN_FORBIDDEN");
  await error(await update(c, { name: "changed" }, reviewer), 403, "ADMIN_FORBIDDEN");
  await error(await get("/api/admin/campaigns", normal), 403, "ADMIN_FORBIDDEN");
  await error(await local.fetch("/api/admin/campaigns"), 401, "AUTH_REQUIRED");
  assert.equal((await update(c, { name: "super admin update" }, superAdmin)).status, 200);
});
test("Campaign optimistic update returns conflict instead of overwriting; duplicate create rejects", async () => {
  const c = await campaign(); const responses = await Promise.all([update(c, { name: "A" }), update(c, { name: "B" })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const row = (await (await get(`/api/admin/campaigns/${c.campaign_id}`)).json()).data; assert.equal(row.version, 1);
  await error(await update(c), 409, "CAMPAIGN_CONFLICT");
  await error(await local.fetch("/api/admin/campaigns", "POST", campaignBody({ campaign_id: c.campaign_id }), admin.headers), 409, "CAMPAIGN_EXISTS");
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM admin_audit_logs WHERE target_id = ?").bind(c.campaign_id).first()).n, 2);
});
test("Campaign state machine freezes active dates, disallows reopen, and archived rows are immutable", async () => {
  let c = await campaign({ status: "draft" });
  c = (await (await update(c, { name: "draft edit" })).json()).data;
  c = (await (await update(c, { status: "active" })).json()).data;
  await error(await update(c, { start_at: "2001-01-01T00:00:00.000Z" }), 409, "CAMPAIGN_CONFLICT");
  await error(await update(c, { campaign_timezone: "Asia/Taipei" }), 409, "CAMPAIGN_CONFLICT");
  await error(await update(c, { status: "draft" }), 409, "CAMPAIGN_CONFLICT");
  c = (await (await update(c, { status: "closed" })).json()).data;
  await error(await update(c, { status: "active" }), 409, "CAMPAIGN_CONFLICT");
  c = (await (await update(c, { status: "archived" })).json()).data;
  await error(await update(c, { name: "archived edit" }), 409, "CAMPAIGN_CONFLICT");
  await assert.rejects(local.db.prepare("UPDATE campaigns SET campaign_id = ? WHERE campaign_id = ?").bind("NEW-" + randomUUID(), c.campaign_id).run());
  await assert.rejects(local.db.prepare("DELETE FROM campaigns WHERE campaign_id = ?").bind(c.campaign_id).run());
});
test("Public campaigns expose only active current windows and safe fields; empty registry is []", async () => {
  const empty = await localCaseRuntime({ seedCampaign: false });
  try { assert.deepEqual(await (await empty.fetch("/api/campaigns")).json(), { ok: true, data: { campaigns: [] } }); } finally { await empty.runtime.dispose(); }
  const active = await campaign(), draft = await campaign({ status: "draft" }), future = await campaign({ start_at: "2090-01-01T00:00:00.000Z" }),
    past = await campaign({ end_at: "2001-01-01T00:00:00.000Z" });
  const closed = await campaign(); await update(closed, { status: "closed" });
  const response = await local.fetch("/api/campaigns"); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const rows = (await response.json()).data.campaigns; assert.ok(rows.some(r => r.campaign_id === active.campaign_id));
  for (const c of [draft, future, past, closed]) assert.ok(!rows.some(r => r.campaign_id === c.campaign_id));
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["campaign_id", "name", "category", "start_at", "end_at", "campaign_timezone", "vote_start_date", "vote_end_date", "points_per_proof", "daily_limit", "status"].sort());
  await error(await worker.fetch(new Request("https://voteproof.example/api/campaigns"), {}), 503, "DB_NOT_CONFIGURED");
});
test("Campaign admin pagination has stable ordering, status filtering and bound cursor scope", async () => {
  await campaign({ status: "draft" }); await campaign({ status: "draft" });
  const first = (await (await get("/api/admin/campaigns?status=draft&limit=1")).json()).data;
  assert.equal(first.campaigns.length, 1); assert.ok(first.next_cursor);
  const next = (await (await get("/api/admin/campaigns?status=draft&limit=1&cursor=" + first.next_cursor)).json()).data;
  assert.notEqual(next.campaigns[0].campaign_id, first.campaigns[0].campaign_id);
  await error(await get("/api/admin/campaigns?cursor=" + first.next_cursor), 400, "INVALID_ADMIN_QUERY");
  for (const query of ["limit=0", "limit=51", "status=bad", "cursor=bad", "member_id=forged", "limit=1&limit=2"]) await error(await get("/api/admin/campaigns?" + query), 400, "INVALID_ADMIN_QUERY");
});
test("Campaign timezone uses local calendar overlap with exclusive end instant, never client timezone", () => {
  const taiwan = campaignInput(campaignBody({ start_at: "2026-10-08T16:00:00.000Z", end_at: "2026-10-09T16:00:00.000Z", campaign_timezone: "Asia/Taipei" }));
  assert.equal(taiwan.vote_start_date, "2026-10-09"); assert.equal(taiwan.vote_end_date, "2026-10-09");
  const la = campaignInput(campaignBody({ start_at: "2026-10-09T00:00:00.000Z", end_at: "2026-10-10T00:00:00.000Z", campaign_timezone: "America/Los_Angeles" }));
  assert.equal(la.vote_start_date, "2026-10-08"); assert.equal(la.vote_end_date, "2026-10-09");
  const dst = campaignInput(campaignBody({ start_at: "2026-03-08T08:00:00.000Z", end_at: "2026-03-09T07:00:00.000Z", campaign_timezone: "America/Los_Angeles" }));
  assert.equal(dst.vote_start_date, "2026-03-08"); assert.equal(dst.vote_end_date, "2026-03-08");
});
test("Case creation rejects nonexistent/draft/archived/closed/outside window Campaigns without consuming uploads", async () => {
  const draft = await campaign({ status: "draft" }), closed = await campaign(), archived = await campaign({ status: "draft" });
  await update(closed, { status: "closed" }); await update(archived, { status: "archived" });
  const reference = await local.upload();
  for (const [id, code] of [["MISSING-" + randomUUID(), "CAMPAIGN_NOT_FOUND"], [draft.campaign_id, "CAMPAIGN_NOT_OPEN"], [closed.campaign_id, "CAMPAIGN_NOT_OPEN"], [archived.campaign_id, "CAMPAIGN_NOT_OPEN"]]) {
    await error(await local.fetch("/api/cases", "POST", { ...guestBody(reference), campaign_id: id }), 400, code);
  }
  const today = new Date().toISOString().slice(0, 10), c = await campaign({ start_at: today + "T00:00:00.000Z" });
  await error(await local.fetch("/api/cases", "POST", { ...guestBody(reference), campaign_id: c.campaign_id,
    vote_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10) }), 400, "VOTE_DATE_OUTSIDE_CAMPAIGN");
  assert.equal((await local.db.prepare("SELECT consumed_case_id FROM completed_uploads WHERE session_id = ?").bind(reference.session_id).first()).consumed_case_id, null);
});
test("Campaign close during R2 copy prevents case creation and compensates private copies", async () => {
  const c = await campaign(), reference = await local.upload();
  const bucket = { get: local.bucket.get.bind(local.bucket), delete: local.bucket.delete.bind(local.bucket),
    async put(...args) { const result = await local.bucket.put(...args); await local.db.prepare("UPDATE campaigns SET status = 'closed', version = version + 1 WHERE campaign_id = ?").bind(c.campaign_id).run(); return result; } };
  const request = new Request("https://voteproof.example/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...guestBody(reference), campaign_id: c.campaign_id }) });
  const before = (await local.bucket.list({ prefix: "proofs/cases/" })).objects.length;
  await error(await createCase({ DB: local.db, PROOFS_BUCKET: bucket }, null, request), 400, "CAMPAIGN_NOT_OPEN");
  assert.equal((await local.bucket.list({ prefix: "proofs/cases/" })).objects.length, before);
});

test("Guest approval/completion/revocation never creates member points and DB rejects Guest points", async () => {
  const c = await campaign(), fixture = await make(c);
  assert.equal((await h.review(reviewer, fixture.case_id, "approve")).status, 200);
  let row = await caseState(fixture.id); assert.equal(row.points_awarded, 0); assert.equal(row.point_status, "guest_no_points");
  assert.equal((await h.review(admin, fixture.case_id, "complete", 1)).status, 200);
  assert.equal((await h.review(admin, fixture.case_id, "revoke", 2, { reason: "撤銷驗收" })).status, 200);
  row = await caseState(fixture.id); assert.equal(row.points_awarded, 0); assert.deepEqual(await ledger(fixture.id), []);
  await assert.rejects(local.db.prepare("UPDATE cases SET points_awarded = 10 WHERE id = ?").bind(fixture.id).run());
});
test("Member approval appends actual award and audit; completion cannot double-award", async () => {
  const member = await h.identity(), c = await campaign({ points_per_proof: 17 }), fixture = await make(c, member);
  const response = await h.review(reviewer, fixture.case_id, "approve"); assert.equal(response.status, 200);
  const row = await caseState(fixture.id); assert.equal(row.points_awarded, 17); assert.equal(row.point_status, "awarded");
  const transactions = await ledger(fixture.id); assert.equal(transactions.length, 1); assert.equal(transactions[0].points, 17);
  assert.equal(transactions[0].member_id, member.memberId); assert.equal(transactions[0].created_by, reviewer.memberId);
  assert.equal(row.point_transaction_id, transactions[0].transaction_id); assert.equal(transactions[0].category, "proof_approved");
  const audit = await local.db.prepare("SELECT after_json FROM admin_audit_logs WHERE target_id = ?").bind(fixture.case_id).first();
  assert.equal(JSON.parse(audit.after_json).points_awarded, 17); assert.equal(JSON.parse(audit.after_json).transaction_id, transactions[0].transaction_id);
  assert.equal((await h.review(admin, fixture.case_id, "complete", 1)).status, 200); assert.equal((await ledger(fixture.id)).length, 1);
  assert.equal(await memberTotal(member), 17);
});
test("Daily limit counts rewarded cases per member/campaign/vote_date, not files or review dates", async () => {
  const c = await campaign({ daily_limit: 2 }), member = await h.identity();
  const fixtures = []; for (let i = 0; i < 3; i++) { const f = await make(c, member); fixtures.push(f); assert.equal((await h.review(reviewer, f.case_id, "approve")).status, 200); }
  assert.deepEqual(await Promise.all(fixtures.map(async f => (await caseState(f.id)).points_awarded)), [10, 10, 0]);
  assert.equal((await caseState(fixtures[2].id)).point_status, "daily_limit"); assert.deepEqual(await ledger(fixtures[2].id), []);
  const previous = await make(c, member, { vote_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
  await h.review(reviewer, previous.case_id, "approve"); assert.equal((await caseState(previous.id)).points_awarded, 10);
  assert.equal(await memberTotal(member), 30);
  const other = await h.identity(), f = await make(c, other); await h.review(reviewer, f.case_id, "approve"); assert.equal((await caseState(f.id)).points_awarded, 10);
  const otherCampaign = await campaign({ daily_limit: 1 }), g = await make(otherCampaign, member); await h.review(reviewer, g.case_id, "approve"); assert.equal((await caseState(g.id)).points_awarded, 10);
});
test("Zero-value Campaign and daily_limit=0 approve successfully with explicit zero-point reasons", async () => {
  const member = await h.identity();
  for (const [changes, status] of [[{ points_per_proof: 0 }, "zero_value_campaign"], [{ daily_limit: 0 }, "daily_limit"]]) {
    const c = await campaign(changes), f = await make(c, member); assert.equal((await h.review(reviewer, f.case_id, "approve")).status, 200);
    assert.equal((await caseState(f.id)).point_status, status); assert.equal((await caseState(f.id)).points_awarded, 0);
    assert.equal((await h.review(admin, f.case_id, "revoke", 1, { reason: "零分撤銷" })).status, 200);
    assert.deepEqual(await ledger(f.id), []); assert.equal((await caseState(f.id)).points_awarded, 0);
  }
});
test("Revoke writes the exact negative original award, releases capacity, and retry cannot reverse twice", async () => {
  const c = await campaign({ points_per_proof: 13, daily_limit: 1 }), member = await h.identity(), first = await make(c, member), zero = await make(c, member);
  await h.review(reviewer, first.case_id, "approve"); await h.review(reviewer, zero.case_id, "approve");
  const original = (await ledger(first.id))[0];
  await update(c, { points_per_proof: 99 });
  const responses = await Promise.all([h.review(admin, first.case_id, "revoke", 1, { reason: "票據撤銷" }), h.review(admin, first.case_id, "revoke", 1, { reason: "票據撤銷" })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const tx = await ledger(first.id), reversal = tx.find(t => t.category === "proof_revoked");
  assert.equal(tx.length, 2); assert.equal(reversal.points, -13); assert.equal(reversal.reference_transaction_id, original.transaction_id);
  assert.equal(tx.find(t => t.category === "proof_approved").points, 13); assert.equal((await caseState(first.id)).points_awarded, 0);
  assert.equal(await memberTotal(member), 0);
  // A previously zero-awarded case stays zero; capacity applies to a new approval.
  assert.equal((await caseState(zero.id)).points_awarded, 0);
  const next = await make(c, member); await h.review(reviewer, next.case_id, "approve"); assert.equal((await caseState(next.id)).points_awarded, 99);
  await error(await h.review(admin, first.case_id, "approve", 2), 409, "CASE_STATUS_CONFLICT");
});
test("Same case concurrent approval yields one award/audit; last daily slot across cases cannot over-issue", async () => {
  const c = await campaign({ daily_limit: 1 }), member = await h.identity(), fixture = await make(c, member);
  const same = await Promise.all([h.review(reviewer, fixture.case_id, "approve"), h.review(admin, fixture.case_id, "approve")]);
  assert.deepEqual(same.map(r => r.status).sort(), [200, 409]); assert.equal((await ledger(fixture.id)).length, 1);
  const otherCampaign = await campaign({ daily_limit: 1 }), a = await make(otherCampaign, member), b = await make(otherCampaign, member);
  const different = await Promise.all([h.review(reviewer, a.case_id, "approve"), h.review(admin, b.case_id, "approve")]);
  assert.deepEqual(different.map(r => r.status), [200, 200]);
  const rows = await Promise.all([caseState(a.id), caseState(b.id)]); assert.deepEqual(rows.map(r => r.points_awarded).sort((x, y) => x - y), [0, 10]);
  assert.equal((await ledger(a.id)).length + (await ledger(b.id)).length, 1);
});
for (const stage of ["ledger", "audit"]) test(`Approval failure at ${stage} rolls back case, ledger, snapshot and audit together`, async () => {
  const c = await campaign(), member = await h.identity(), fixture = await make(c, member), table = stage === "ledger" ? "point_transactions" : "admin_audit_logs";
  await local.db.prepare(`CREATE TRIGGER local_b5b_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'local storage failure'); END`).run();
  try {
    await error(await h.review(reviewer, fixture.case_id, "approve"), 503, "ADMIN_SERVICE_UNAVAILABLE");
    const row = await caseState(fixture.id); assert.equal(row.status, "pending"); assert.equal(row.version, 0); assert.equal(row.points_awarded, 0);
    assert.deepEqual(await ledger(fixture.id), []); assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM admin_audit_logs WHERE target_id = ?").bind(fixture.case_id).first()).n, 0);
  } finally { await local.db.prepare("DROP TRIGGER local_b5b_fail").run(); }
});
test("Closed Campaign allows existing case approval; archived Campaign rejects new approval but permits exact revoke", async () => {
  let c = await campaign(), member = await h.identity(), f = await make(c, member), pending = await make(c, member);
  c = (await (await update(c, { status: "closed" })).json()).data;
  assert.equal((await h.review(reviewer, f.case_id, "approve")).status, 200);
  c = (await (await update(c, { status: "archived" })).json()).data;
  await error(await h.review(reviewer, pending.case_id, "approve"), 409, "CAMPAIGN_NOT_REVIEWABLE");
  assert.equal((await h.review(admin, f.case_id, "revoke", 1, { reason: "歷史撤銷" })).status, 200);
});

test("Manual positive/negative adjustments are append-only, audited and included in ledger SUM", async () => {
  const member = await h.identity();
  const a = await adjustment(admin, member, 21), b = await adjustment(superAdmin, member, -7); assert.equal(a.status, 201); assert.equal(b.status, 201);
  const data = (await a.json()).data; assert.equal(data.member_id, member.memberId); assert.equal(data.points, 21); assert.ok(data.transaction_id);
  const row = await local.db.prepare("SELECT * FROM point_transactions WHERE transaction_id = ?").bind(data.transaction_id).first();
  assert.equal(row.case_id, null); assert.equal(row.category, "manual_adjustment"); assert.equal(row.created_by, admin.memberId);
  const audit = await local.db.prepare("SELECT * FROM admin_audit_logs WHERE target_id = ?").bind(data.transaction_id).first(); assert.equal(audit.action, "manual_adjustment");
  assert.equal(await memberTotal(member), 14);
  const adminSummary = (await (await get(`/api/admin/members/${member.memberId}/points`)).json()).data;
  assert.equal(adminSummary.total_points,14); assert.equal(adminSummary.tier.tier_id,'normal'); assert.equal(adminSummary.tier_configuration_ready,false);
});
test("Manual adjustment normalized replay returns same transaction, conflicting payload rejects and stores only hashes", async () => {
  const member = await h.identity(), key = randomUUID();
  const first = await adjustment(admin, member, 10, key, "  調整原因  "); assert.equal(first.status, 201); const data = await first.json();
  const replay = await adjustment(admin, member, 10, key, "調整原因"); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), data);
  await error(await adjustment(admin, member, 11, key, "調整原因"), 409, "IDEMPOTENCY_CONFLICT");
  const row = await local.db.prepare("SELECT * FROM point_transactions WHERE transaction_id = ?").bind(data.data.transaction_id).first();
  assert.equal(JSON.stringify(row).includes(key), false); assert.equal(row.idempotency_hash.length, 64); assert.equal(row.request_hash.length, 64);
  assert.equal(await memberTotal(member), 10);
});
test("Concurrent adjustment retries append one transaction/audit and different administrators have isolated keys", async () => {
  const member = await h.identity(), key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 4 }, () => adjustment(admin, member, 9, key)));
  for (const response of responses) assert.equal(response.status, 201);
  const data = await Promise.all(responses.map(r => r.json())); for (const result of data) assert.deepEqual(result, data[0]);
  assert.equal(await memberTotal(member), 9);
  assert.equal((await local.db.prepare("SELECT COUNT(*) AS n FROM admin_audit_logs WHERE target_id = ?").bind(data[0].data.transaction_id).first()).n, 1);
  const other = await adjustment(superAdmin, member, 9, key); assert.equal(other.status, 201); assert.notEqual((await other.json()).data.transaction_id, data[0].data.transaction_id);
});
test("Reviewer cannot adjust or read another member summary; expired/suspended/disabled actors reject", async () => {
  const member = await h.identity(); await error(await adjustment(reviewer, member, 10), 403, "ADMIN_FORBIDDEN");
  await error(await get(`/api/admin/members/${member.memberId}/points`, reviewer), 403, "ADMIN_FORBIDDEN");
  for (const options of [{ role: "admin", status: "suspended" }, { role: "admin", membershipStatus: "disabled" }, { role: "admin", expired: true }]) {
    const actor = await h.identity(options), response = await adjustment(actor, member, 10); assert.ok([401, 403].includes(response.status));
  }
  await error(await local.fetch("/api/me/points"), 401, "AUTH_REQUIRED");
  const suspended = await h.identity({ status: "suspended" }); await error(await get("/api/me/points", suspended), 403, "MEMBER_SUSPENDED");
});
for (const [name, points, reason] of [["zero", 0, "required"], ["too large", 1000001, "required"], ["too negative", -1000001, "required"],
  ["fraction", 0.5, "required"], ["blank reason", 1, " "], ["long reason", 1, "a".repeat(501)], ["control reason", 1, "bad\n"]]) {
  test(`Manual adjustment rejects ${name}`, async () => { const member = await h.identity(); await error(await adjustment(admin, member, points, randomUUID(), reason), 400, "INVALID_POINT_ADJUSTMENT"); });
}
test("Adjustment requires bounded Idempotency-Key and existing member, disallows client audit fields", async () => {
  const member = await h.identity(), body = { member_id: member.memberId, points: 1, reason: "調整" };
  for (const key of [undefined, "short", "a".repeat(129), "not valid key " + randomUUID()]) {
    await error(await local.fetch("/api/admin/points/adjustments", "POST", body, { ...admin.headers, ...(key ? { "Idempotency-Key": key } : {}) }), 400, "INVALID_IDEMPOTENCY_KEY");
  }
  await error(await adjustment(admin, { memberId: "M-" + randomUUID() }, 1), 404, "MEMBER_NOT_FOUND");
  await error(await local.fetch("/api/admin/points/adjustments", "POST", { ...body, created_by: reviewer.memberId }, { ...admin.headers, "Idempotency-Key": randomUUID() }), 400, "INVALID_POINT_ADJUSTMENT");
});
test("Adjustment audit failure rolls back the ledger and retry after repair creates exactly one adjustment", async () => {
  const member = await h.identity(), key = randomUUID();
  await local.db.prepare("CREATE TRIGGER local_adjustment_fail BEFORE INSERT ON admin_audit_logs BEGIN SELECT RAISE(ABORT, 'local audit failure'); END").run();
  try { await error(await adjustment(admin, member, 4, key), 503, "POINT_SERVICE_UNAVAILABLE"); assert.equal(await memberTotal(member), 0); }
  finally { await local.db.prepare("DROP TRIGGER local_adjustment_fail").run(); }
  assert.equal((await adjustment(admin, member, 4, key)).status, 201); assert.equal(await memberTotal(member), 4);
});
test("Point ledger DB blocks UPDATE, DELETE, REPLACE, duplicate awards and incorrect reversals", async () => {
  const member = await h.identity(), c = await campaign(), fixture = await make(c, member); await h.review(reviewer, fixture.case_id, "approve");
  const original = (await ledger(fixture.id))[0];
  await assert.rejects(local.db.prepare("UPDATE point_transactions SET points = 99 WHERE transaction_id = ?").bind(original.transaction_id).run());
  await assert.rejects(local.db.prepare("DELETE FROM point_transactions WHERE transaction_id = ?").bind(original.transaction_id).run());
  for (const id of [original.transaction_id, randomUUID()]) await assert.rejects(local.db.prepare(`INSERT OR REPLACE INTO point_transactions
    SELECT ?, created_at, member_id, case_id, campaign_id, category, vote_type, vote_date, points, reason, created_by,
      reference_transaction_id, metadata_json, idempotency_hash, request_hash FROM point_transactions WHERE transaction_id = ?`)
    .bind(id, original.transaction_id).run());
  await h.review(admin, fixture.case_id, "revoke", 1, { reason: "撤銷" });
  await assert.rejects(local.db.prepare(`INSERT INTO point_transactions (transaction_id, created_at, member_id, case_id, campaign_id, category,
    vote_type, vote_date, points, reason, created_by, reference_transaction_id) VALUES (?, ?, ?, ?, ?, 'proof_revoked', ?, ?, -11, 'bad reversal', ?, ?)`)
    .bind(randomUUID(), new Date().toISOString(), member.memberId, fixture.id, c.campaign_id, "Solo", fixture.body.vote_date, admin.memberId, original.transaction_id).run());
  assert.equal((await ledger(fixture.id)).length, 2); assert.deepEqual((await local.db.prepare("PRAGMA foreign_key_check").all()).results, []);
});
test("Member total reads immutable ledger SUM and never mutable case snapshots", async () => {
  const member = await h.identity(), c = await campaign(), fixture = await make(c, member); await h.review(reviewer, fixture.case_id, "approve");
  await adjustment(admin, member, -3); await local.db.prepare("UPDATE cases SET points_awarded = 999 WHERE id = ?").bind(fixture.id).run();
  assert.equal(await memberTotal(member), 7);
  const other = await h.identity(); assert.equal(await memberTotal(other), 0);
});
test("Campaign/adjustment mutations reject missing Origin/CSRF; unknown ledger mutation endpoints stay absent", async () => {
  const member = await h.identity(), headers = { ...admin.headers }; delete headers.Origin;
  await error(await local.fetch("/api/admin/campaigns", "POST", campaignBody(), headers), 403, "CSRF_REJECTED");
  delete headers["X-CSRF-Token"]; headers.Origin = "https://voteproof.example";
  await error(await local.fetch("/api/admin/points/adjustments", "POST", { member_id: member.memberId, points: 1, reason: "adjust" }, { ...headers, "Idempotency-Key": randomUUID() }), 403, "CSRF_REJECTED");
  for (const method of ["PATCH", "DELETE"]) {
    await error(await local.fetch("/api/admin/points/adjustments", method, {}, admin.headers), 405, "METHOD_NOT_ALLOWED");
    await error(await local.fetch("/api/admin/point-transactions/" + randomUUID(), method, {}, admin.headers), 404, "NOT_FOUND");
  }
  await error(await local.fetch("/api/admin/campaigns", "PATCH", {}, admin.headers), 405, "METHOD_NOT_ALLOWED");
  assert.equal(local.emails.length, 0);
});
test("0005 preserves existing B5A audit rows and re-establishes append-only protection", async () => {
  const auditId = randomUUID(), memberId = "M-" + randomUUID(), now = new Date().toISOString();
  const runtime = await localCaseRuntime({ seedCampaign: false, async migrationHook(db, name) {
    if (name !== "0004_admin_review.sql") return;
    await db.batch([
      db.prepare("INSERT INTO members (id, member_id, email, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(randomUUID(), memberId, randomUUID() + "@example.test", now, now, now),
      db.prepare(`INSERT INTO admin_audit_logs (id, created_at, admin_member_id, admin_role, action, target_type, target_id, before_json, after_json, reason)
        VALUES (?, ?, ?, 'super_admin', 'bootstrap_membership', 'admin_membership', ?, '{}', '{}', 'local migration fixture')`)
        .bind(auditId, now, memberId, randomUUID()),
    ]);
  } });
  try {
    const row = await runtime.db.prepare("SELECT * FROM admin_audit_logs WHERE id = ?").bind(auditId).first();
    assert.equal(row.reason, "local migration fixture"); assert.equal(row.admin_member_id, memberId); assert.equal(row.created_at, now);
    await assert.rejects(runtime.db.prepare("DELETE FROM admin_audit_logs WHERE id = ?").bind(auditId).run());
    assert.deepEqual((await runtime.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await runtime.runtime.dispose(); }
});
test("Campaign create/update audit failures leave neither unlogged campaigns nor partial edits", async () => {
  const c = await campaign(), body = campaignBody();
  await local.db.prepare("CREATE TRIGGER local_campaign_fail BEFORE INSERT ON admin_audit_logs BEGIN SELECT RAISE(ABORT, 'local failure'); END").run();
  try {
    await error(await local.fetch("/api/admin/campaigns", "POST", body, admin.headers), 503, "CAMPAIGN_SERVICE_UNAVAILABLE");
    assert.equal(await local.db.prepare("SELECT * FROM campaigns WHERE campaign_id = ?").bind(body.campaign_id).first(), null);
    await error(await update(c, { name: "must roll back", points_per_proof: 25 }), 503, "CAMPAIGN_SERVICE_UNAVAILABLE");
    const row = await local.db.prepare("SELECT * FROM campaigns WHERE campaign_id = ?").bind(c.campaign_id).first();
    assert.equal(row.name, c.name); assert.equal(row.points_per_proof, c.points_per_proof); assert.equal(row.version, 0);
  } finally { await local.db.prepare("DROP TRIGGER local_campaign_fail").run(); }
});
for (const stage of ["ledger", "audit"]) test(`Revoke failure at ${stage} preserves original award and approved state`, async () => {
  const c = await campaign(), member = await h.identity(), fixture = await make(c, member); await h.review(reviewer, fixture.case_id, "approve");
  const original = (await ledger(fixture.id))[0], table = stage === "ledger" ? "point_transactions" : "admin_audit_logs";
  await local.db.prepare(`CREATE TRIGGER local_revoke_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'local failure'); END`).run();
  try {
    await error(await h.review(admin, fixture.case_id, "revoke", 1, { reason: "測試撤銷" }), 503, "ADMIN_SERVICE_UNAVAILABLE");
    const row = await caseState(fixture.id); assert.equal(row.status, "approved"); assert.equal(row.version, 1); assert.equal(row.points_awarded, 10);
    assert.deepEqual(await ledger(fixture.id), [original]); assert.equal(await memberTotal(member), 10);
  } finally { await local.db.prepare("DROP TRIGGER local_revoke_fail").run(); }
});
test("Campaign change between policy read and review batch conflicts without awarding stale points", async () => {
  const c = await campaign(), member = await h.identity(), fixture = await make(c, member), row = await adminCase(local.db, fixture.case_id);
  const db = { prepare: local.db.prepare.bind(local.db), async batch(statements) {
    await local.db.prepare("UPDATE campaigns SET points_per_proof = 999, version = version + 1 WHERE campaign_id = ?").bind(c.campaign_id).run();
    return local.db.batch(statements);
  } };
  await assert.rejects(applyReview(db, { role: "reviewer", member: { member_id: reviewer.memberId, tokenHash: reviewer.hash } }, row,
    reviewInput({ action: "approve", expected_version: 0 }, "reviewer")), e => e.code === "CASE_STATUS_CONFLICT");
  assert.equal((await caseState(fixture.id)).status, "pending"); assert.deepEqual(await ledger(fixture.id), []);
});
test("Adjustment transaction revalidates revoked authorization instead of trusting a stale actor", async () => {
  const actor = await h.identity({ role: "admin" }), member = await h.identity(), input = { member_id: member.memberId, points: 10, reason: "調整" };
  const verified = { role: "admin", member: { member_id: actor.memberId, tokenHash: actor.hash } };
  const identity = await adjustmentIdentity(new Request("https://voteproof.example/api/admin/points/adjustments", { headers: { "Idempotency-Key": randomUUID() } }), verified, input);
  await local.db.prepare("UPDATE admin_memberships SET status = 'disabled' WHERE member_id = ?").bind(actor.memberId).run();
  await assert.rejects(adjustPoints(local.db, verified, input, identity), e => e.code === "ADMIN_FORBIDDEN");
  assert.equal(await memberTotal(member), 0);
});
test("DB reversal arithmetic is exact even before uniqueness is reached", async () => {
  const member = await h.identity(), c = await campaign(), fixture = await make(c, member); await h.review(reviewer, fixture.case_id, "approve");
  const original = (await ledger(fixture.id))[0];
  // Simulate a faulty maintenance writer on a disposable DB, independently of
  // API atomicity, so this reaches the arithmetic trigger rather than UNIQUE.
  await local.db.prepare("UPDATE cases SET status = 'revoked' WHERE id = ?").bind(fixture.id).run();
  const insert = amount => local.db.prepare(`INSERT INTO point_transactions (transaction_id, created_at, member_id, case_id, campaign_id,
    category, vote_type, vote_date, points, reason, created_by, reference_transaction_id)
    VALUES (?, ?, ?, ?, ?, 'proof_revoked', 'Solo', ?, ?, 'local compensation', ?, ?)`)
    .bind(randomUUID(), new Date().toISOString(), member.memberId, fixture.id, c.campaign_id, fixture.body.vote_date, amount, admin.memberId, original.transaction_id).run();
  await assert.rejects(insert(-11)); assert.equal((await ledger(fixture.id)).length, 1);
  await insert(-10); assert.equal((await ledger(fixture.id)).length, 2); assert.equal(await memberTotal(member), 0);
});
