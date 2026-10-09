import { AdminError } from './admin-identity.js';
import { CAMPAIGN_ID } from './campaign-policy.js';

export const BOARD_LIMITS = Object.freeze({ top: 100, name: 100, page: 50 });
export const boardInvalid = () => new AdminError(400, 'INVALID_LEADERBOARD_REQUEST', 'Invalid leaderboard request');
export const boardConflict = () => new AdminError(409, 'LEADERBOARD_CONFLICT', 'Leaderboard version or policy changed');
export const boardMissing = () => new AdminError(404, 'LEADERBOARD_NOT_FOUND', 'Leaderboard not found');
const fields = ['name', 'type', 'campaign_id', 'start_date', 'end_date', 'vote_type', 'top_n', 'is_public', 'status'];
export function boardInput(body, updating = false) {
  const bad = () => { throw boardInvalid(); };
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => ![...fields, updating ? 'expected_version' : 'leaderboard_id'].includes(k))) bad();
  if (typeof body.name !== 'string' || !body.name.trim() || [...body.name.trim()].length > BOARD_LIMITS.name || /[\u0000-\u001f\u007f]/.test(body.name)) bad();
  const result = { name: body.name.trim(), type: body.type, campaign_id: body.campaign_id ?? null,
    start_date: body.start_date ?? null, end_date: body.end_date ?? null, vote_type: body.vote_type ?? null,
    top_n: body.top_n, is_public: body.is_public, status: body.status };
  if (!['all_time', 'campaign', 'custom'].includes(result.type) || !['draft', 'active', 'archived'].includes(result.status) ||
      !Number.isSafeInteger(result.top_n) || result.top_n < 1 || result.top_n > BOARD_LIMITS.top || typeof result.is_public !== 'boolean' ||
      ![null, 'Solo', '團體'].includes(result.vote_type)) bad();
  if (result.campaign_id !== null && (typeof result.campaign_id !== 'string' || !CAMPAIGN_ID.test(result.campaign_id))) bad();
  const day = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00.000Z')) && new Date(v + 'T00:00:00.000Z').toISOString().slice(0, 10) === v;
  if (result.type === 'custom') { if (!day(result.start_date) || !day(result.end_date) || result.start_date > result.end_date) bad(); }
  else if (result.start_date !== null || result.end_date !== null) bad();
  if (result.type === 'campaign' && result.campaign_id === null || result.type === 'all_time' && result.campaign_id !== null) bad();
  if (updating) { if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 0 || body.expected_version >= Number.MAX_SAFE_INTEGER) bad(); result.expected_version = body.expected_version; }
  else { if (typeof body.leaderboard_id !== 'string' || !CAMPAIGN_ID.test(body.leaderboard_id) || result.status === 'archived') bad(); result.leaderboard_id = body.leaderboard_id; }
  return result;
}
export function rebuildInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Number.isSafeInteger(body.expected_version) || body.expected_version < 0 || body.expected_version >= Number.MAX_SAFE_INTEGER) throw boardInvalid();
  return body.expected_version;
}
