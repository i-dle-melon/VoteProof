import { jsonSuccess, jsonError } from "./response.js";
import { adminHandler } from "./admin-response.js";
import { adminIdentity, adminCsrf, ELEVATED_ROLES, ELEVATED_AUTH_GUARD, actorBindings, AdminError } from "../lib/admin-identity.js";
import { authDatabase } from "../lib/auth-session.js";
import { readReviewJson } from "./admin-validation.js";
import { submissionSettings, publicSubmissionSettings, safeSubmissionMessage, SubmissionError } from "../lib/submission-gate.js";

export async function getSubmissionStatus(env) {
  try { return jsonSuccess(publicSubmissionSettings(await submissionSettings(env.DB))); }
  catch (e) { return jsonError(503, e instanceof SubmissionError ? e.code : "SUBMISSIONS_UNAVAILABLE", "Submission service is unavailable"); }
}
export const readAdminSubmissionSettings = adminHandler(async (env, _url, request) => {
  await adminIdentity(request, env, ELEVATED_ROLES);
  return jsonSuccess(await submissionSettings(authDatabase(env)));
});
export const updateAdminSubmissionSettings = adminHandler(async (env, _url, request) => {
  const actor = await adminIdentity(request, env, ELEVATED_ROLES); await adminCsrf(request, env, actor);
  const body = await readReviewJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["submissions_enabled","submissions_message","expected_version"].includes(k)) ||
      typeof body.submissions_enabled !== "boolean" || !safeSubmissionMessage(body.submissions_message) ||
      !Number.isSafeInteger(body.expected_version) || body.expected_version < 0 || body.expected_version >= Number.MAX_SAFE_INTEGER) {
    throw new AdminError(400, "INVALID_SUBMISSION_SETTINGS", "Invalid submission settings");
  }
  const db = authDatabase(env), before = await submissionSettings(db);
  if (before.version !== body.expected_version) throw new AdminError(409, "SUBMISSION_SETTINGS_CONFLICT", "Submission settings changed; reload and retry");
  const marker = crypto.randomUUID(), now = new Date().toISOString();
  const result = await db.batch([
    db.prepare(`UPDATE submission_settings SET submissions_enabled=?, submissions_message=?, version=version+1,
      updated_at=?, updated_by=?, last_mutation_id=? WHERE id=1 AND version=? AND ${ELEVATED_AUTH_GUARD}`)
      .bind(Number(body.submissions_enabled), body.submissions_message, now, actor.member.member_id, marker, body.expected_version, ...actorBindings(actor)),
    db.prepare(`INSERT INTO submission_settings_audit(id,created_at,admin_member_id,admin_role,version,before_json,after_json)
      SELECT ?,?,?,?,?,?,json_object('submissions_enabled',submissions_enabled,'submissions_message',submissions_message,'version',version)
      FROM submission_settings WHERE id=1 AND last_mutation_id=?`)
      .bind(marker, now, actor.member.member_id, actor.role, body.expected_version+1, JSON.stringify(before), marker),
    db.prepare("SELECT submissions_enabled,submissions_message,version FROM submission_settings WHERE id=1 AND last_mutation_id=?").bind(marker),
  ]);
  if (result[0].meta.changes !== 1) throw new AdminError(409, "SUBMISSION_SETTINGS_CONFLICT", "Submission settings or authorization changed; reload and retry");
  const row = result[2].results[0]; return jsonSuccess({ ...row, submissions_enabled: row.submissions_enabled === 1 });
});
