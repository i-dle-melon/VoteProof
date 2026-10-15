import { CaseError } from "../api/case-validation.js";
import { validUploadedObject } from "../api/upload-validation.js";
import { requireSubmissionRow } from "./submission-gate.js";
import { requireCaseCampaignRow } from "./campaign-policy.js";
import { r2VerifiedSha256 } from "./r2-verified-checksum.js";

// No completed-upload, manifest or image-analysis tables on this path.
export const DIRECT_CASE_POLICY_SQL = `SELECT s.submissions_enabled,s.submissions_message,
  p.campaign_id,p.category,p.solo_target,p.status,p.start_at,p.end_at,p.vote_start_date,p.vote_end_date,p.version,
  i.session_id,i.proof_id,i.object_key,i.campaign_id intent_campaign_id,i.member_id intent_member_id,
  i.guest_capability_hash,i.content_type,i.size,i.expected_sha256,i.expires_at,i.state,i.consumed_case_id,i.completion_mode
  FROM (SELECT 1) anchor LEFT JOIN submission_settings s ON s.id=1
  LEFT JOIN campaigns p ON p.campaign_id=? LEFT JOIN proof_upload_intents i ON i.session_id=?`;

export async function directCasePreflight(db, input) {
  const row = await db
    .prepare(DIRECT_CASE_POLICY_SQL)
    .bind(input.campaignId, input.sessionId)
    .first();
  requireSubmissionRow(row?.submissions_enabled == null ? null : row);
  const campaign = requireCaseCampaignRow(row?.campaign_id ? row : null, input);
  if (
    !row.session_id ||
    row.completion_mode !== "direct" ||
    input.keys.length !== 1 ||
    input.keys[0] !== row.object_key
  )
    throw new CaseError(409, "UPLOAD_INTENT_INVALID", "Invalid direct upload reference");
  if (
    row.intent_member_id !== (input.memberId ?? null) ||
    (!input.memberId &&
      (!input.guestCapabilityHash || row.guest_capability_hash !== input.guestCapabilityHash)) ||
    row.intent_campaign_id !== input.campaignId
  )
    throw new CaseError(403, "UPLOAD_OWNER_MISMATCH", "Proof does not belong to this submission");
  if (row.consumed_case_id || row.state === "consumed")
    throw new CaseError(409, "UPLOAD_ALREADY_USED", "Upload has already been used");
  if (row.expires_at <= new Date().toISOString() || ["deleting", "deleted"].includes(row.state))
    throw new CaseError(409, "UPLOAD_SESSION_EXPIRED", "Upload has expired");
  if (row.state !== "prepared")
    throw new CaseError(409, "UPLOAD_INTENT_INVALID", "Invalid direct upload state");
  return { campaign, intent: row };
}

export async function directProofFile(bucket, intent) {
  let object;
  try {
    object = await bucket.head(intent.object_key);
  } catch {
    throw new CaseError(502, "R2_STORAGE_ERROR", "Proof storage is unavailable");
  }
  if (!object) throw new CaseError(400, "UPLOAD_INCOMPLETE", "Uploaded proof is missing");
  if (
    !validUploadedObject(intent.object_key, object) ||
    object.size !== intent.size ||
    object.httpMetadata?.contentType !== intent.content_type ||
    r2VerifiedSha256(object) !== intent.expected_sha256 ||
    typeof object.etag !== "string" ||
    !object.etag
  )
    throw new CaseError(409, "UPLOAD_CHANGED", "Uploaded proof metadata or checksum changed");
  return {
    id: intent.proof_id,
    key: intent.object_key,
    size: object.size,
    type: intent.content_type,
    etag: object.etag,
  };
}

