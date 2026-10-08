import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localAdminRuntime } from "./lib/local-admin-runtime.mjs";

const h = await localAdminRuntime(), { local } = h;
try {
  const admin = await h.identity({ role: "admin" }), reviewer = await h.identity({ role: "reviewer" }), member = await h.identity();
  const body = { campaign_id: "SMOKE-" + randomUUID(), name: "Local ledger smoke", category: "local",
    start_at: "2000-01-01T00:00:00.000Z", end_at: "2100-01-01T00:00:00.000Z", campaign_timezone: "UTC",
    points_per_proof: 10, daily_limit: 1, status: "active" };
  const create = await local.fetch("/api/admin/campaigns", "POST", body, admin.headers); assert.equal(create.status, 201);
  assert.ok((await (await local.fetch("/api/campaigns")).json()).data.campaigns.some(c => c.campaign_id === body.campaign_id));
  const metadata = { campaign_id: body.campaign_id };
  const a = await h.makeCase({ member, metadata }), b = await h.makeCase({ member, metadata });
  const approve = await Promise.all([h.review(reviewer, a.case_id, "approve"), h.review(reviewer, b.case_id, "approve")]);
  for (const response of approve) assert.equal(response.status, 200);
  const rows = await Promise.all([a, b].map(f => local.db.prepare("SELECT points_awarded FROM cases WHERE id = ?").bind(f.id).first()));
  assert.deepEqual(rows.map(r => r.points_awarded).sort((x, y) => x - y), [0, 10]);
  const winner = rows[0].points_awarded ? a : b;
  assert.equal((await h.review(admin, winner.case_id, "complete", 1)).status, 200);
  assert.equal((await h.review(admin, winner.case_id, "revoke", 2, { reason: "Local smoke reversal" })).status, 200);
  const next = await h.makeCase({ member, metadata }); assert.equal((await h.review(reviewer, next.case_id, "approve")).status, 200);
  const key = randomUUID(), adjust = () => local.fetch("/api/admin/points/adjustments", "POST",
    { member_id: member.memberId, points: -3, reason: "Local smoke adjustment" }, { ...admin.headers, "Idempotency-Key": key });
  const first = await adjust(), replay = await adjust(); assert.equal(first.status, 201); assert.equal(replay.status, 201);
  assert.deepEqual(await first.json(), await replay.json());
  const summary = await local.fetch("/api/me/points", "GET", undefined, member.headers); assert.equal(summary.status, 200);
  assert.deepEqual((await summary.json()).data, { total_points: 7 });
  const guest = await h.makeCase({ metadata }); assert.equal((await h.review(reviewer, guest.case_id, "approve")).status, 200);
  assert.equal((await local.db.prepare("SELECT points_awarded FROM cases WHERE id = ?").bind(guest.id).first()).points_awarded, 0);
  assert.equal((await local.fetch(`/api/cases/${guest.case_id}`, "GET", undefined, { "X-Case-Query-Key": guest.query_key })).status, 200);
  assert.deepEqual((await local.db.prepare("PRAGMA foreign_key_check").all()).results, []); assert.equal(local.emails.length, 0);
  console.log("B5B smoke PASS: Campaign API, daily-slot contention, completion, exact reversal/capacity recovery, idempotent adjustment, ledger SUM and Guest compatibility");
} finally { await local.runtime.dispose(); }
