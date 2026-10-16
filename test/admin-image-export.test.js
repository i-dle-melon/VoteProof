import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";
import {
  exportFilters,
  exportScope,
  exportWhere,
  snapshotExport,
} from "../src/lib/image-export.js";
import {
  EXPORT_LIMITS,
  planPackages,
  entryFilename,
  safeSlug,
  manifestCSV,
} from "../public/js/export-format.js";
import { adminPath } from "../public/js/member-api.js";
let h,
  local,
  admin,
  superAdmin,
  member,
  reviewer,
  noMfa,
  otherAdmin,
  cases = [];
const filters = (extra = {}) => ({
  from: "2026-10-14T00:00",
  to: "2026-10-15T00:00",
  campaign_id: null,
  entire_campaign: false,
  statuses: ["pending", "approved", "rejected", "other"],
  vote_types: ["Solo", "團體"],
  sources: ["member", "guest"],
  ...extra,
});
const call = (path = "", method = "GET", body, actor = admin) =>
  local.fetch("/api/admin/image-exports" + path, method, body, actor?.headers ?? {});
const data = async (response) => {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data;
};
const error = async (response, status, code) => {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal((await response.json()).error.code, code);
  assert.equal(response.headers.get("cache-control"), "no-store");
};
const query = async (f) => data(await call("/query", "POST", filters(f)));
const create = async (f) =>
  data(await call("/jobs", "POST", { job_id: randomUUID(), filters: filters(f) }));
const start = async (job, number = 1, extra = {}) => {
  const attempt = randomUUID();
  return {
    attempt,
    ...(await data(
      await call(`/jobs/${job.id}/packages/${number}/start`, "POST", {
        attempt_id: attempt,
        expected_attempt_id: job.packages[number - 1].attempt_id,
        ...extra,
      }),
    )),
  };
};
before(async () => {
  h = await localAdminRuntime();
  local = h.local;
  admin = await h.identity({ role: "admin" });
  superAdmin = await h.identity({ role: "super_admin" });
  reviewer = await h.identity({ role: "reviewer" });
  member = await h.identity();
  noMfa = await h.identity({ role: "admin", elevated: false });
  otherAdmin = await h.identity({ role: "admin" });
  await local.campaign({
    campaign_id: "EXPORT-SOLO",
    // Seed through the real create policy while open, then restore the fixed
    // historical export interval. The fixture must work after 2026-10-14 too.
    start_at: "2000-01-01T00:00:00.000Z",
    end_at: "2100-01-01T00:00:00.000Z",
  });
  await local.campaign({ campaign_id: "EXPORT-GROUP", category: "團體" });
  for (let i = 0; i < 8; i++) {
    const row = await h.makeCase({
      member: i % 2 === 0 ? member : undefined,
      metadata: {
        campaign_id: i < 6 ? "EXPORT-SOLO" : "EXPORT-GROUP",
        vote_type: i < 6 ? "Solo" : "團體",
      },
    });
    cases.push(row);
    await local.db
      .prepare("UPDATE cases SET created_at=? WHERE id=?")
      .bind(
        [
          "2026-10-13T16:00:00.000Z",
          "2026-10-14T15:59:00.000Z",
          "2026-10-14T16:00:00.000Z",
          "2026-10-13T15:59:00.000Z",
          "2026-10-14T04:00:00.000Z",
          "2026-10-14T05:00:00.000Z",
          "2026-10-14T06:00:00.000Z",
          "2026-10-14T07:00:00.000Z",
        ][i],
        row.id,
      )
      .run();
  }
  await data(await h.review(admin, cases[1].case_id, "approve"));
  await data(await h.review(admin, cases[1].case_id, "complete", 1));
  await data(await h.review(admin, cases[4].case_id, "reject", 0, { reason: "Local rejection" }));
  await data(
    await h.review(admin, cases[5].case_id, "mark_duplicate", 0, {
      reason: "Local duplicate",
      duplicate_of_case_id: cases[1].case_id,
    }),
  );
  // Backdate this disposable historical fixture only. Restore the exact guard
  // in the same transaction; production/domain policy remains unchanged.
  const policy=await local.db.prepare("SELECT sql FROM sqlite_schema WHERE name='campaigns_update_policy'").first();
  await local.db.batch([
    local.db.prepare('DROP TRIGGER campaigns_update_policy'),
    local.db.prepare("UPDATE campaigns SET start_at='2026-10-13T16:00:00.000Z',end_at='2026-10-14T16:00:00.000Z' WHERE campaign_id='EXPORT-SOLO'"),
    local.db.prepare(policy.sql),
  ]);
});
after(async () => {
  await local?.runtime.dispose();
});
for (const [name, who, status, code] of [
  ["guest", () => null, 401, "AUTH_REQUIRED"],
  ["member", () => member, 403, "ADMIN_FORBIDDEN"],
  ["reviewer", () => reviewer, 403, "ADMIN_FORBIDDEN"],
  ["missing MFA", () => noMfa, 403, "ADMIN_STEP_UP_REQUIRED"],
])
  test(`export ${name} denied`, async () =>
    error(await call("", "GET", undefined, who()), status, code));
