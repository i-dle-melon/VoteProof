import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { MemberSession, adminPath } from "../public/js/member-api.js";
import { AdminAccess, dailyLimit, utcFromTaipei, taipeiInput, reviewActions, adminMessage } from "../public/js/admin-api.js";
const identity = () => ({ member: { member_id: "M-" + randomUUID(), nickname: "本機", status: "active" }, csrf_token: randomBytes(32).toString("hex"), expires_in: 600, elevated_until: Date.now() / 1000 + 600 });
test("campaign daily limit explicitly preserves unlimited/zero/cap", () => {
  assert.equal(dailyLimit("unlimited", "999999"), null); assert.equal(dailyLimit("zero", "100"), 0);
  for (const n of [1, 10, 1000]) assert.equal(dailyLimit("limited", n), n);
  for (const n of [0, -1, 1001, "", "1.5", "01"]) assert.throws(() => dailyLimit("limited", n));
});
test("Taiwan admin date input roundtrips exact UTC and rejects invalid dates", () => {
  assert.equal(utcFromTaipei("2026-09-10T23:00"), "2026-09-10T15:00:00.000Z");
  assert.equal(taipeiInput("2026-10-20T14:59:00.000Z"), "2026-10-20T22:59:00");
  for (const value of ["2026-02-30T10:00", "2026-10-01T24:00", "invalid"]) assert.throws(() => utcFromTaipei(value));
});
test("reviewer actions mirror existing backend transitions", () => {
  assert.deepEqual(reviewActions("pending", "reviewer"), ["approve", "reject", "mark_duplicate"]);
  assert.deepEqual(reviewActions("approved", "reviewer"), []);
  assert.deepEqual(reviewActions("approved", "admin"), ["complete", "revoke"]);
  assert.deepEqual(reviewActions("completed", "super_admin"), ["revoke"]);
  assert.deepEqual(reviewActions("pending", "member"), []); assert.deepEqual(reviewActions("revoked", "admin"), []);
});
test("admin transport allows only supported relative routes, never private URLs", () => {
  for (const path of ["/api/admin/me", "/api/admin/campaigns/ACT/update", "/api/admin/leaderboards/BOARD/results", "/api/admin/member-tiers/bronze/update", "/api/admin/submissions/update", "/api/admin/cases?vote_type=%E5%9C%98%E9%AB%94&limit=20"]) assert.equal(adminPath(path), true);
  for (const path of ["https://other.example/api/admin/me", "/api/admin/../me", "/api/admin/%2e%2e/me", "/api/admin/roles", "/api/admin/me#secret", "/api/admin/me?x=1?extra=2"]) assert.equal(adminPath(path), false);
});
test("dedicated admin transport retains CSRF/cookies and hides arbitrary response errors", async () => {
  let options; const data = identity(), session = new MemberSession({ fetcher: async (_p, o) => { options = o; return Response.json({ ok: true, data: {} }); } }); session.accept(data);
  await session.adminRequest("/api/admin/submissions/update", { method: "POST", body: { expected_version: 0 } });
  assert.equal(options.headers["X-CSRF-Token"], data.csrf_token); assert.equal(options.credentials, "same-origin"); assert.equal(options.referrerPolicy, "no-referrer"); assert.equal(options.cache, "no-store");
  assert.equal(adminMessage({ status: 409, message: "internal SQL" }).includes("internal SQL"), false); session.clear();
});
test("no admin fetch without member; public member request cannot target admin", async () => {
  let calls = 0; const session = new MemberSession({ fetcher: () => calls++ });
  await assert.rejects(session.adminRequest("/api/admin/me"), { code: "AUTH_REQUIRED" });
  await assert.rejects(session.request("/api/admin/me"), { code: "INVALID_AUTH_REQUEST" }); assert.equal(calls, 0);
});
test("authority requires verified Worker role; client profile role has no authority", async () => {
  const data = identity(); data.member.role = "super_admin";
  const session = new MemberSession({ fetcher: async p => p === "/api/auth/me" ? Response.json({ ok: true, data }) : Response.json({ ok: false, error: { code: "ADMIN_FORBIDDEN" } }, { status: 403 }) });
  session.accept(data); const access = new AdminAccess(session, () => {});
  await assert.rejects(access.check(), { code: "ADMIN_FORBIDDEN" }); assert.equal(access.actor, null); session.clear();
});
test("each admin operation confirms server role and cannot cross identity", async () => {
  let me = identity(), checks = 0;
  const session = new MemberSession({ fetcher: async p => {
    if (p === "/api/auth/me") return Response.json({ ok: true, data: me });
    if (p === "/api/admin/me") { checks++; return Response.json({ ok: true, data: { member_id: me.member.member_id, role: "admin" } }); }
    return Response.json({ ok: true, data: {} });
  } }); session.accept(me); const access = new AdminAccess(session, () => {});
  await access.request("/api/admin/campaigns"); await access.request("/api/admin/submissions"); assert.equal(checks, 2);
  me = identity(); await assert.rejects(access.request("/api/admin/campaigns"), { code: "AUTH_IDENTITY_CHANGED" }); access.clear(); session.clear();
});
test("late privileged response after logout is rejected", async () => {
  const me = identity(); let finish;
  const session = new MemberSession({ fetcher: async p => p === "/api/auth/me" ? Response.json({ ok: true, data: me }) : p === "/api/admin/me" ? Response.json({ ok: true, data: { member_id: me.member.member_id, role: "admin" } }) : new Promise(resolve => finish = resolve) });
  session.accept(me); const access = new AdminAccess(session, () => {}), pending = access.request("/api/admin/cases");
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  session.clear(); access.clear(); finish(Response.json({ ok: true, data: { cases: [] } }));
  await assert.rejects(pending, { code: "AUTH_IDENTITY_CHANGED" });
});
test("MFA expiry closes admin authority without extending auth", async () => {
  const me = identity(); me.elevated_until = Date.now() / 1000 + .1;
  const session = new MemberSession({ fetcher: async p => Response.json({ ok: true, data: p === "/api/auth/me" ? me : { member_id: me.member.member_id, role: "admin" } }) });
  session.accept(me); const access = new AdminAccess(session, () => {}); await access.check();
  await new Promise(resolve => setTimeout(resolve, 140)); assert.equal(access.actor, null); session.clear();
});

