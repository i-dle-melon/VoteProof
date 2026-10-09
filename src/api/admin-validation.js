import { AdminError } from "../lib/admin-identity.js";
import { CASE_STATUSES, REVIEW_LIMITS } from "../lib/case-review.js";
import { readUploadJson, UploadError } from "./upload-validation.js";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestamp = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const invalid = () => { throw new AdminError(400, "INVALID_ADMIN_QUERY", "Invalid filters or pagination"); };
export async function readReviewJson(request) {
  try { return await readUploadJson(request); }
  catch (e) {
    if (e instanceof UploadError) throw new AdminError(e.status, e.code === "INVALID_UPLOAD_REQUEST" ? "INVALID_REVIEW_REQUEST" : e.code, "Invalid review JSON body");
    throw e;
  }
}
function day(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !timestamp(value + "T00:00:00.000Z")) invalid();
  return value + "T00:00:00.000Z";
}
export function encodeCursor(value) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function adminPage(url, audit = false) {
  const allowed = audit ? ["action", "target_type", "target_id", "admin_member_id"] : ["status", "campaign_id", "vote_type", "duplicate_flag"];
  allowed.push("created_from", "created_to", "cursor", "limit");
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) invalid();
  const f = Object.fromEntries(allowed.filter(k => !["cursor", "limit"].includes(k)).map(k => [k, url.searchParams.get(k)]));
  if (f.status !== undefined && f.status !== null && !CASE_STATUSES.includes(f.status)) invalid();
  if (f.campaign_id !== undefined && f.campaign_id !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(f.campaign_id)) invalid();
  if (f.vote_type !== undefined && f.vote_type !== null && !["Solo", "團體"].includes(f.vote_type)) invalid();
  if (f.duplicate_flag !== undefined && f.duplicate_flag !== null && !["0", "1"].includes(f.duplicate_flag)) invalid();
  if (audit) {
    if (f.action !== null && !["approve", "reject", "mark_duplicate", "complete", "revoke", "bootstrap_membership", "campaign_create", "campaign_update", "manual_adjustment", "leaderboard_create", "leaderboard_update", "leaderboard_rebuild", "leaderboard_archive"].includes(f.action)) invalid();
    if (f.target_type !== null && !["case", "admin_membership", "campaign", "point_transaction", "leaderboard"].includes(f.target_type)) invalid();
    if (f.target_id !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(f.target_id)) invalid();
    if (f.admin_member_id !== null && (!f.admin_member_id.startsWith("M-") || !UUID_PATTERN.test(f.admin_member_id.slice(2)))) invalid();
  }
  if (f.created_from !== null) f.created_from = day(f.created_from);
  if (f.created_to !== null) f.created_to = new Date(Date.parse(day(f.created_to)) + 86400000).toISOString();
  if (f.created_from && f.created_to && f.created_from >= f.created_to) invalid();
  const raw = url.searchParams.get("limit"), limit = raw === null ? REVIEW_LIMITS.defaultPage : Number(raw);
  if (raw !== null && !/^[1-9]\d?$/.test(raw) || limit > REVIEW_LIMITS.maxPage) invalid();
  const scope = JSON.stringify([audit ? "audit" : "cases", f]);
  const encoded = url.searchParams.get("cursor");
  let cursor = null;
  if (encoded !== null) {
    try {
      if (encoded.length > REVIEW_LIMITS.maxCursor || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0))));
      if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== scope || ![0, 1].includes(parsed[1]) ||
          (audit && parsed[1] !== 0) || !timestamp(parsed[2]) || !UUID_PATTERN.test(parsed[3])) invalid();
      cursor = parsed.slice(1);
    } catch { invalid(); }
  }
  return { filters: f, limit, cursor, scope };
}

export function filterSql(page, alias) {
  const clauses = [], values = [];
  for (const [key, value] of Object.entries(page.filters)) {
    if (value === null) continue;
    if (key === "created_from") clauses.push(`${alias}.created_at >= ?`);
    else if (key === "created_to") clauses.push(`${alias}.created_at < ?`);
    else clauses.push(`${alias}.${key} = ?`); // Keys come from a fixed allowlist above.
    values.push(key === "duplicate_flag" ? Number(value) : value);
  }
  return { clauses, values };
}