test("admin and super_admin allowed; responses do not expose private keys", async () => {
  for (const actor of [admin, superAdmin]) {
    const result = await data(await call("/query", "POST", filters(), actor));
    assert.equal(result.image_count, 6);
    assert.equal(result.total_bytes, 18);
    assert.doesNotMatch(JSON.stringify(result), /object_key|query_key|token_hash|credentials/);
  }
});
test("CSRF required", async () => {
  const actor = { headers: { ...admin.headers } };
  delete actor.headers["X-CSRF-Token"];
  await error(await call("/query", "POST", filters(), actor), 403, "CSRF_REJECTED");
});
test("Origin exact match required", async () => {
  await error(
    await call("/query", "POST", filters(), {
      headers: { ...admin.headers, Origin: "https://attacker.example" },
    }),
    403,
    "CSRF_REJECTED",
  );
});
test("Taipei half-open interval excludes exact end and includes exact start", async () => {
  const q = await query({ campaign_id: "EXPORT-SOLO" });
  assert.equal(q.image_count, 4);
  assert.equal(q.from_utc, "2026-10-13T16:00:00.000Z");
  assert.equal(q.to_utc, "2026-10-14T16:00:00.000Z");
});
test("cross-midnight interval is converted correctly", async () => {
  const q = await query({ from: "2026-10-14T23:00", to: "2026-10-15T01:00" });
  assert.equal(q.image_count, 2);
});
test("entire Campaign uses authoritative period and exact scope without dates", async () => {
  const q = await query({
    campaign_id: "EXPORT-SOLO",
    entire_campaign: true,
    from: undefined,
    to: undefined,
  });
  assert.equal(q.image_count, 4);
  assert.equal(q.total_bytes, 12);
});
test("Campaign selection never leaks another Campaign", async () => {
  const q = await query({ campaign_id: "EXPORT-GROUP" });
  assert.equal(q.image_count, 2);
});
test("status mapping preserves completed, duplicate and review stage", async () => {
  assert.equal((await query({ statuses: ["pending"] })).image_count, 3);
  assert.equal((await query({ statuses: ["approved"] })).image_count, 1);
  assert.equal((await query({ statuses: ["rejected"] })).image_count, 2);
  assert.equal((await query({ statuses: ["other"] })).image_count, 0);
});
test("Solo and group filters", async () => {
  assert.equal((await query({ vote_types: ["Solo"] })).image_count, 4);
  assert.equal((await query({ vote_types: ["團體"] })).image_count, 2);
});
test("member and anonymous filters derive source from membership", async () => {
  assert.equal((await query({ sources: ["member"] })).image_count, 3);
  assert.equal((await query({ sources: ["guest"] })).image_count, 3);
});
test("empty results create no packages", async () => {
  const j = await create({ from: "1999-01-01T00:00", to: "1999-01-02T00:00" });
  assert.equal(j.image_count, 0);
  assert.deepEqual(j.packages, []);
});
test("invalid filters fail closed", async () => {
  for (const f of [
    { from: "2026-02-30T00:00" },
    { from: "2026-10-15T00:00" },
    { statuses: [] },
    { statuses: ["fake"] },
    { entire_campaign: true },
    { campaign_id: "../../x" },
    { sources: ["member", "member"] },
    { package_bytes: 2 },
  ])
    await error(await call("/query", "POST", filters(f)), 400, "INVALID_EXPORT_QUERY");
});
test("unknown Campaign fails closed", async () =>
  error(
    await call("/query", "POST", filters({ campaign_id: "MISSING" })),
    404,
    "EXPORT_CAMPAIGN_NOT_FOUND",
  ));
