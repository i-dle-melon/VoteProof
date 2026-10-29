globalThis.location={origin:'https://voteproof.example'};
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { BatchSubmission, validateBatchImages } from "../public/js/submission.js";
import { PublicError } from "../public/js/api.js";
import { MemberSession } from "../public/js/member-api.js";
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";

const metadata = { nickname: "本機批次", player_id: "local", campaign_id: "LOCAL-TEST", vote_type: "Solo", vote_date: "2026-10-12" };
const files = count => Array.from({ length: count }, (_, i) => ({ name: `proof-${i}.png`, type: "image/png", size: 3, arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer }));
function fixture(count = 3) {
  const calls = [], puts = [], receipts = new Map(), states = [];
  let enabled = true, failPut = true, lost = true;
  const api = async (path, options) => {
    calls.push({ path, ...options });
    if (path.endsWith("status")) return { submissions_enabled: enabled };
    if (path.endsWith("prepare")) return { session_id: randomUUID(), expires_in: 300, uploads: options.body.files.map(() => ({
      key: randomUUID(), method: "PUT", headers: { 'Content-Type':'image/png','X-Upload-Grant':randomBytes(48).toString('base64url') },
      upload_url: `https://voteproof.example/api/uploads/put/${randomUUID()}/${randomUUID()}` })) };
    if (path.endsWith("complete")) return {};
    const key = options.headers["Idempotency-Key"];
    if (!receipts.has(key)) receipts.set(key, { case_id: "VP-20261012-" + String.fromCharCode(65 + receipts.size).repeat(16), query_key: randomBytes(32).toString("base64url") });
    if (lost && receipts.size === 2) { lost = false; throw new PublicError("NETWORK_ERROR"); }
    return receipts.get(key);
  };
  const batch = new BatchSubmission({ api, put: async (_upload, file) => {
    puts.push(file.name); if (failPut && file.name === "proof-1.png") { failPut = false; throw new PublicError("UPLOAD_VALIDATION_FAILED",400); }
  }, token: async () => randomUUID(), changed: summary => states.push(summary) });
  return { batch, calls, puts, receipts, states, api, start: () => batch.start(metadata, files(count)), off: () => { enabled = false; } };
}

test("batch accepts 20 independent 5 MiB files; rejects 21, empty, invalid MIME and oversized files", () => {
  validateBatchImages(files(20).map(file => ({ ...file, size: 5 * 1024 * 1024 })));
  for (const [input, code] of [[files(21), "BATCH_TOO_MANY_FILES"], [[], "IMAGES_REQUIRED"],
    [[{ ...files(1)[0], type: "image/svg+xml" }], "UNSUPPORTED_FILE_TYPE"],
    [[{ ...files(1)[0], size: 5 * 1024 * 1024 + 1 }], "FILE_TOO_LARGE"]]) assert.throws(() => validateBatchImages(input), { code });
});

test("partial batch retries only failed items and replays a lost case response with the same payload/key", async () => {
  const h = fixture(); h.start(); const first = await h.batch.attempt();
  assert.deepEqual([first.total, first.succeeded, first.failed], [3, 1, 2]);
  assert.equal(first.items[0].status, "success"); assert.equal(first.items[1].error, "UPLOAD_VALIDATION_FAILED");
  assert.equal(first.items[2].error, "NETWORK_ERROR"); assert.equal(h.receipts.size, 2);
  const second = await h.batch.attempt(); assert.equal(second.complete, true); assert.equal(h.receipts.size, 3);
  assert.deepEqual(h.puts, ["proof-0.png", "proof-1.png", "proof-2.png", "proof-1.png"]);
  const posts = h.calls.filter(c => c.path === "/api/cases");
  assert.equal(posts.length, 4); assert.equal(posts[1].body, posts[3].body);
  assert.equal(posts[1].headers["Idempotency-Key"], posts[3].headers["Idempotency-Key"]);
  assert.equal(new Set(posts.map(c => c.headers["Idempotency-Key"])).size, 3);
  for (const call of h.calls.filter(c => c.path.endsWith("prepare"))) assert.equal(call.body.files.length, 1);
  for (const call of posts) assert.equal(JSON.parse(call.body).upload_session.keys.length, 1);
  assert.equal(h.calls.filter(c => c.path.endsWith("complete")).length, 3);
  await h.batch.attempt(); assert.equal(h.calls.filter(c => c.path === "/api/cases").length, 4);
});

