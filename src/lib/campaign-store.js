import { ELEVATED_AUTH_GUARD, actorBindings, adminDenied, AdminError } from "./admin-identity.js";
import { campaignConflict, campaignMissing, campaignUpdatePolicy, CAMPAIGN_ID, CAMPAIGN_STATUSES } from "./campaign-policy.js";
import { encodeCursor } from "../api/admin-validation.js";

export const PUBLIC_CAMPAIGN_COLUMNS = "campaign_id, name, category, start_at, end_at, campaign_timezone, vote_start_date, vote_end_date, points_per_proof, daily_limit, status";
export const campaignRow = (db, id) => db.prepare("SELECT * FROM campaigns WHERE campaign_id = ?").bind(id).first();
export async function publicCampaigns(db) {
  const now = new Date().toISOString();
  return (await db.prepare(`SELECT ${PUBLIC_CAMPAIGN_COLUMNS} FROM campaigns
    WHERE status = 'active' AND start_at <= ? AND end_at > ? ORDER BY start_at, campaign_id`).bind(now, now).all()).results;
}
export const campaignSummarySql = alias => `json_object('campaign_id', ${alias}.campaign_id, 'name', ${alias}.name,
  'category', ${alias}.category, 'start_at', ${alias}.start_at, 'end_at', ${alias}.end_at,
  'campaign_timezone', ${alias}.campaign_timezone, 'points_per_proof', ${alias}.points_per_proof,
  'daily_limit', ${alias}.daily_limit, 'status', ${alias}.status, 'version', ${alias}.version)`;
const summary = row => Object.fromEntries(["campaign_id", "name", "category", "start_at", "end_at", "campaign_timezone", "points_per_proof", "daily_limit", "status", "version"].map(k => [k, row[k]]));
const campaignResult = row => { const { last_mutation_id, ...safe } = row; return safe; };
export async function saveCampaign(db, actor, input, existing = null) {
  if (existing) campaignUpdatePolicy(existing, input);
  const id = existing?.campaign_id ?? input.campaign_id, marker = crypto.randomUUID(), now = new Date().toISOString();
  const values = [input.name, input.category, input.start_at, input.end_at, input.campaign_timezone,
    input.vote_start_date, input.vote_end_date, input.points_per_proof, input.daily_limit, input.status, input.note];
  const statement = existing
    ? db.prepare(`UPDATE campaigns SET name = ?, category = ?, start_at = ?, end_at = ?, campaign_timezone = ?,
        vote_start_date = ?, vote_end_date = ?, points_per_proof = ?, daily_limit = ?, status = ?, note = ?,
        updated_at = ?, updated_by = ?, version = version + 1, last_mutation_id = ?
        WHERE campaign_id = ? AND version = ? AND status = ? AND ${ELEVATED_AUTH_GUARD}`)
      .bind(...values, now, actor.member.member_id, marker, id, input.expected_version, existing.status, ...actorBindings(actor))
    : db.prepare(`INSERT INTO campaigns (name, category, start_at, end_at, campaign_timezone, vote_start_date, vote_end_date,
        points_per_proof, daily_limit, status, note, campaign_id, created_at, updated_at, created_by, updated_by, last_mutation_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${ELEVATED_AUTH_GUARD}`)
      .bind(...values, id, now, now, actor.member.member_id, actor.member.member_id, marker, ...actorBindings(actor));
  let result;
  try {
    result = await db.batch([
      statement,
      db.prepare(`INSERT INTO admin_audit_logs (id, created_at, admin_member_id, admin_role, action, target_type,
        target_id, target_version, before_json, after_json)
        SELECT ?, ?, ?, ?, ?, 'campaign', c.campaign_id, c.version, ?, ${campaignSummarySql("c")}
        FROM campaigns c WHERE c.campaign_id = ? AND c.last_mutation_id = ?`)
        .bind(marker, now, actor.member.member_id, actor.role, existing ? "campaign_update" : "campaign_create", JSON.stringify(existing ? summary(existing) : {}), id, marker),
      db.prepare("SELECT * FROM campaigns WHERE campaign_id = ? AND last_mutation_id = ?").bind(id, marker),
    ]);
  } catch {
    // Resolve an acknowledged-lost batch without treating an older row as ours.
    const stored = await campaignRow(db, id);
    if (stored?.last_mutation_id === marker) return campaignResult(stored);
    if (!existing && stored) throw new AdminError(409, "CAMPAIGN_EXISTS", "Campaign already exists");
    throw new AdminError(503, "CAMPAIGN_SERVICE_UNAVAILABLE", "Campaign service is unavailable");
  }
  if (result[0].meta.changes !== 1) { if (existing) throw campaignConflict(); throw adminDenied(); }
  return campaignResult(result[2].results[0]);
}
export async function getAdminCampaign(db, id) {
  if (!CAMPAIGN_ID.test(id) || id.length > 100) throw campaignMissing();
  const row = await campaignRow(db, id); if (!row) throw campaignMissing();
  return campaignResult(row);
}
export async function listCampaigns(db, url) {
  const invalid = () => { throw new AdminError(400, "INVALID_ADMIN_QUERY", "Invalid campaign pagination"); };
  for (const k of url.searchParams.keys()) if (!["status", "limit", "cursor"].includes(k) || url.searchParams.getAll(k).length !== 1) invalid();
  const status = url.searchParams.get("status"), raw = url.searchParams.get("limit"), limit = raw === null ? 20 : Number(raw);
  if (status !== null && !CAMPAIGN_STATUSES.includes(status) || raw !== null && !/^[1-9]\d?$/.test(raw) || limit > 50) invalid();
  const clauses = [], values = []; if (status) { clauses.push("status = ?"); values.push(status); }
  const encoded = url.searchParams.get("cursor");
  if (encoded !== null) {
    try {
      if (encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
      const cursor = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")));
      if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== status || typeof cursor[1] !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor[1]) || !Number.isFinite(Date.parse(cursor[1])) ||
        typeof cursor[2] !== "string" || cursor[2].length > 100 || !CAMPAIGN_ID.test(cursor[2])) invalid();
      clauses.push("(created_at < ? OR (created_at = ? AND campaign_id < ?))"); values.push(cursor[1], cursor[1], cursor[2]);
    } catch { invalid(); }
  }
  const rows = (await db.prepare(`SELECT * FROM campaigns ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
    ORDER BY created_at DESC, campaign_id DESC LIMIT ?`).bind(...values, limit + 1).all()).results;
  const selected = rows.slice(0, limit), last = selected.at(-1);
  return { campaigns: selected.map(campaignResult), next_cursor: rows.length > limit ? encodeCursor([status, last.created_at, last.campaign_id]) : null };
}
