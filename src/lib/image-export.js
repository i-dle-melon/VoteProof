import { AdminError, ELEVATED_AUTH_GUARD, actorBindings } from "./admin-identity.js";
import { EXPORT_LIMITS } from "../../public/js/export-format.js";
const invalid = () => {
  throw new AdminError(400, "INVALID_EXPORT_QUERY", "Invalid export filters");
};
export const EXPORT_STATUS_GROUPS = Object.freeze({
  pending: ["pending"],
  approved: ["approved", "completed"],
  rejected: ["rejected", "duplicate"],
  other: ["revoked"],
});
function taipeiUTC(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) invalid();
  const date = new Date(value + ":00+08:00");
  if (!Number.isFinite(+date) || new Date(+date + 8 * 3600000).toISOString().slice(0, 16) !== value)
    invalid();
  return date.toISOString();
}
export function exportFilters(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some(
      (k) =>
        ![
          "from",
          "to",
          "campaign_id",
          "entire_campaign",
          "statuses",
          "vote_types",
          "sources",
          "package_bytes",
        ].includes(k),
    )
  )
    invalid();
  const campaign_id = raw.campaign_id ?? null;
  if (
    campaign_id !== null &&
    (typeof campaign_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(campaign_id))
  )
    invalid();
  if (typeof raw.entire_campaign !== "boolean" || (raw.entire_campaign && !campaign_id)) invalid();
  const list = (value, options) => {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > options.length ||
      new Set(value).size !== value.length ||
      value.some((v) => !options.includes(v))
    )
      invalid();
    return options.filter((v) => value.includes(v));
  };
  const filters = {
    campaign_id,
    entire_campaign: raw.entire_campaign,
    from: raw.entire_campaign ? null : raw.from,
    to: raw.entire_campaign ? null : raw.to,
    statuses: list(raw.statuses, Object.keys(EXPORT_STATUS_GROUPS)),
    vote_types: list(raw.vote_types, ["Solo", "團體"]),
    sources: list(raw.sources, ["member", "guest"]),
    package_bytes: raw.package_bytes ?? EXPORT_LIMITS.maxBytes,
  };
  if (![EXPORT_LIMITS.maxBytes, EXPORT_LIMITS.blobMaxBytes].includes(filters.package_bytes))
    invalid();
  if (!filters.entire_campaign && taipeiUTC(filters.from) >= taipeiUTC(filters.to)) invalid();
  return filters;
}
export async function exportScope(db, filters) {
  let campaign = null;
  if (filters.campaign_id) {
    campaign = await db
      .prepare("SELECT campaign_id,name,start_at,end_at FROM campaigns WHERE campaign_id=?")
      .bind(filters.campaign_id)
      .first();
    if (!campaign) throw new AdminError(404, "EXPORT_CAMPAIGN_NOT_FOUND", "Campaign not found");
  }
  return {
    filters,
    campaign_name: campaign?.name ?? null,
    from_utc: filters.entire_campaign ? campaign.start_at : taipeiUTC(filters.from),
    to_utc: filters.entire_campaign ? campaign.end_at : taipeiUTC(filters.to),
  };
}
export function exportWhere(scope) {
  const f = scope.filters,
    statuses = f.statuses.flatMap((s) => EXPORT_STATUS_GROUPS[s]);
  const clauses = [
    "c.created_at >= ?",
    "c.created_at < ?",
    `c.status IN (${statuses.map(() => "?").join(",")})`,
    `c.vote_type IN (${f.vote_types.map(() => "?").join(",")})`,
  ];
  const values = [scope.from_utc, scope.to_utc, ...statuses, ...f.vote_types];
  if (f.campaign_id) {
    clauses.push("c.campaign_id=?");
    values.push(f.campaign_id);
  }
  if (f.sources.length === 1)
    clauses.push(f.sources[0] === "member" ? "c.member_id IS NOT NULL" : "c.member_id IS NULL");
  return { sql: clauses.join(" AND "), values };
}
export async function countExport(db, scope) {
  const where = exportWhere(scope);
  return db
    .prepare(
      `SELECT COUNT(*) image_count, COALESCE(SUM(f.size),0) total_bytes FROM cases c JOIN case_files f ON f.case_id=c.id WHERE ${where.sql}`,
    )
    .bind(...where.values)
    .first();
}
// INSERT SELECT + SQL recursion: one transactional D1 batch, never one trip/image.
export async function snapshotExport(db, actor, id, scope) {
  const packageBytes = scope.filters.package_bytes;
  if (![EXPORT_LIMITS.maxBytes, EXPORT_LIMITS.blobMaxBytes].includes(packageBytes)) invalid();
  const where = exportWhere(scope),
    now = new Date().toISOString(),
    expiry = new Date(Date.now() + EXPORT_LIMITS.lifetimeSeconds * 1000).toISOString();
  const exactCampaign = scope.filters.entire_campaign
    ? " AND EXISTS(SELECT 1 FROM campaigns WHERE campaign_id=? AND start_at=? AND end_at=? AND name=?)"
    : "";
  const campaignBindings = scope.filters.entire_campaign
    ? [scope.filters.campaign_id, scope.from_utc, scope.to_utc, scope.campaign_name]
    : [];
  await db.batch([
    db
      .prepare(
        `INSERT INTO export_jobs(id,owner_member_id,created_at,expires_at,filters_json,from_utc,to_utc,campaign_name)
      SELECT ?,?,?,?,?,?,?,? WHERE ${ELEVATED_AUTH_GUARD}${exactCampaign}`,
      )
      .bind(
        id,
        actor.member.member_id,
        now,
        expiry,
        JSON.stringify(scope.filters),
        scope.from_utc,
        scope.to_utc,
        scope.campaign_name,
        ...actorBindings(actor),
        ...campaignBindings,
      ),
    db
      .prepare(
        `WITH RECURSIVE ordered AS MATERIALIZED (
      SELECT ROW_NUMBER() OVER (ORDER BY c.created_at,c.id,f.id) ordinal, f.id file_id,c.case_id,c.created_at,c.campaign_id,COALESCE(cam.name,c.campaign_id) campaign_name,
        c.vote_type,CASE WHEN c.member_id IS NULL THEN 'guest' ELSE 'member' END source,c.status review_status,c.review_stage,
        f.content_type,f.size file_size,COALESCE(f.etag,'') etag,h.sha256
      FROM cases c JOIN case_files f ON f.case_id=c.id LEFT JOIN campaigns cam ON cam.campaign_id=c.campaign_id
      LEFT JOIN proof_exact_hashes h ON f.upload_intent_id IS NULL AND h.file_id=f.id AND h.source_etag=f.etag AND h.source_size=f.size
      WHERE ${where.sql} AND EXISTS(SELECT 1 FROM export_jobs WHERE id=?) ORDER BY c.created_at,c.id,f.id LIMIT ${EXPORT_LIMITS.maxJobFiles + 1}
    ), packed(ordinal,package_no,n,bytes) AS (
      SELECT ordinal,1,1,file_size FROM ordered WHERE ordinal=1
      UNION ALL SELECT o.ordinal, p.package_no + CASE WHEN p.n>=${EXPORT_LIMITS.maxFiles} OR p.bytes+o.file_size>${packageBytes} THEN 1 ELSE 0 END,
        CASE WHEN p.n>=${EXPORT_LIMITS.maxFiles} OR p.bytes+o.file_size>${packageBytes} THEN 1 ELSE p.n+1 END,
        CASE WHEN p.n>=${EXPORT_LIMITS.maxFiles} OR p.bytes+o.file_size>${packageBytes} THEN o.file_size ELSE p.bytes+o.file_size END
      FROM packed p JOIN ordered o ON o.ordinal=p.ordinal+1
    ) INSERT INTO export_job_items SELECT ?,o.ordinal,p.package_no,o.file_id,o.case_id,o.created_at,o.campaign_id,o.campaign_name,o.vote_type,o.source,o.review_status,o.review_stage,o.content_type,o.file_size,o.etag,o.sha256 FROM ordered o JOIN packed p ON p.ordinal=o.ordinal`,
      )
      .bind(...where.values, id, id),
    db
      .prepare(
        "INSERT INTO export_packages(job_id,number,image_count,total_bytes) SELECT job_id,package_no,COUNT(*),SUM(file_size) FROM export_job_items WHERE job_id=? GROUP BY package_no",
      )
      .bind(id),
    db
      .prepare(
        `UPDATE export_jobs SET image_count=(SELECT COUNT(*) FROM export_job_items WHERE job_id=?),total_bytes=(SELECT COALESCE(SUM(file_size),0) FROM export_job_items WHERE job_id=?),sealed=1 WHERE id=?`,
      )
      .bind(id, id, id),
  ]);
}
