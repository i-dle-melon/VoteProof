import { CaseError } from "../api/case-validation.js";
import { uploadState } from "./completed-uploads.js";

export async function insertCase(db, input, record, files, manifest) {
  let results;
  try {
    // D1 batch is transactional. The guarded INSERT and unique upload_session_id
    // serialize consumption, including simultaneous requests on different Workers.
    results = await db.batch([
      db.prepare(`INSERT INTO cases
        (id, case_id, created_at, updated_at, nickname, player_id, campaign_id, vote_type,
         vote_date, query_key_hash, note, upload_session_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM completed_uploads
        WHERE session_id = ? AND manifest_hash = ? AND consumed_case_id IS NULL
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
        .bind(record.id, record.caseId, record.now, record.now, input.nickname, input.playerId,
          input.campaignId, input.voteType, input.voteDate, record.queryHash, input.note,
          input.sessionId, input.sessionId, manifest),
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
