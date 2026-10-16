import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unstable_splitSqlQuery } from "wrangler";
import { embeddedCaseRuntime, origin, image } from "./helpers/embedded-case-runtime.mjs";
import { getAdminCampaign } from "../src/lib/campaign-store.js";
import { createAdminCampaign } from "../src/api/admin-campaigns.js";
let h, admin, member;
const targets = ["miyeon", "minnie", "soyeon", "yuqi", "shuhua"];
const campaignBody = (extra = {}) => ({
  campaign_id: "C-" + randomUUID(),
  name: "Local component fixture",
  category: "Solo",
  solo_target: "yuqi",
  start_at: "2000-01-01T00:00:00.000Z",
  end_at: "2100-01-01T00:00:00.000Z",
  campaign_timezone: "Asia/Taipei",
  points_per_proof: 10,
  daily_limit: null,
  status: "active",
  ...extra,
});
async function data(response, status = 200) {
  const j = await response.json();
  assert.equal(response.status, status, JSON.stringify(j));
  return j.data;
}
async function error(response, status, code) {
  const j = await response.json();
  assert.equal(response.status, status, JSON.stringify(j));
  assert.equal(j.error.code, code);
}
const createCampaign = (extra) =>
  h.fetch("/api/admin/campaigns", "POST", campaignBody(extra), admin.headers);
const review = (c, action, version = 0) =>
  h.fetch(
    "/api/admin/cases/" + c.case_id + "/review",
    "POST",
    {
      action,
      expected_version: version,
      ...(action === "revoke" ? { reason: "Component reversal" } : {}),
    },
    admin.headers,
  );
const caseBody = (ref, campaign_id) => ({
  campaign_id,
  vote_date: new Date().toISOString().slice(0, 10),
  upload_session: ref,
});
async function createCase(campaign_id, actor = member, options = {}) {
  const { p, ref } = await h.upload(campaign_id, actor, options),
    body = caseBody(ref, campaign_id);
  const result = await data(
    await h.fetch(options.direct === false ? "/api/cases" : "/api/cases/direct", "POST", body, {
      Origin: origin,
      ...actor?.headers,
      "Idempotency-Key": randomUUID(),
    }),
    201,
  );
  return { ...result, p, ref, body };
}
before(async () => {
  mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    return Response.json({ success: true });
  });
  h = await embeddedCaseRuntime();
  admin = await h.identity("super_admin");
  member = await h.identity();
  await h.db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
});
after(() => {
  h?.close();
  mock.restoreAll();
});

test("registry seeds five stable metadata IDs and authenticated Admin read", async () => {
  const registry = await data(
    await h.fetch("/api/admin/solo-targets", "GET", undefined, admin.headers),
  );
  assert.deepEqual(
    registry.targets.map((t) => t.target_id),
    targets,
  );
  assert.ok(registry.targets.every((t) => t.active));
  await error(await h.fetch("/api/admin/solo-targets"), 401, "AUTH_REQUIRED");
});
test("Admin creates Solo with yuqi and group with null; public API omits target, Admin retains it", async () => {
  const solo = await data(await createCampaign({ campaign_id: "CAT-YUQI" }), 201);
  const group = await data(
    await createCampaign({ campaign_id: "CAT-GROUP", category: "團體", solo_target: null }),
    201,
  );
  assert.equal(solo.solo_target, "yuqi");
  assert.equal(group.solo_target, null);
  assert.equal(
    (await data(await h.fetch("/api/admin/campaigns/CAT-YUQI", "GET", undefined, admin.headers)))
      .solo_target,
    "yuqi",
  );
  const campaigns = (await data(await h.fetch("/api/campaigns"))).campaigns;
  assert.equal(campaigns.length, 2);
  assert.ok(campaigns.every((c) => !("solo_target" in c)));
});
for (const [label, extra] of [
  ["arbitrary key", { solo_target: "arbitrary_valid_key" }],
  ["display name", { solo_target: "YUQI" }],
])
  test("Solo registry rejects " + label, async () =>
    error(await createCampaign(extra), 400, "SOLO_TARGET_UNAVAILABLE"),
  );
for (const [label, extra] of [
  ["missing Solo target", { solo_target: null }],
  ["group target", { category: "團體", solo_target: "yuqi" }],
])
  test("Campaign classification rejects " + label, async () =>
    error(await createCampaign(extra), 400, "INVALID_CAMPAIGN_REQUEST"),
  );