test("malformed scalar or array JSON receives a bounded validation error", async () => {
  for (const body of [null, [], true, "null"])
    for (const path of ["/query", "/jobs"])
      await error(await call(path, "POST", body), 400, "INVALID_EXPORT_QUERY");
});
test("snapshot status and campaign remain immutable after review", async () => {
  const j = await create({ statuses: ["pending"] }),
    s = await start(j);
  assert.equal(s.items.length, 3);
  const item = s.items.find((i) => i.case_id === cases[0].case_id);
  assert.equal(item.review_status, "pending");
  await h.review(admin, cases[0].case_id, "reject", 0, { reason: "Changed after snapshot" });
  const again = await local.db
    .prepare("SELECT * FROM export_job_items WHERE job_id=? AND file_id=?")
    .bind(j.id, item.file_id)
    .first();
  assert.equal(again.review_status, "pending");
  await local.db
    .prepare("UPDATE campaigns SET name=? WHERE campaign_id=?")
    .bind("Changed campaign name", item.campaign_id)
    .run();
  assert.equal(
    (
      await local.db
        .prepare("SELECT campaign_name FROM export_job_items WHERE job_id=? AND file_id=?")
        .bind(j.id, item.file_id)
        .first()
    ).campaign_name,
    item.campaign_name,
  );
  await assert.rejects(
    local.db
      .prepare("UPDATE export_job_items SET review_status=? WHERE job_id=?")
      .bind("approved", j.id)
      .run(),
    /immutable/,
  );
  await assert.rejects(
    local.db.prepare("UPDATE export_jobs SET image_count=0 WHERE id=?").bind(j.id).run(),
    /sealed/,
  );
  await assert.rejects(
    local.db
      .prepare(
        "INSERT INTO export_packages(job_id,number,image_count,total_bytes) VALUES(?,99,1,3)",
      )
      .bind(j.id)
      .run(),
    /sealed/,
  );
  await assert.rejects(
    local.db.prepare("UPDATE export_packages SET total_bytes=1 WHERE job_id=?").bind(j.id).run(),
    /immutable/,
  );
});
test("job creation exact replay is idempotent and conflicting filters rejected", async () => {
  const body = { job_id: randomUUID(), filters: filters() };
  const a = await data(await call("/jobs", "POST", body)),
    b = await data(await call("/jobs", "POST", body));
  assert.equal(a.id, b.id);
  assert.equal(a.image_count, b.image_count);
  await error(
    await call("/jobs", "POST", { ...body, filters: filters({ sources: ["guest"] }) }),
    409,
    "EXPORT_JOB_CONFLICT",
  );
});
test("concurrent job creation produces one snapshot", async () => {
  const body = { job_id: randomUUID(), filters: filters() };
  const out = await Promise.all([call("/jobs", "POST", body), call("/jobs", "POST", body)]);
  for (const r of out) assert.equal(r.status, 200);
  assert.equal(
    (
      await local.db
        .prepare("SELECT COUNT(*) n FROM export_job_items WHERE job_id=?")
        .bind(body.job_id)
        .first()
    ).n,
    6,
  );
});
test("owned history survives reload and other Admin cannot claim job", async () => {
  const j = await create();
  assert.ok((await data(await call())).jobs.some((x) => x.id === j.id));
  await error(await call("/jobs/" + j.id, "GET", undefined, otherAdmin), 404, "EXPORT_NOT_FOUND");
  await error(await call("/jobs/" + randomUUID()), 404, "EXPORT_NOT_FOUND");
});
test("package completion callback idempotent; failed cannot downgrade completed", async () => {
  const j = await create(),
    s = await start(j),
    path = `/jobs/${j.id}/packages/1/state`,
    b = { attempt_id: s.attempt, status: "completed" };
  assert.equal((await data(await call(path, "POST", b))).status, "completed");
  assert.equal((await data(await call(path, "POST", b))).status, "completed");
  await error(await call(path, "POST", { ...b, status: "failed" }), 409, "EXPORT_PACKAGE_CONFLICT");
  const before=await local.db.prepare('SELECT * FROM export_packages WHERE job_id=? AND number=1').bind(j.id).first();
  const repeat=await data(await call(`/jobs/${j.id}/packages/1/start`,'POST',{attempt_id:randomUUID(),expected_attempt_id:s.attempt}));
  assert.equal(repeat.read_only,true);assert.equal(repeat.package.status,'completed');assert.equal(repeat.package.attempt_id,s.attempt);
  await error(await call(path,'POST',{...b,status:'failed',error_code:'EXPORT_CANCELLED'}),409,'EXPORT_PACKAGE_CONFLICT');
  assert.deepEqual(await local.db.prepare('SELECT * FROM export_packages WHERE job_id=? AND number=1').bind(j.id).first(),before);
});
test("concurrent starts use CAS and only one attempt wins; exact start replay succeeds", async () => {
  const j = await create(),
    a = randomUUID(),
    b = randomUUID(),
    path = `/jobs/${j.id}/packages/1/start`;
  const results = await Promise.all([
    call(path, "POST", { attempt_id: a, expected_attempt_id: null }),
    call(path, "POST", { attempt_id: b, expected_attempt_id: null }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = (await data(await call("/jobs/" + j.id))).packages[0].attempt_id;
  assert.equal(
    (await data(await call(path, "POST", { attempt_id: winner, expected_attempt_id: null })))
      .package.attempt_id,
    winner,
  );
});
test("export read and mutation routes enforce ordinary member denial", async () => {
  const j = await create(),
    s = await start(j);
  for (const actor of [member])
    for (const [path, method, body] of [
      ["/query", "POST", filters()],
      ["/jobs", "POST", { job_id: randomUUID(), filters: filters() }],
      [`/jobs/${j.id}`, "GET"],
      [
        `/jobs/${j.id}/packages/1/start`,
        "POST",
        { attempt_id: randomUUID(), expected_attempt_id: s.attempt },
      ],
      [`/jobs/${j.id}/packages/1/state`, "POST", { attempt_id: s.attempt, status: "completed" }],
      [`/jobs/${j.id}/packages/1/attempts/${s.attempt}/files/${s.items[0].file_id}`, "GET"],
    ])
      await error(await call(path, method, body, actor), 403, "ADMIN_FORBIDDEN");
});
test("failure can retry independently; stale attempt cannot complete or read proofs", async () => {
  const j = await create(),
    s = await start(j);
  await data(
    await call(`/jobs/${j.id}/packages/1/state`, "POST", {
      attempt_id: s.attempt,
      status: "failed",
      error_code: "EXPORT_CANCELLED",
    }),
  );
  const fresh = await start(j, 1, { expected_attempt_id: s.attempt });
  await error(
    await call(`/jobs/${j.id}/packages/1/state`, "POST", {
      attempt_id: s.attempt,
      status: "completed",
    }),
    409,
    "EXPORT_PACKAGE_CONFLICT",
  );
  await error(
    await call(`/jobs/${j.id}/packages/1/attempts/${s.attempt}/files/${s.items[0].file_id}`),
    409,
    "EXPORT_PROOF_UNAVAILABLE",
  );
  assert.equal(fresh.package.status, "in_progress");
});
test("private proof bytes bound to package and snapshot, no permanent URL", async () => {
  const j = await create(),
    s = await start(j),
    path = `/jobs/${j.id}/packages/1/attempts/${s.attempt}/files/${s.items[0].file_id}`;
  const r = await call(path);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array([1, 2, 3]));
  await error(
    await call(path.replace(s.items[0].file_id, randomUUID())),
    409,
    "EXPORT_PROOF_UNAVAILABLE",
  );
});
test("missing R2 proof fails; no silent success or complete", async () => {
  const j = await create(),
    s = await start(j),
    item = s.items.at(-1),
    file = await local.db
      .prepare("SELECT object_key FROM case_files WHERE id=?")
      .bind(item.file_id)
      .first();
  await local.bucket.delete(file.object_key);
  await error(
    await call(`/jobs/${j.id}/packages/1/attempts/${s.attempt}/files/${item.file_id}`),
    404,
    "PROOF_NOT_FOUND",
  );
  assert.equal((await data(await call("/jobs/" + j.id))).packages[0].status, "in_progress");
});
test("changed R2 metadata fails integrity", async () => {
  const j = await create(),
    s = await start(j),
    item = s.items[0],
    file = await local.db
      .prepare("SELECT object_key FROM case_files WHERE id=?")
      .bind(item.file_id)
      .first();
  await local.bucket.put(file.object_key, new Uint8Array([9, 9, 9]), {
    httpMetadata: { contentType: "image/png" },
  });
  await error(
    await call(`/jobs/${j.id}/packages/1/attempts/${s.attempt}/files/${item.file_id}`),
    409,
    "PROOF_INTEGRITY_ERROR",
  );
});
test("forged package and path traversal denied", async () => {
  const j = await create();
  await error(
    await call(`/jobs/${j.id}/packages/99/start`, "POST", {
      attempt_id: randomUUID(),
      expected_attempt_id: null,
    }),
    409,
    "EXPORT_PACKAGE_CONFLICT",
  );
  for (const part of ["%2e%2e", "C:%5cx", "%00", "%EF%BC%8Fx"]) {
    const r = await call("/jobs/" + part);
    assert.equal(r.status, 404);
    assert.ok(["NOT_FOUND", "EXPORT_NOT_FOUND"].includes((await r.json()).error.code));
  }
});
test("expiry fails closed and revocation prevents snapshot write", async () => {
  const j = await create();
  const future = new Date(Date.now() + 8 * 86400000).toISOString();
  const row = await local.db
    .prepare("SELECT expires_at FROM export_jobs WHERE id=?")
    .bind(j.id)
    .first();
  assert.ok(row.expires_at < future);
  const expiredId = randomUUID();
  await local.db
    .prepare(
      "INSERT INTO export_jobs(id,owner_member_id,created_at,expires_at,filters_json,from_utc,to_utc,sealed) VALUES(?,?,?,?,?,?,?,1)",
    )
    .bind(
      expiredId,
      admin.memberId,
      "1999-01-01T00:00:00.000Z",
      "2000-01-01T00:00:00.000Z",
      JSON.stringify(exportFilters(filters())),
      "1999-01-01T00:00:00.000Z",
      "1999-01-02T00:00:00.000Z",
    )
    .run();
  await error(await call("/jobs/" + expiredId), 404, "EXPORT_NOT_FOUND");
  const revoked = await h.identity({ role: "admin" });
  await local.db
    .prepare("UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?")
    .bind(Math.floor(Date.now() / 1000), revoked.hash)
    .run();
  const id = randomUUID();
  await snapshotExport(
    local.db,
    { member: { member_id: revoked.memberId, tokenHash: revoked.hash }, role: "admin" },
    id,
    await exportScope(local.db, exportFilters(filters())),
  );
  assert.equal(
    await local.db.prepare("SELECT id FROM export_jobs WHERE id=?").bind(id).first(),
    null,
  );
});
test("SQL package partition respects both boundaries at 500 and 512 MiB", async () => {
  const source = await local.db
    .prepare("SELECT * FROM case_files WHERE case_id=?")
    .bind(cases[2].id)
    .first();
  // Disposable metadata fixture only, no network or proof bytes generated.
  const generated = Array.from({ length: 110 }, () => ({
    id: randomUUID(),
    key: "export-fixture/" + randomUUID(),
  }));
  await local.db.batch(
    generated.flatMap((g) => [
      local.db
        .prepare(
          "INSERT INTO completed_upload_files(session_id,object_key,content_type,size,etag) SELECT session_id,?,content_type,5242880,etag FROM completed_upload_files WHERE object_key=?",
        )
        .bind(g.key, source.upload_object_key),
      local.db
        .prepare(
          "INSERT INTO case_files(id,case_id,object_key,content_type,size,etag,created_at,upload_object_key) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          g.id,
          source.case_id,
          g.key,
          "image/png",
          5242880,
          "fixture",
          source.created_at,
          g.key,
        ),
    ]),
  );
  const j = await create({ from: "2026-10-15T00:00", to: "2026-10-15T01:00" });
  assert.equal(j.image_count, 111);
  assert.equal(j.packages.length, 2);
  assert.ok(
    j.packages.every((p) => p.image_count <= 500 && p.total_bytes <= EXPORT_LIMITS.maxBytes),
  );
  const p = planPackages(Array.from({ length: 1001 }, () => ({ file_size: 1 })));
  assert.deepEqual(
    p.map((x) => x.image_count),
    [500, 500, 1],
  );
  const small = await create({
    from: "2026-10-15T00:00",
    to: "2026-10-15T01:00",
    package_bytes: EXPORT_LIMITS.blobMaxBytes,
  });
  assert.ok(small.packages.every((p) => p.total_bytes <= EXPORT_LIMITS.blobMaxBytes));
});
test("SQL snapshot also splits at 500 tiny files, independent of byte limit", async () => {
  const source = await local.db
      .prepare("SELECT * FROM case_files WHERE case_id=?")
      .bind(cases[3].id)
      .first(),
    ids = JSON.stringify(Array.from({ length: 500 }, () => randomUUID()));
  await local.db.batch([
    local.db
      .prepare(
        "INSERT INTO completed_upload_files(session_id,object_key,content_type,size,etag) SELECT u.session_id,'export-count/'||j.value,u.content_type,u.size,u.etag FROM completed_upload_files u,json_each(?) j WHERE u.object_key=?",
      )
      .bind(ids, source.upload_object_key),
    local.db
      .prepare(
        "INSERT INTO case_files(id,case_id,object_key,content_type,size,etag,created_at,upload_object_key) SELECT j.value,f.case_id,'export-count/'||j.value,f.content_type,f.size,f.etag,f.created_at,'export-count/'||j.value FROM case_files f,json_each(?) j WHERE f.id=?",
      )
      .bind(ids, source.id),
  ]);
  const j = await create({ from: "2026-10-13T23:59", to: "2026-10-14T00:00" });
  assert.deepEqual(
    j.packages.map((p) => p.image_count),
    [500, 1],
  );
  assert.equal(j.total_bytes, 1503);
});
test("EXPLAIN uses existing case/time and file FK indexes; package index demonstrated", async () => {
  const scope = await exportScope(local.db, exportFilters(filters())),
    where = exportWhere(scope);
  const plan = (
    await local.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT f.id FROM cases c JOIN case_files f ON f.case_id=c.id WHERE " +
          where.sql,
      )
      .bind(...where.values)
      .all()
  ).results;
  assert.ok(plan.some((x) => /idx_cases_|sqlite_autoindex_cases/.test(x.detail)));
  assert.ok(plan.some((x) => /idx_case_files_case_id/.test(x.detail)));
  await local.db.prepare("DROP INDEX idx_export_items_package").run();
  const before = (
    await local.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM export_job_items WHERE job_id=? AND package_no=? ORDER BY ordinal",
      )
      .bind(randomUUID(), 1)
      .all()
  ).results;
  await local.db
    .prepare("CREATE INDEX idx_export_items_package ON export_job_items(job_id,package_no,ordinal)")
    .run();
  const after = (
    await local.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM export_job_items WHERE job_id=? AND package_no=? ORDER BY ordinal",
      )
      .bind(randomUUID(), 1)
      .all()
  ).results;
  assert.ok(after.some((x) => x.detail.includes("idx_export_items_package")));
  assert.ok(before.every((x) => !x.detail.includes("idx_export_items_package")));
  await local.db.prepare("DROP INDEX idx_export_jobs_owner").run();
  const ownerQuery =
    "EXPLAIN QUERY PLAN SELECT * FROM export_jobs WHERE owner_member_id=? AND expires_at>? ORDER BY created_at DESC,id DESC LIMIT 10";
  const ownerBefore = (
    await local.db.prepare(ownerQuery).bind(admin.memberId, new Date().toISOString()).all()
  ).results;
  await local.db
    .prepare(
      "CREATE INDEX idx_export_jobs_owner ON export_jobs(owner_member_id,created_at DESC,id DESC)",
    )
    .run();
  const ownerAfter = (
    await local.db.prepare(ownerQuery).bind(admin.memberId, new Date().toISOString()).all()
  ).results;
  assert.ok(ownerBefore.some((r) => /SCAN export_jobs/.test(r.detail)));
  assert.ok(ownerAfter.some((r) => r.detail.includes("idx_export_jobs_owner")));
  assert.ok(ownerAfter.every((r) => !r.detail.includes("TEMP B-TREE")));
});
test("safe entry IDs and manifest CSV prevent ZIP Slip and formula injection", () => {
  for (const value of ["../../x", "..\\x", "/x", "C:\\x", "x\u0000", "x／y", "x∕y"])
    assert.throws(() =>
      entryFilename({ case_id: value, file_id: randomUUID(), content_type: "image/png" }),
    );
  assert.equal(safeSlug("..\\/\u0000"), "voteproof");
  assert.equal(safeSlug("CON"), "voteproof");
  const item = {
    case_id: "VP-PREVIEW-001",
    file_id: randomUUID(),
    content_type: "image/webp",
    campaign_name: '=HYPERLINK("x")',
  };
  assert.match(manifestCSV([item]), /"'=HYPERLINK/);
  assert.ok(entryFilename(item).endsWith(".webp"));
});
test("frontend admin path allows only constrained export routes", () => {
  const id = randomUUID(),
    base = "/api/admin/image-exports";
  for (const p of [
    base,
    base + "/query",
    base + "/jobs",
    `${base}/jobs/${id}`,
    `${base}/jobs/${id}/packages/1/start`,
    `${base}/jobs/${id}/packages/1/state`,
    `${base}/jobs/${id}/packages/1/attempts/${id}/files/${id}`,
  ])
    assert.equal(adminPath(p), true, p);
  for (const p of [
    base + "?token=x",
    base + "/jobs/%2e%2e",
    base + "/jobs/" + id + "/packages/1/attempts/" + id + "/files/" + id + "?x=1",
  ])
    assert.equal(adminPath(p), false, p);
});
