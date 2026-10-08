import { AdminError, ELEVATED_AUTH_GUARD, actorBindings, adminDenied } from "./admin-identity.js";
import { sha256 } from "./case-keys.js";
import { UUID_PATTERN } from "../api/admin-validation.js";

export const POINT_LIMITS = Object.freeze({ adjustment: 1000000, reason: 500, idempotencyMin: 16, idempotencyMax: 128 });
// Positive, actually rewarded proofs occupy capacity; an exact compensating
// reversal releases one slot. All expressions below are fixed SQL identifiers.
export const dailyUsageSql = alias => `(SELECT COALESCE(SUM(CASE WHEN t.category IN ('proof_approved', 'proof_reapproved') THEN 1
  WHEN t.category = 'proof_revoked' THEN -1 ELSE 0 END), 0) FROM point_transactions t
  WHERE t.member_id = ${alias}.member_id AND t.campaign_id = ${alias}.campaign_id AND t.vote_date = ${alias}.vote_date)`;

export function reviewPointStatements(db, actor, row, input, marker, now, campaign) {
  if (!["approve", "revoke"].includes(input.action)) return [];
  const transactionId = crypto.randomUUID(), reason = input.reason ?? "Proof approved";
  const insert = input.action === "approve"
    ? db.prepare(`INSERT INTO point_transactions (transaction_id, created_at, member_id, case_id, campaign_id, category,
        vote_type, vote_date, points, reason, created_by, metadata_json)
        SELECT ?, ?, c.member_id, c.id, c.campaign_id, 'proof_approved', c.vote_type, c.vote_date, p.points_per_proof, ?, ?,
          json_object('campaign_version', p.version, 'campaign_category', p.category, 'campaign_timezone', p.campaign_timezone,
            'points_per_proof', p.points_per_proof, 'daily_limit', p.daily_limit)
        FROM cases c JOIN campaigns p ON p.campaign_id = c.campaign_id
        WHERE c.id = ? AND c.last_review_id = ? AND c.member_id IS NOT NULL AND p.points_per_proof > 0
          AND ${dailyUsageSql("c")} < p.daily_limit`)
      .bind(transactionId, now, reason, actor.member.member_id, row.id, marker)
    : db.prepare(`INSERT INTO point_transactions (transaction_id, created_at, member_id, case_id, campaign_id, category,
        vote_type, vote_date, points, reason, created_by, reference_transaction_id, metadata_json)
        SELECT ?, ?, t.member_id, t.case_id, t.campaign_id, 'proof_revoked', t.vote_type, t.vote_date, -t.points, ?, ?,
          t.transaction_id, t.metadata_json FROM cases c JOIN point_transactions t ON t.case_id = c.id
        WHERE c.id = ? AND c.last_review_id = ? AND t.category IN ('proof_approved', 'proof_reapproved')
          AND NOT EXISTS (SELECT 1 FROM point_transactions r WHERE r.category = 'proof_revoked' AND r.reference_transaction_id = t.transaction_id)`)
      .bind(transactionId, now, reason, actor.member.member_id, row.id, marker);
  const pointStatus = input.action === "revoke" ? "revoked" : campaign.points_per_proof === 0 ? "zero_value_campaign" : "daily_limit";
  return [insert, db.prepare(`UPDATE cases SET points_awarded = COALESCE((SELECT SUM(t.points) FROM point_transactions t WHERE t.case_id = cases.id), 0),
      point_status = CASE WHEN ? = 'revoke' THEN 'revoked' WHEN member_id IS NULL THEN 'guest_no_points'
        WHEN EXISTS (SELECT 1 FROM point_transactions t WHERE t.transaction_id = ?) THEN 'awarded' ELSE ? END,
      point_transaction_id = (SELECT transaction_id FROM point_transactions WHERE transaction_id = ?)
      WHERE id = ? AND last_review_id = ?`)
    .bind(input.action, transactionId, pointStatus, transactionId, row.id, marker)];
}
export async function pointSummary(db, memberId) {
  const total = (await db.prepare("SELECT COALESCE(SUM(points), 0) AS total_points FROM point_transactions WHERE member_id = ?").bind(memberId).first()).total_points;
  if (!Number.isSafeInteger(total)) throw new AdminError(503, "POINT_SUMMARY_UNAVAILABLE", "Point summary is unavailable");
  return { total_points: total };
}
export function adjustmentInput(body) {
  const invalid = () => { throw new AdminError(400, "INVALID_POINT_ADJUSTMENT", "Invalid point adjustment"); };
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["member_id", "points", "reason"].includes(k))) invalid();
  if (typeof body.member_id !== "string" || !body.member_id.startsWith("M-") || !UUID_PATTERN.test(body.member_id.slice(2)) || body.member_id.length !== 38 ||
      !Number.isSafeInteger(body.points) || body.points === 0 || Math.abs(body.points) > POINT_LIMITS.adjustment ||
      typeof body.reason !== "string" || !body.reason.trim() || [...body.reason.trim()].length > POINT_LIMITS.reason || /[\u0000-\u001f\u007f]/.test(body.reason)) invalid();
  return { member_id: body.member_id, points: body.points, reason: body.reason.trim() };
}
export async function adjustmentIdentity(request, actor, input) {
  const key = request.headers.get("Idempotency-Key");
  if (typeof key !== "string" || key.length < POINT_LIMITS.idempotencyMin || key.length > POINT_LIMITS.idempotencyMax || !/^[A-Za-z0-9._-]+$/.test(key)) {
    throw new AdminError(400, "INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key is required");
  }
  return { keyHash: await sha256(JSON.stringify(["VoteProof/point-adjustment/v1", actor.member.member_id, key])),
    requestHash: await sha256(JSON.stringify([input.member_id, input.points, input.reason])) };
}
const adjustmentResult = row => ({ transaction_id: row.transaction_id, member_id: row.member_id, points: row.points });
export async function replayAdjustment(db, identity) {
  const row = await db.prepare("SELECT transaction_id, member_id, points, request_hash FROM point_transactions WHERE idempotency_hash = ?").bind(identity.keyHash).first();
  if (!row) return null;
  if (row.request_hash !== identity.requestHash) throw new AdminError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another request");
  return adjustmentResult(row);
}
export async function adjustPoints(db, actor, input, identity) {
  const replay = await replayAdjustment(db, identity); if (replay) return replay;
  if (!await db.prepare("SELECT member_id FROM members WHERE member_id = ?").bind(input.member_id).first()) throw new AdminError(404, "MEMBER_NOT_FOUND", "Member not found");
  const id = crypto.randomUUID(), now = new Date().toISOString();
  let result;
  try {
    result = await db.batch([
      db.prepare(`INSERT INTO point_transactions (transaction_id, created_at, member_id, category, points, reason, created_by, idempotency_hash, request_hash)
        SELECT ?, ?, ?, 'manual_adjustment', ?, ?, ?, ?, ? WHERE ${ELEVATED_AUTH_GUARD}
        AND EXISTS (SELECT 1 FROM members WHERE member_id = ?)
        AND NOT EXISTS (SELECT 1 FROM point_transactions WHERE idempotency_hash = ?)`)
        .bind(id, now, input.member_id, input.points, input.reason, actor.member.member_id, identity.keyHash, identity.requestHash,
          ...actorBindings(actor), input.member_id, identity.keyHash),
      db.prepare(`INSERT INTO admin_audit_logs (id, created_at, admin_member_id, admin_role, action, target_type,
        target_id, target_version, before_json, after_json, reason)
        SELECT ?, ?, ?, ?, 'manual_adjustment', 'point_transaction', transaction_id, 0, '{}',
          json_object('transaction_id', transaction_id, 'member_id', member_id, 'points', points), reason
        FROM point_transactions WHERE transaction_id = ?`)
        .bind(id, now, actor.member.member_id, actor.role, id),
    ]);
  } catch {
    const resolved = await replayAdjustment(db, identity); if (resolved) return resolved;
    throw new AdminError(503, "POINT_SERVICE_UNAVAILABLE", "Point service is unavailable");
  }
  const stored = await replayAdjustment(db, identity);
  if (stored) return stored;
  if (result[0].meta.changes !== 1) throw adminDenied();
  throw new AdminError(503, "POINT_SERVICE_UNAVAILABLE", "Point service is unavailable");
}