test("OFF blocks an entire 20-image batch before prepare, PUT, completion or creation", async () => {
  const h = fixture(20); h.start(); h.off();
  await assert.rejects(h.batch.attempt(), { code: "SUBMISSIONS_DISABLED" });
  assert.equal(h.puts.length, 0); assert.deepEqual(h.calls.map(c => c.path), ["/api/submissions/status"]);
  assert.equal(h.batch.summary.queued, 20);
});

test("gate closure during partial batch pauses remaining items and retains successful receipts", async () => {
  const h = fixture(); h.batch.changed = summary => { if (summary.succeeded) h.off(); }; h.start();
  const result = await h.batch.attempt();
  assert.equal(result.succeeded, 1); assert.equal(result.failed, 1); assert.equal(result.queued, 1);
  assert.equal(h.receipts.size, 1); assert.equal(h.puts.length, 1);
});

test("lost completion response replays only that upload reference and does not re-upload successes", async () => {
  const h = fixture(1); const original = h.batch.dependencies.api; let lost = true;
  h.batch.dependencies.api = async (path, options) => {
    const result = await original(path, options);
    if (path.endsWith("complete") && lost) { lost = false; throw new PublicError("NETWORK_ERROR"); }
    return result;
  };
  h.start(); assert.equal((await h.batch.attempt()).failed, 1);
  assert.equal((await h.batch.attempt()).complete, true);
  const completions = h.calls.filter(call => call.path.endsWith("complete"));
  assert.equal(completions.length, 2); assert.deepEqual(completions[0].body, completions[1].body);
  assert.equal(h.puts.length, 1); assert.equal(h.receipts.size, 1);
});

test("failed gate read or malformed enabled flag fails closed before the entire batch", async () => {
  for (const status of [null, {}, { submissions_enabled: 1 }, { submissions_enabled: "true" }, "failure"]) {
    const calls = [], batch = new BatchSubmission({ api: async path => {
      calls.push(path); assert.equal(path, "/api/submissions/status");
      if (status === "failure") throw new PublicError("NETWORK_ERROR"); return status;
    }, put: () => assert.fail("Gate must reject before PUT"), token: () => assert.fail("Gate must reject before verification") });
    batch.start(metadata, files(20)); await assert.rejects(batch.attempt());
    assert.deepEqual(calls, ["/api/submissions/status"]); assert.equal(batch.summary.queued, 20);
  }
});

test("duplicate batch attempts share one run; abandoning while busy cannot discard in-flight context", async () => {
  const h = fixture(1); h.start(); const a = h.batch.attempt(), b = h.batch.attempt();
  assert.equal(a, b); assert.throws(() => h.batch.abandon(), { code: "SUBMISSION_BUSY" });
  assert.throws(() => h.start(), { code: "SUBMISSION_PENDING" });
  await a; assert.equal(h.receipts.size, 1); h.batch.abandon(); assert.equal(h.batch.summary.total, 0);
});

test("member identity change pauses the batch without downgrading to guest or another member", async () => {
  const h = fixture(), session = new MemberSession();
  session.accept({ member: { member_id: "LOCAL-MEMBER", nickname: "本機", status: "active" }, csrf_token: randomBytes(32).toString("hex"), expires_in: 600 });
  const sender = session.caseSender(); session.clear();
  h.batch.start(metadata, files(3), { caseApi: sender });
  const result = await h.batch.attempt();
  assert.equal(result.succeeded, 0); assert.equal(result.failed, 1); assert.equal(result.queued, 2);
  assert.equal(h.receipts.size, 0); assert.equal(h.batch.error.code, "AUTH_IDENTITY_CHANGED");
});