test("30-day admin MFA timer reschedules instead of closing at the timer maximum", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const me = identity(); me.elevated_until = Date.now() / 1000 + 30 * 86400;
  const access = new AdminAccess({ member: me.member, refresh: async () => me,
    adminRequest: async () => ({ member_id: me.member.member_id, role: "admin" }) }, () => {});
  await access.check();
  t.mock.timers.tick(2147483647); assert.equal(access.actor.role, "admin");
  t.mock.timers.tick(30 * 86400000 - 2147483647 - 1); assert.equal(access.actor.role, "admin");
  t.mock.timers.tick(1); assert.equal(access.actor, null);
  access.clear();
});
test("private proof transport rejects HTML/SVG/oversize and uses protected stream", async () => {
  const path = "/api/admin/cases/VP-20261009-" + "A".repeat(16) + "/files/" + randomUUID();
  for (const type of ["text/html", "image/svg+xml"]) {
    const session = new MemberSession({ fetcher: async () => new Response("private", { headers: { "Content-Type": type } }) }); session.accept(identity());
    await assert.rejects(session.adminProof(path), { code: "PROOF_INTEGRITY_ERROR" }); session.clear();
  }
  const session = new MemberSession({ fetcher: async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { "Content-Type": "image/png" } }) }); session.accept(identity());
  await assert.rejects(session.adminProof(path), { code: "PROOF_INTEGRITY_ERROR" }); session.clear();
});
