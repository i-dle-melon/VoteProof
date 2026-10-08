import assert from "node:assert/strict";
import { localAdminRuntime } from "./lib/local-admin-runtime.mjs";

const h = await localAdminRuntime(), { local } = h;
try {
  const reviewer = await h.identity({ role: "reviewer" }), admin = await h.identity({ role: "admin" }), member = await h.identity();
  assert.equal((await local.fetch("/api/admin/me")).status, 401);
  assert.equal((await local.fetch("/api/admin/me", "GET", undefined, member.headers)).status, 403);
  const fixture = await h.makeCase();
  const detail = await local.fetch(`/api/admin/cases/${fixture.case_id}`, "GET", undefined, reviewer.headers);
  assert.equal(detail.status, 200); const data = (await detail.json()).data;
  assert.equal(data.version, 0);
  const image = await local.fetch(`/api/admin/cases/${fixture.case_id}/files/${data.files[0].file_id}`, "GET", undefined, reviewer.headers);
  assert.equal(image.status, 200); assert.equal(image.headers.get("cache-control"), "no-store");
  assert.equal((await image.arrayBuffer()).byteLength, 3);
  const results = await Promise.all([h.review(reviewer, fixture.case_id, "approve"), h.review(admin, fixture.case_id, "reject", 0, { reason: "本機並發驗收" })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const logs = await local.fetch(`/api/admin/audit-logs?target_id=${fixture.case_id}`, "GET", undefined, admin.headers);
  assert.equal(logs.status, 200); assert.equal((await logs.json()).data.logs.length, 1);
  const guest = await local.fetch(`/api/cases/${fixture.case_id}?key=${fixture.query_key}`); assert.equal(guest.status, 200);
  const guestData = (await guest.json()).data; assert.equal(guestData.reviewer_id, undefined); assert.equal(guestData.query_key_hash, undefined);
  const own = await h.makeCase({ member });
  assert.equal((await local.fetch(`/api/me/cases/${own.case_id}`, "GET", undefined, member.headers)).status, 200);
  assert.equal((await local.fetch(`/api/me/cases/${own.case_id}`, "GET", undefined, admin.headers)).status, 404);
  assert.equal(local.emails.length, 0);
  assert.deepEqual((await local.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  console.log("B5A smoke PASS: verified identity/RBAC, private proof stream, concurrent review + atomic audit, Guest/Member compatibility; no email delivery");
} finally { await local.runtime.dispose(); }
