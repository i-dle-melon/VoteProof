import { CaseError } from "../api/case-validation.js";
import { uploadState } from "./completed-uploads.js";
import { AuthError, suspended } from "../api/auth-validation.js";
import { requireCaseCampaign } from "./campaign-policy.js";

export async function insertCase(db, input, record, files, manifest) {
  let results;
  try {
    // D1 batch is transactional. The guarded INSERT and unique upload_session_id
    // serialize consumption, including simultaneous requests on different Workers.
    results = await db.batch([
      db.prepare(`INSERT INTO cases
        (id, case_id, created_at, updated_at, nickname, player_id, campaign_id, vote_type,
         vote_date, query_key_hash, note, upload_session_id, member_id, source)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM completed_uploads
        WHERE session_id = ? AND manifest_hash = ? AND consumed_case_id IS NULL
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND EXISTS (SELECT 1 FROM campaigns p WHERE p.campaign_id = ? AND p.version = ? AND p.status = 'active'
          AND p.start_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND p.end_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND ? BETWEEN p.vote_start_date AND p.vote_end_date)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM members m JOIN auth_sessions s ON s.member_id = m.member_id
          WHERE m.member_id = ? AND m.status = 'active' AND s.token_hash = ? AND s.revoked_at IS NULL
          AND s.expires_at > CAST(strftime('%s', 'now') AS INTEGER)))`)
        .bind(record.id, record.caseId, record.now, record.now, input.nickname, input.playerId,
          input.campaignId, input.voteType, input.voteDate, record.queryHash, input.note,
          input.sessionId, input.memberId ?? null, input.memberId ? "member" : "guest", input.sessionId, manifest,
          input.campaignId, input.campaignVersion, input.voteDate,
          input.memberId ?? null, input.memberId ?? null, input.sessionHash ?? null),
      ...files.map(file => db.prepare(`INSERT INTO case_files
        (id, case_id, object_key, content_type, size, etag, created_at, upload_object_key)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM cases WHERE id = ?`)
        .bind(file.id, record.id, file.key, file.type, file.size, file.etag, record.now, file.sourceKey, record.id)),
      db.prepare(`UPDATE completed_uploads SET consumed_case_id = ?, consumed_at = ?
        WHERE session_id = ? AND manifest_hash = ? AND consumed_case_id IS NULL
        AND EXISTS (SELECT 1 FROM cases WHERE id = ?)`)
        .bind(record.id, record.now, input.sessionId, manifest, record.id),
      ...(record.idempotency ? [db.prepare(`INSERT INTO case_idempotency
        (key_hash, request_hash, case_id, query_seed, created_at)
        SELECT ?, ?, ?, ?, ? FROM cases WHERE id = ?`)
        .bind(record.idempotency.keyHash, record.idempotency.requestHash, record.id,
          record.idempotency.seed, record.now, record.id)] : []),
    ]);
  } catch {
    // A lost acknowledgement can be ambiguous. Confirm the atomic batch's result
    // before deciding to remove R2 copies; never delete a possibly committed case.
    try {
      const state = await uploadState(db, input.sessionId);
      if (state?.consumed_case_id === record.id) return;
      if (state?.consumed_case_id) throw new CaseError(409, "UPLOAD_ALREADY_USED", "Upload has already been used");
    } catch (error) {
      if (error instanceof CaseError) throw error;
      const unavailable = new CaseError(500, "DATABASE_ERROR", "Case storage is unavailable");
      unavailable.preserveArchives = true;
      throw unavailable;
    }
    throw new CaseError(500, "DATABASE_ERROR", "Case storage is unavailable");
  }
  if (results[0]?.meta?.changes !== 1) {
    const campaign = await requireCaseCampaign(db, input);
    if (campaign.version !== input.campaignVersion) throw new CaseError(409, "CAMPAIGN_CONFLICT", "Campaign changed; retry submission");
    if (input.memberId) {
      const member = await db.prepare("SELECT status FROM members WHERE member_id = ?").bind(input.memberId).first();
      if (member?.status !== "active") throw suspended();
      const session = await db.prepare(`SELECT token_hash FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL
        AND expires_at > CAST(strftime('%s', 'now') AS INTEGER)`).bind(input.sessionHash).first();
      if (!session) throw new AuthError(401, "AUTH_REQUIRED", "Authentication is required");
    }
    const state = await uploadState(db, input.sessionId);
    if (state && !state.consumed_case_id && state.expires_at <= new Date().toISOString()) {
      throw new CaseError(409, "UPLOAD_SESSION_EXPIRED", "Completed upload has expired; prepare a new upload");
    }
    throw new CaseError(409, "UPLOAD_ALREADY_USED", "Upload has already been used");
  }
}

export const guestCase = (db, id) => db.prepare(`SELECT id, case_id, created_at, nickname,
  campaign_id, vote_type, vote_date, status, points_awarded, query_key_hash
  FROM cases WHERE case_id = ?`).bind(id).first();

export async function guestFiles(db, internalId) {
  return (await db.prepare("SELECT content_type, size FROM case_files WHERE case_id = ? ORDER BY id")
    .bind(internalId).all()).results;
}