test("15 real local member proofs create 15 independent cases; 12 approvals produce 12 real campaign transactions", async () => {
  const h = await localAdminRuntime(), local = h.local;
  try {
    const member = await h.identity(), reviewer = await h.identity({ role: "reviewer" });
    await local.db.prepare("UPDATE campaigns SET points_per_proof=7,daily_limit=NULL WHERE campaign_id='LOCAL-TEST'").run();
    const api = async (path, options = {}) => {
      const r = await local.fetch(path, options.method ?? "GET", options.body, { ...member.headers, ...options.headers });
      const v = await r.json(); if (!r.ok) throw new PublicError(v.error.code, r.status); return v.data;
    };
    const batch = new BatchSubmission({ api, token: async () => randomUUID(), put: async upload => {
      await local.put(upload,new Uint8Array([1,2,3]),member.headers);
    } });
    batch.start(metadata, files(15), { caseApi: api }); const results = await batch.attempt();
    assert.equal(results.complete, true); assert.equal(new Set(results.items.map(item => item.result.case_id)).size, 15);
    const rows = (await local.db.prepare("SELECT c.case_id,c.member_id,c.source,COUNT(f.id) AS files FROM cases c LEFT JOIN case_files f ON f.case_id=c.id GROUP BY c.id").all()).results;
    assert.equal(rows.length, 15); assert.ok(rows.every(row => row.member_id === member.memberId && row.source === "member" && row.files === 1));
    for (const [index, item] of results.items.entries()) {
      if (index === 14) continue;
      assert.equal((await h.review(reviewer, item.result.case_id, index < 12 ? "approve" : "reject", 0, { reason: "Disposable batch review test" })).status, 200);
    }
    const states = (await local.db.prepare("SELECT status,COUNT(*) n,SUM(points_awarded) points FROM cases GROUP BY status").all()).results;
    assert.deepEqual(Object.fromEntries(states.map(row => [row.status, row.n])), { approved: 12, pending: 1, rejected: 2 });
    const ledger = await local.db.prepare("SELECT COUNT(*) n,COUNT(DISTINCT case_id) cases,SUM(points) total FROM point_transactions").first();
    assert.deepEqual(ledger, { n: 12, cases: 12, total: 84 });
    assert.equal((await api("/api/me/points")).total_points, 84);
    const admin = await h.identity({ role: "admin" });
    const created = await local.fetch("/api/admin/leaderboards", "POST", { leaderboard_id: "LOCAL-BATCH", name: "本機批次榜", type: "campaign",
      campaign_id: "LOCAL-TEST", start_date: null, end_date: null, vote_type: null, top_n: 10, is_public: true, status: "active" }, admin.headers);
    assert.equal(created.status, 201); const board = (await created.json()).data;
    assert.equal((await local.fetch("/api/admin/leaderboards/LOCAL-BATCH/rebuild", "POST", { expected_version: board.version }, admin.headers)).status, 200);
    const rankings = (await api("/api/leaderboards?id=LOCAL-BATCH")).leaderboards[0].rankings;
    assert.equal(rankings.length, 1); assert.equal(rankings[0].member_id, member.memberId);
    assert.equal(rankings[0].points, 84); assert.equal(rankings[0].proof_count, 12);
    // Replaying the completed batch cannot create rows or award more points.
    await batch.attempt(); assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM cases").first()).n, 15);
    assert.equal((await local.db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
    assert.equal((await local.db.prepare("PRAGMA quick_check").first()).quick_check, "ok");
    assert.equal(local.unexpectedUpstreams.length, 0);
  } finally { await local.runtime.dispose(); }
});