export async function insertDirectCase(db, input, record, file) {
  let result;
  try {
    result = await db.batch([
      db
        .prepare(
          `INSERT INTO cases(id,case_id,created_at,updated_at,nickname,player_id,campaign_id,vote_type,
        vote_date,query_key_hash,note,upload_intent_id,member_id,source)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM proof_upload_intents i
        WHERE i.session_id=? AND i.completion_mode='direct' AND i.state='prepared' AND i.consumed_case_id IS NULL
        AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND i.object_key=? AND i.proof_id=?
        AND i.campaign_id=? AND i.member_id IS ? AND (? IS NOT NULL OR i.guest_capability_hash=?)
        AND EXISTS(SELECT 1 FROM submission_settings WHERE id=1 AND submissions_enabled=1)
        AND EXISTS(SELECT 1 FROM campaigns p WHERE p.campaign_id=i.campaign_id AND p.version=? AND p.status='active'
          AND p.start_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND p.end_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND ? BETWEEN p.vote_start_date AND p.vote_end_date AND p.category=?
          AND (p.category='團體' OR (p.category='Solo' AND p.solo_target IS NOT NULL)))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM members m JOIN auth_sessions s ON s.member_id=m.member_id
          WHERE m.member_id=? AND m.status='active' AND s.token_hash=? AND s.revoked_at IS NULL
          AND s.expires_at>CAST(strftime('%s','now') AS INTEGER)
          AND NOT EXISTS(SELECT 1 FROM auth_password_operations o WHERE o.member_id=m.member_id AND o.status='pending')))
        RETURNING id`,
        )
        .bind(
          record.id,
          record.caseId,
          record.now,
          record.now,
          input.nickname,
          input.playerId,
          input.campaignId,
          input.voteType,
          input.voteDate,
          record.queryHash,
          input.note,
          input.sessionId,
          input.memberId ?? null,
          input.memberId ? "member" : "guest",
          input.sessionId,
          file.key,
          file.id,
          input.campaignId,
          input.memberId ?? null,
          input.memberId ?? null,
          input.guestCapabilityHash ?? null,
          input.campaignVersion,
          input.voteDate,
          input.voteType,
          input.memberId ?? null,
          input.memberId ?? null,
          input.sessionHash ?? null,
        ),
      // The Case INSERT trigger consumes this exact intent. The file guard and
      // deferred Case->file FK make a partial Case/consume commit impossible.
      db
        .prepare(
          `INSERT INTO case_files(id,case_id,object_key,content_type,size,etag,created_at,upload_intent_id)
        SELECT ?,?,?,?,?,?,?,? FROM cases WHERE id=?`,
        )
        .bind(
          file.id,
          record.id,
          file.key,
          file.type,
          file.size,
          file.etag,
          record.now,
          input.sessionId,
          record.id,
        ),
      db
        .prepare(
          `INSERT INTO case_idempotency(key_hash,request_hash,case_id,query_seed,created_at)
        SELECT ?,?,?,?,? FROM cases WHERE id=?`,
        )
        .bind(
          record.idempotency.keyHash,
          record.idempotency.requestHash,
          record.id,
          record.idempotency.seed,
          record.now,
          record.id,
        ),
    ]);
  } catch {
    // Resolve an ACK lost after the whole transaction committed. Otherwise the
    // outer handler replays a competing same-key winner or returns a safe error.
    const row = await db
      .prepare("SELECT consumed_case_id FROM proof_upload_intents WHERE session_id=?")
      .bind(input.sessionId)
      .first();
    if (row?.consumed_case_id === record.id) return;
    if (row?.consumed_case_id)
      throw new CaseError(409, "UPLOAD_ALREADY_USED", "Upload has already been used");
    await directCasePreflight(db, input);
    throw new CaseError(500, "DATABASE_ERROR", "Case storage is unavailable");
  }
  if (result[0]?.results?.[0]?.id !== record.id) {
    const fresh = await directCasePreflight(db, input);
    if (fresh.campaign.version !== input.campaignVersion)
      throw new CaseError(409, "CAMPAIGN_CONFLICT", "Campaign changed; retry submission");
    throw new CaseError(409, "CASE_CONFLICT", "Case authorization or upload state changed");
  }
}
