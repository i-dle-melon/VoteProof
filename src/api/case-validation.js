import { readUploadJson, validateComplete, UploadError } from "./upload-validation.js";

export const CASE_LIMITS = Object.freeze({
  nickname: 50, playerId: 100, campaignId: 100, note: 500,
  earliestVoteDate: "2000-01-01", futureDays: 1,
});

export class CaseError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = () => { throw new CaseError(400, "INVALID_CASE_REQUEST", "Invalid case request"); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = new Set(["nickname", "player_id", "campaign_id", "vote_type", "vote_date", "note", "upload_session"]);

export async function readCaseJson(request) {
  // Reuse B2's bounded 16 KiB JSON reader, including streaming bodies and UTF-8.
  try { return await readUploadJson(request); }
  catch (error) {
    if (error instanceof UploadError) {
      throw new CaseError(error.status, error.code === "INVALID_UPLOAD_REQUEST" ? "INVALID_CASE_REQUEST" : error.code,
        error.status === 413 ? "Case metadata is too large" : error.message);
    }
    throw error;
  }
}

function text(value, max) {
  if (typeof value !== "string") invalid();
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) invalid();
  return trimmed;
}

export function validateCase(body, now = new Date()) {
  if (!record(body) || Object.keys(body).some(name => !fields.has(name))) invalid();
  const nickname = text(body.nickname, CASE_LIMITS.nickname);
  const playerId = text(body.player_id, CASE_LIMITS.playerId);
  const campaignId = text(body.campaign_id, CASE_LIMITS.campaignId);
  // TODO B4/B5: validate against the production Campaign source, not demo data.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(campaignId)) invalid();
  if (!["Solo", "團體"].includes(body.vote_type)) invalid();
  if (typeof body.vote_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.vote_date)) invalid();
  const date = new Date(body.vote_date + "T00:00:00Z");
  const latest = new Date(now.valueOf() + CASE_LIMITS.futureDays * 86400000).toISOString().slice(0, 10);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== body.vote_date ||
      body.vote_date < CASE_LIMITS.earliestVoteDate || body.vote_date > latest) invalid();
  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string" || [...body.note.trim()].length > CASE_LIMITS.note || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.note)) invalid();
    note = body.note.trim() || null;
  }
  if (!record(body.upload_session) || Object.keys(body.upload_session).some(name => !["session_id", "keys"].includes(name))) invalid();
  let upload;
  try { upload = validateComplete(body.upload_session); }
  catch { throw new CaseError(400, "INVALID_UPLOAD_REFERENCE", "Invalid completed upload reference"); }
  return { nickname, playerId, campaignId, voteType: body.vote_type, voteDate: body.vote_date, note, ...upload };
}