test("inactive registry target is rejected on create and update", async () => {
  const row = await data(await createCampaign({ solo_target: "minnie" }), 201);
  await h.db.prepare("UPDATE solo_targets SET active=0 WHERE target_id='minnie'").run();
  try {
    await error(await createCampaign({ solo_target: "minnie" }), 400, "SOLO_TARGET_UNAVAILABLE");
    const fields = Object.fromEntries(
      [
        "name",
        "category",
        "solo_target",
        "start_at",
        "end_at",
        "campaign_timezone",
        "points_per_proof",
        "daily_limit",
        "status",
        "note",
      ].map((k) => [k, row[k]]),
    );
    await error(
      await h.fetch(
        "/api/admin/campaigns/" + row.campaign_id + "/update",
        "POST",
        { ...fields, expected_version: row.version },
        admin.headers,
      ),
      400,
      "SOLO_TARGET_UNAVAILABLE",
    );
  } finally {
    await h.db.prepare("UPDATE solo_targets SET active=1 WHERE target_id='minnie'").run();
  }
});
test("target deactivation between precheck and write cannot create a Campaign or audit entry", async () => {
  const campaign_id = "RACE-" + randomUUID(),
    body = campaignBody({ campaign_id, solo_target: "soyeon" });
  const wrapped = {
    prepare: h.db.prepare,
    batch: async (statements) => {
      await h.db.prepare("UPDATE solo_targets SET active=0 WHERE target_id='soyeon'").run();
      return h.db.batch(statements);
    },
  };
  try {
    const request = new Request(origin + "/api/admin/campaigns", {
      method: "POST",
      headers: { ...admin.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await error(
      await createAdminCampaign({ ...h.env, DB: wrapped }, new URL(request.url), request),
      400,
      "SOLO_TARGET_UNAVAILABLE",
    );
    assert.equal(
      await h.db
        .prepare("SELECT campaign_id FROM campaigns WHERE campaign_id=?")
        .bind(campaign_id)
        .first(),
      null,
    );
    assert.equal(
      (
        await h.db
          .prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE target_id=?")
          .bind(campaign_id)
          .first()
      ).n,
      0,
    );
  } finally {
    await h.db.prepare("UPDATE solo_targets SET active=1 WHERE target_id='soyeon'").run();
  }
});
for (const category of ["Solo", "團體"])
  for (const kind of ["guest", "member"])
    test(`${kind} direct Case derives ${category} without client classification or Complete`, async () => {
      const campaign_id = category === "Solo" ? "CAT-YUQI" : "CAT-GROUP",
        actor = kind === "member" ? member : null;
      const c = await createCase(campaign_id, actor),
        row = await h.db.prepare("SELECT * FROM cases WHERE case_id=?").bind(c.case_id).first();
      assert.equal(row.vote_type, category);
      assert.equal(row.member_id, actor?.memberId ?? null);
      assert.equal(row.upload_session_id, null);
      assert.equal(row.upload_intent_id, c.p.session_id);
      assert.equal(row.nickname, actor ? "Component fixture" : "匿名投稿");
      assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM completed_uploads").first()).n, 0);
      assert.equal(
        (await h.db.prepare("SELECT COUNT(*) n FROM proof_duplicate_jobs").first()).n,
        0,
      );
      assert.ok(
        await h.db
          .prepare("SELECT id FROM proof_backups WHERE file_id=?")
          .bind(c.p.proof_id)
          .first(),
      );
      if (actor)
        assert.equal(
          (await data(await h.fetch("/api/me/cases/" + c.case_id, "GET", undefined, actor.headers)))
            .vote_type,
          category,
        );
    });
test("forged classification fails without consuming proof; matching legacy assertion is accepted", async () => {
  const { p, ref } = await h.upload("CAT-YUQI", member),
    body = caseBody(ref, "CAT-YUQI");
  for (const extra of [{ vote_type: "團體" }, { category: "團體" }, { solo_target: "miyeon" }])
    await error(
      await h.fetch(
        "/api/cases/direct",
        "POST",
        { ...body, ...extra },
        { ...member.headers, "Idempotency-Key": randomUUID() },
      ),
      400,
      extra.vote_type ? "CAMPAIGN_TYPE_MISMATCH" : "INVALID_CASE_REQUEST",
    );
  assert.equal(
    (
      await h.db
        .prepare("SELECT consumed_case_id FROM proof_upload_intents WHERE session_id=?")
        .bind(p.session_id)
        .first()
    ).consumed_case_id,
    null,
  );
  await data(
    await h.fetch(
      "/api/cases/direct",
      "POST",
      { ...body, vote_type: "Solo" },
      { ...member.headers, "Idempotency-Key": randomUUID() },
    ),
    201,
  );
});
test("omitted type idempotent retries and concurrent same proof commit exactly one Case", async () => {
  const { ref } = await h.upload("CAT-YUQI", member),
    body = caseBody(ref, "CAT-YUQI"),
    headers = { ...member.headers, "Idempotency-Key": randomUUID() };
  const results = await Promise.all([
    h.fetch("/api/cases/direct", "POST", body, headers),
    h.fetch("/api/cases/direct", "POST", body, headers),
  ]);
  const a = await data(results[0], 201),
    b = await data(results[1], 201);
  assert.deepEqual(a, b);
  assert.equal(
    (
      await h.db
        .prepare("SELECT COUNT(*) n FROM cases WHERE upload_intent_id=?")
        .bind(ref.session_id)
        .first()
    ).n,
    1,
  );
  await h.db.prepare("UPDATE submission_settings SET submissions_enabled=0 WHERE id=1").run();
  try {
    assert.deepEqual(await data(await h.fetch("/api/cases/direct", "POST", body, headers), 201), a);
  } finally {
    await h.db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
  }
});
test("fresh Gate OFF blocks Case without consuming intent", async () => {
  const { ref } = await h.upload("CAT-YUQI", member);
  await h.db.prepare("UPDATE submission_settings SET submissions_enabled=0 WHERE id=1").run();
  try {
    await error(
      await h.fetch("/api/cases/direct", "POST", caseBody(ref, "CAT-YUQI"), {
        ...member.headers,
        "Idempotency-Key": randomUUID(),
      }),
      503,
      "SUBMISSIONS_DISABLED",
    );
    assert.equal(
      (
        await h.db
          .prepare("SELECT consumed_case_id FROM proof_upload_intents WHERE session_id=?")
          .bind(ref.session_id)
          .first()
      ).consumed_case_id,
      null,
    );
  } finally {
    await h.db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
  }
});
test("Solo total combines miyeon 10 + minnie 20 + yuqi 30; reversal and Group stay correct", async () => {
  const solos = [];
  for (const [solo_target, points] of [
    ["miyeon", 10],
    ["minnie", 20],
    ["yuqi", 30],
  ]) {
    const campaign_id = "TOTAL-" + solo_target;
    await data(await createCampaign({ campaign_id, solo_target, points_per_proof: points }), 201);
    solos.push(await createCase(campaign_id));
  }
  const group = await createCase("CAT-GROUP");
  const batch = await data(
    await h.fetch(
      "/api/admin/cases/batch-approve",
      "POST",
      { cases: [...solos, group].map((c) => ({ case_id: c.case_id, expected_version: 0 })) },
      admin.headers,
    ),
  );
  assert.equal(batch.succeeded, 4);
  assert.equal(batch.failed, 0);
  const readBoard = async (id) =>
    (await data(await h.fetch("/api/leaderboards?id=" + id))).leaderboards[0];
  const solo = await readBoard("system-solo"),
    rows = solo.rankings.filter((r) => r.member_id === member.memberId);
  assert.equal(solo.name, "Solo 總排行");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].points, 60);
  assert.equal(rows[0].proof_count, 3);
  assert.equal("solo_target" in solo, false);
  assert.equal("target_id" in rows[0], false);
  assert.equal(
    (await readBoard("system-group")).rankings.find((r) => r.member_id === member.memberId).points,
    10,
  );
  assert.equal(
    (await readBoard("system-history")).rankings.find((r) => r.member_id === member.memberId)
      .points,
    70,
  );
  await data(await review(solos[1], "revoke", 1));
  const after = (await readBoard("system-solo")).rankings.find(
    (r) => r.member_id === member.memberId,
  );
  assert.equal(after.points, 40);
  assert.equal(after.proof_count, 2);
  assert.equal(
    (await readBoard("system-group")).rankings.find((r) => r.member_id === member.memberId).points,
    10,
  );
  assert.equal(
    (await readBoard("system-history")).rankings.find((r) => r.member_id === member.memberId)
      .points,
    50,
  );
  const ledger = (
    await h.db
      .prepare(
        "SELECT * FROM point_transactions WHERE case_id=(SELECT id FROM cases WHERE case_id=?)",
      )
      .bind(solos[1].case_id)
      .all()
  ).results;
  assert.equal(ledger.length, 2);
  assert.equal(ledger[1].metadata_json, ledger[0].metadata_json);
  assert.equal(JSON.parse(ledger[0].metadata_json).solo_target, "minnie");
  for (const id of ["system-history", "system-group", "system-solo"])
    await error(
      await h.fetch(
        "/api/admin/leaderboards/" + id + "/rebuild",
        "POST",
        { expected_version: 0 },
        admin.headers,
      ),
      409,
      "SYSTEM_LEADERBOARD_FIXED",
    );
});
test("public artist ranking route is removed and artist filters cannot split system-solo", async () => {
  await error(await h.fetch("/api/leaderboards/solo-targets"), 404, "NOT_FOUND");
  for (const target of [...targets, "legacy_unknown", ""])
    await error(
      await h.fetch("/api/leaderboards?id=system-solo&solo_target=" + target),
      400,
      "INVALID_LEADERBOARD_QUERY",
    );
  const solo = (await data(await h.fetch("/api/leaderboards?id=system-solo"))).leaderboards[0];
  assert.equal(solo.rankings.find((r) => r.member_id === member.memberId).points, 40);
});

test("display name changes keep target identity; registry expansion needs no Campaign/Case/ledger schema change", async () => {
  const before = (
    await data(await h.fetch("/api/admin/solo-targets", "GET", undefined, admin.headers))
  ).targets.find((t) => t.target_id === "yuqi");
  await h.db
    .prepare("UPDATE solo_targets SET display_name='YUQI renamed' WHERE target_id='yuqi'")
    .run();
  const after = (
    await data(await h.fetch("/api/admin/solo-targets", "GET", undefined, admin.headers))
  ).targets.filter((t) => t.target_id === "yuqi");
  assert.equal(after.length, 1);
  assert.equal(after[0].target_id, before.target_id);
  assert.equal(after[0].display_name, "YUQI renamed");
  await assert.rejects(
    h.db.prepare("UPDATE solo_targets SET target_id='renamed' WHERE target_id='yuqi'").run(),
    /SOLO_TARGET_IMMUTABLE/,
  );
  await h.db.prepare("INSERT INTO solo_targets VALUES('future_artist','Future artist',1,6)").run();
  const all = (
    await data(await h.fetch("/api/admin/solo-targets", "GET", undefined, admin.headers))
  ).targets;
  assert.equal(all.length, 6);
  assert.equal(all.find((t) => t.target_id === "future_artist").active, true);
  await data(await createCampaign({ solo_target: "future_artist" }), 201);
});
for (const storageVersion of [1, 2])
  test(`legacy V${storageVersion} Case reader and derived type remain compatible`, async () => {
    const c = await createCase("CAT-YUQI", member, { direct: false, storageVersion });
    const read = await data(
      await h.fetch("/api/me/cases/" + c.case_id, "GET", undefined, member.headers),
    );
    assert.equal(read.vote_type, "Solo");
    assert.equal(read.files.length, 1);
  });
test("unknown historical Campaign target remains readable as metadata", async () => {
  const now = new Date().toISOString();
  await h.db
    .prepare(
      "INSERT INTO campaigns(campaign_id,name,category,solo_target,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at) VALUES('UNKNOWN','Legacy','Solo','legacy_unknown','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','UTC','2000-01-01','2099-12-31',10,NULL,'active',?,?)",
    )
    .bind(now, now)
    .run();
  assert.equal((await getAdminCampaign(h.db, "UNKNOWN")).solo_target, "legacy_unknown");
  assert.equal(
    (await h.db.prepare("SELECT solo_target FROM campaigns WHERE campaign_id='UNKNOWN'").first())
      .solo_target,
    "legacy_unknown",
  );
  assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.equal((await h.db.prepare("PRAGMA quick_check").first()).quick_check, "ok");
});
test("0019 is additive and preserves preexisting unknown Campaign and ledger rows", async () => {
  const isolated = await embeddedCaseRuntime({ migrationThrough: "0018_direct_intent_cases.sql" }),
    db = isolated.db;
  try {
    await db
      .prepare(
        "INSERT INTO campaigns(campaign_id,name,category,solo_target,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at) VALUES('HISTORY','Unknown target','Solo','old_unknown','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','UTC','2000-01-01','2099-12-31',10,NULL,'active','now','now')",
      )
      .run();
    await db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
    const actor = await isolated.identity("super_admin"),
      { ref } = await isolated.upload("HISTORY", actor);
    const c = await data(
      await isolated.fetch("/api/cases/direct", "POST", caseBody(ref, "HISTORY"), {
        ...actor.headers,
        "Idempotency-Key": randomUUID(),
      }),
      201,
    );
    await data(
      await isolated.fetch(
        "/api/admin/cases/" + c.case_id + "/review",
        "POST",
        { action: "approve", expected_version: 0 },
        actor.headers,
      ),
    );
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          [
            "campaigns",
            "cases",
            "case_files",
            "point_transactions",
            "proof_backups",
            "submission_settings",
          ].map(async (table) => [
            table,
            (await db.prepare("SELECT * FROM " + table).all()).results,
          ]),
        ),
      );
    const before = await snapshot();
    assert.equal(before.point_transactions.length, 1);
    assert.equal(JSON.parse(before.point_transactions[0].metadata_json).solo_target, "old_unknown");
    await db.batch(
      unstable_splitSqlQuery(
        await readFile(
          new URL("../migrations/0019_solo_target_registry.sql", import.meta.url),
          "utf8",
        ),
      ).map((s) => db.prepare(s)),
    );
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM solo_targets").first()).n, 5);
    // 0019 preservation is checked above. Current code's leaderboard reads
    // require its subsequent additive 0020 schema as well.
    await db.batch(unstable_splitSqlQuery(await readFile(new URL('../migrations/0020_current_comeback.sql',import.meta.url),'utf8')).map(s=>db.prepare(s)));
    assert.equal(
      (
        await data(
          await isolated.fetch("/api/me/cases/" + c.case_id, "GET", undefined, actor.headers),
        )
      ).vote_type,
      "Solo",
    );
    assert.equal(
      (await data(await isolated.fetch("/api/leaderboards?id=system-solo"))).leaderboards[0]
        .rankings[0].points,
      10,
    );
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    isolated.close();
  }
});
test("private proof/export references survive derived category", async () => {
  const c = await createCase("CAT-YUQI"),
    file = c.p.proof_id;
  const privateImage = await h.fetch(
    `/api/admin/cases/${c.case_id}/files/${file}`,
    "GET",
    undefined,
    admin.headers,
  );
  assert.equal(privateImage.status, 200);
  assert.deepEqual(new Uint8Array(await privateImage.arrayBuffer()), image);
  const job = await data(
    await h.fetch(
      "/api/admin/image-exports/jobs",
      "POST",
      {
        job_id: randomUUID(),
        filters: {
          campaign_id: "CAT-YUQI",
          entire_campaign: true,
          statuses: ["pending", "approved", "rejected", "other"],
          vote_types: ["Solo", "團體"],
          sources: ["member", "guest"],
        },
      },
      admin.headers,
    ),
  );
  const attempt = randomUUID(),
    pkg = await data(
      await h.fetch(
        `/api/admin/image-exports/jobs/${job.id}/packages/1/start`,
        "POST",
        { attempt_id: attempt, expected_attempt_id: null },
        admin.headers,
      ),
    );
  assert.ok(
    pkg.items.some((i) => i.case_id === c.case_id && i.file_id === file && i.vote_type === "Solo"),
  );
  const exported = await h.fetch(
    `/api/admin/image-exports/jobs/${job.id}/packages/1/attempts/${attempt}/files/${file}`,
    "GET",
    undefined,
    admin.headers,
  );
  assert.equal(exported.status, 200);
  assert.deepEqual(new Uint8Array(await exported.arrayBuffer()), image);
  const base=`/api/admin/image-exports/jobs/${job.id}/packages/1`;
  await data(await h.fetch(base+'/state','POST',{attempt_id:attempt,status:'completed'},admin.headers));
  const before=await h.db.prepare('SELECT * FROM export_packages WHERE job_id=? AND number=1').bind(job.id).first();
  const repeat=await data(await h.fetch(base+'/start','POST',{attempt_id:randomUUID(),expected_attempt_id:attempt},admin.headers));
  assert.equal(repeat.read_only,true);assert.equal(repeat.package.status,'completed');assert.equal(repeat.package.attempt_id,attempt);
  assert.equal((await h.fetch(`${base}/attempts/${attempt}/files/${file}`,'GET',undefined,admin.headers)).status,200);
  await error(await h.fetch(base+'/state','POST',{attempt_id:attempt,status:'failed',error_code:'EXPORT_CANCELLED'},admin.headers),409,'EXPORT_PACKAGE_CONFLICT');
  await error(await h.fetch(base+'/start','POST',{attempt_id:randomUUID(),expected_attempt_id:null},admin.headers),409,'EXPORT_PACKAGE_CONFLICT');
  await error(await h.fetch(base+'/start','POST',{attempt_id:randomUUID(),expected_attempt_id:attempt}),401,'AUTH_REQUIRED');
  assert.deepEqual(await h.db.prepare('SELECT * FROM export_packages WHERE job_id=? AND number=1').bind(job.id).first(),before);
});
