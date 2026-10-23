// BUILD-ONLY export adapter. Synthetic package metadata; sample ZIPs only.
let jobs = [];
const redownloads=new WeakMap();
const fixtureId = "00000000-0000-4000-8000-000000000001";
const defaultFilters = {
  from: "2026-10-14T00:00",
  to: "2026-10-14T23:59",
  only_undownloaded:true,
  end_inclusive:true,
  campaign_id: null,
  entire_campaign: false,
  statuses: ["pending", "approved"],
  vote_types: ["Solo", "團體"],
  sources: ["member", "guest"],
  package_bytes: 536870912,
};
function makeJob(id, filters, scene) {
  const image_count = scene === "empty" ? 0 : scene === "small" ? 76 : 4386,
    total_bytes = scene === "empty" ? 0 : scene === "small" ? 93000000 : 6700000000,
    n = scene === "empty" ? 0 : scene === "small" ? 1 : 14;
  return {
    id,
    created_at: "2026-10-14T04:00:00.000Z",
    expires_at: "2099-12-31T00:00:00.000Z",
    filters,
    from_utc: "2026-10-13T16:00:00.000Z",
    to_utc: "2026-10-14T16:00:00.000Z",
    campaign_name: "Preview 假活動",
    image_count,
    total_bytes,
    preview_sample: true,
    packages: Array.from({ length: n }, (_, i) => ({
      number: i + 1,
      image_count: Math.floor(image_count / n) + (i < image_count % n ? 1 : 0),
      total_bytes: Math.floor(total_bytes / n) + (i < total_bytes % n ? 1 : 0),
      status: ["planned", "completed", "failed", "in_progress"][i] ?? "planned",
      attempt_id: i === 0 ? null : "00000000-0000-4000-8000-" + String(i + 1).padStart(12, "0"),
      error_code: i === 2 ? "EXPORT_DOWNLOAD_FAILED" : null,
    })),
  };
}
export async function exportFixture(path, options, state, picture, reply) {
  if (!['admin','super_admin','reviewer'].includes(state.identity)) return reply("ADMIN_FORBIDDEN", 403);
  const scene = state.data === "empty" ? "empty" : state.exports;
  if (!jobs.length && scene !== "error")
    jobs.push(makeJob(fixtureId, { ...defaultFilters }, scene));
  const p = path.split("/").slice(4),
    b = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
  if (!p[0]) return reply({version:2, jobs: jobs.map(({ packages, ...job }) => job) });
  if (p[0] === "query")
    return scene === "error"
      ? reply("ADMIN_SERVICE_UNAVAILABLE", 503)
      : reply({
          image_count: scene === "empty" ? 0 : scene === "small" ? 76 : 4386,
          total_bytes: scene === "empty" ? 0 : scene === "small" ? 93000000 : 6700000000,
        });
  if (p[0] === "jobs" && !p[1]) {
    if (scene === "error") return reply("ADMIN_SERVICE_UNAVAILABLE", 503);
    const job = makeJob(b.job_id, b.filters, scene);
    jobs.unshift(job);
    return reply(job);
  }
  const job = jobs.find((j) => j.id === p[1]);
  if (!job) return reply("EXPORT_NOT_FOUND", 404);
  if (!p[2]) return reply(job);
  const pack = job.packages.find((x) => x.number === Number(p[3]));
  if (!pack) return reply("EXPORT_NOT_FOUND", 404);
  if (p[4] === "state") {
    if(b.status==='completed'&&b.confirmed!==true)return reply('INVALID_EXPORT_QUERY',400);
    if(pack.status==='completed'&&redownloads.get(pack)===b.attempt_id){redownloads.delete(pack);return reply(pack);}
    if (pack.attempt_id !== b.attempt_id) return reply("EXPORT_PACKAGE_CONFLICT", 409);
    if(pack.status==='completed' && b.status!=='completed')return reply('EXPORT_PACKAGE_CONFLICT',409);
    pack.status = b.status;
    pack.error_code = b.error_code ?? null;
    return reply(pack);
  }
  if (p[4] === "start") {
    const readOnly=pack.status==='completed';
    if(readOnly)redownloads.set(pack,b.attempt_id);
    if(readOnly&&pack.attempt_id!==b.expected_attempt_id)return reply('EXPORT_PACKAGE_CONFLICT',409);
    if(!readOnly){pack.status = "in_progress";pack.attempt_id = b.attempt_id;}
    const sample = await picture();
    return reply({
      package: pack,
      read_only: readOnly,
      download_attempt_id: b.attempt_id,
      items: Array.from({ length: 3 }, (_, i) => ({
        ordinal: i + 1,
        file_id: "00000000-0000-4000-8000-" + String(i + 10).padStart(12, "0"),
        case_id: "VP-PREVIEW-" + String(i + 1).padStart(3, "0"),
        created_at: job.created_at,
        campaign_id: "PREVIEW-CAMPAIGN",
        campaign_name: "Preview 假活動",
        vote_type: "Solo",
        source: i === 2 ? "guest" : "member",
        review_status: "pending",
        review_stage: "initial",
        content_type: "image/png",
        file_size: sample.size,
        etag: "preview-fake-etag",
        sha256: null,
      })),
    });
  }
  return reply("UI_PREVIEW_ONLY", 403);
}
