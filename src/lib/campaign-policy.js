import { AdminError } from "./admin-identity.js";
import { CaseError } from "../api/case-validation.js";

export const CAMPAIGN_LIMITS = Object.freeze({ id: 100, name: 100, category: 50, note: 1000, points: 1000000, daily: 1000 });
export const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export const CAMPAIGN_STATUSES = Object.freeze(["draft", "active", "closed", "archived"]);
export const invalidCampaign = () => new AdminError(400, "INVALID_CAMPAIGN_REQUEST", "Invalid campaign request");
export const campaignConflict = () => new AdminError(409, "CAMPAIGN_CONFLICT", "Campaign version or policy has changed");
export const campaignMissing = () => new AdminError(404, "CAMPAIGN_NOT_FOUND", "Campaign not found");
const fields = ["name", "category", "start_at", "end_at", "campaign_timezone", "points_per_proof", "daily_limit", "status", "note"];
const text = (v, max) => {
  if (typeof v !== "string" || !v.trim() || [...v.trim()].length > max || /[\u0000-\u001f\u007f]/.test(v)) throw invalidCampaign();
  return v.trim();
};
function instant(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ||
      !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v || v < "2000" || v >= "9999") throw invalidCampaign();
  return v;
}
export function campaignDate(instantValue, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instantValue));
  const value = type => parts.find(part => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
export function campaignInput(body, updating = false) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => ![...fields, updating ? "expected_version" : "campaign_id"].includes(k))) throw invalidCampaign();
  const result = { name: text(body.name, CAMPAIGN_LIMITS.name), category: text(body.category, CAMPAIGN_LIMITS.category), start_at: instant(body.start_at), end_at: instant(body.end_at) };
  if (result.start_at >= result.end_at) throw invalidCampaign();
  const timezone = body.campaign_timezone ?? "UTC";
  if (typeof timezone !== "string" || timezone.length > 100) throw invalidCampaign();
  try { result.campaign_timezone = new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone; } catch { throw invalidCampaign(); }
  for (const [key, max] of [["points_per_proof", CAMPAIGN_LIMITS.points], ["daily_limit", CAMPAIGN_LIMITS.daily]]) {
    if (!Number.isSafeInteger(body[key]) || body[key] < 0 || body[key] > max) throw invalidCampaign();
    result[key] = body[key];
  }
  if (!CAMPAIGN_STATUSES.includes(body.status)) throw invalidCampaign();
  result.status = body.status;
  result.note = body.note == null ? null : text(body.note, CAMPAIGN_LIMITS.note);
  result.vote_start_date = campaignDate(result.start_at, result.campaign_timezone);
  result.vote_end_date = campaignDate(Date.parse(result.end_at) - 1, result.campaign_timezone);
  if (updating) {
    if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 0 || body.expected_version >= Number.MAX_SAFE_INTEGER) throw invalidCampaign();
    result.expected_version = body.expected_version;
  } else {
    if (typeof body.campaign_id !== "string" || body.campaign_id.length > CAMPAIGN_LIMITS.id || !CAMPAIGN_ID.test(body.campaign_id)) throw invalidCampaign();
    result.campaign_id = body.campaign_id;
    if (!["draft", "active"].includes(result.status)) throw invalidCampaign();
  }
  return result;
}
export function campaignUpdatePolicy(row, input) {
  if (row.version !== input.expected_version || row.status === "archived") throw campaignConflict();
  const next = { draft: ["draft", "active", "archived"], active: ["active", "closed"], closed: ["closed", "archived"] };
  if (!next[row.status]?.includes(input.status) || (row.status !== "draft" &&
    ["start_at", "end_at", "campaign_timezone"].some(k => row[k] !== input[k]))) throw campaignConflict();
}
export async function requireCaseCampaign(db, input, now = new Date().toISOString()) {
  const row = await db.prepare("SELECT * FROM campaigns WHERE campaign_id = ?").bind(input.campaignId).first();
  if (!row) throw new CaseError(400, "CAMPAIGN_NOT_FOUND", "Campaign does not exist");
  if (row.status !== "active" || row.start_at > now || row.end_at <= now) throw new CaseError(400, "CAMPAIGN_NOT_OPEN", "Campaign is not accepting submissions");
  if (input.voteDate < row.vote_start_date || input.voteDate > row.vote_end_date) throw new CaseError(400, "VOTE_DATE_OUTSIDE_CAMPAIGN", "Vote date is outside the campaign window");
  return row;
}
export async function reviewCampaign(db, row) {
  const campaign = await db.prepare("SELECT * FROM campaigns WHERE campaign_id = ?").bind(row.campaign_id).first();
  if (!campaign || !["active", "closed"].includes(campaign.status) || row.vote_date < campaign.vote_start_date || row.vote_date > campaign.vote_end_date) {
    throw new AdminError(409, "CAMPAIGN_NOT_REVIEWABLE", "Campaign does not allow this approval");
  }
  return campaign;
}
