import { actorBindings, REVIEW_AUTH_GUARD } from "./admin-identity.js";
import { statusConflict, reviewTransition, invalidDuplicate } from "./case-review.js";
import { encodeCursor, filterSql } from "../api/admin-validation.js";
import { reviewCampaign } from "./campaign-policy.js";
import { reviewPointStatements } from "./point-ledger.js";

export const QUEUE_RANK = "CASE WHEN c.status = 'pending' THEN 0 ELSE 1 END";
export const SUMMARY_COLUMNS = `c.case_id, c.created_at, c.updated_at, c.nickname, c.player_id, c.campaign_id,
  c.vote_type, c.vote_date, c.status, c.duplicate_flag, c.version, c.points_awarded`;
export async function adminCases(db, page) {
  const { clauses, values } = filterSql(page, "c");
  if (page.cursor) {
    clauses.push(`((${QUEUE_RANK}) > ? OR ((${QUEUE_RANK}) = ? AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?))))`);
    values.push(page.cursor[0], page.cursor[0], page.cursor[1], page.cursor[1], page.cursor[2]);
  }
  const rows = (await db.prepare(`SELECT ${SUMMARY_COLUMNS}, c.id, (${QUEUE_RANK}) AS priority
    FROM cases c ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
    ORDER BY priority, c.created_at DESC, c.id DESC LIMIT ?`).bind(...values, page.limit + 1).all()).results;
  const selected = rows.slice(0, page.limit), last = selected.at(-1);
  return { cases: selected.map(({ id, priority, ...row }) => row),
    next_cursor: rows.length > page.limit ? encodeCursor([page.scope, last.priority, last.created_at, last.id]) : null };
}
export async function adminCase(db, caseId) {
  return db.prepare(`SELECT ${SUMMARY_COLUMNS}, c.id, c.member_id, c.source, c.note, c.status_reason,
    c.status_updated_at, c.status_updated_by, c.reviewed_at, c.reviewer_id, c.point_status, c.point_transaction_id, d.case_id AS duplicate_of_case_id
    FROM cases c LEFT JOIN cases d ON d.id = c.duplicate_of_case_id WHERE c.case_id = ?`).bind(caseId).first();
}
export const adminFiles = async (db, id) => (await db.prepare(`SELECT id AS file_id, content_type, size, created_at
  FROM case_files WHERE case_id = ? ORDER BY id`).bind(id).all()).results;

export async function applyReview(db, actor, row, input) {
  const status = reviewTransition(row, input);
  const campaign = input.action === "approve" ? await reviewCampaign(db, row) : null;
  let target = null;
  if (input.duplicateCaseId) {
    target = await db.prepare("SELECT id, case_id, status FROM cases WHERE case_id = ?").bind(input.duplicateCaseId).first();
    // A canonical proof is approved/completed, never another pending/duplicate.
    // This also prevents duplicate chains and cycles through normal transitions.
    if (!target || target.id === row.id || !["approved", "completed"].includes(target.status)) throw invalidDuplicate();
  }
  const mutationId = crypto.randomUUID(), now = new Date().toISOString();
  const before = JSON.stringify({ status: row.status, version: row.version, duplicate_of_case_id: row.duplicate_of_case_id,
    points_awarded: row.points_awarded, point_status: row.point_status });
  // The unique marker belongs only to this winning UPDATE. A losing UPDATE
  // inserts zero audit rows; an audit failure rolls the entire D1 batch back.
  const result = await db.batch([
    db.prepare(`UPDATE cases SET status = ?, version = version + 1, updated_at = ?, status_reason = ?,
      status_updated_at = ?, status_updated_by = ?, reviewed_at = ?, reviewer_id = ?,
      duplicate_flag = ?, duplicate_of_case_id = ?, last_review_id = ?
      WHERE id = ? AND status = ? AND version = ? AND ${REVIEW_AUTH_GUARD}
      AND (? IS NULL OR EXISTS (SELECT 1 FROM cases t WHERE t.id = ? AND t.id != cases.id AND t.status IN ('approved', 'completed')))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM campaigns p WHERE p.campaign_id = cases.campaign_id AND p.version = ?
        AND p.status IN ('active', 'closed') AND cases.vote_date BETWEEN p.vote_start_date AND p.vote_end_date))`)
      .bind(status, now, input.reason, now, actor.member.member_id, now, actor.member.member_id,
        target ? 1 : 0, target?.id ?? null, mutationId, row.id, row.status, input.expectedVersion,
        ...actorBindings(actor), target?.id ?? null, target?.id ?? null, campaign?.version ?? null, campaign?.version ?? null),
    ...reviewPointStatements(db, actor, row, input, mutationId, now, campaign),
    db.prepare(`INSERT INTO admin_audit_logs (id, created_at, admin_member_id, admin_role, action, target_type,
      target_id, target_version, before_json, after_json, reason)
      SELECT ?, ?, ?, ?, ?, 'case', c.case_id, c.version, ?, json_object('status', c.status, 'version', c.version,
        'duplicate_of_case_id', ?, 'points_awarded', c.points_awarded, 'point_status', c.point_status,
        'transaction_id', c.point_transaction_id, 'campaign_id', c.campaign_id), ? FROM cases c WHERE c.id = ? AND c.last_review_id = ?`)
      .bind(mutationId, now, actor.member.member_id, actor.role, input.action, before, target?.case_id ?? null, input.reason, row.id, mutationId),
    db.prepare(`SELECT case_id, status, version, status_updated_at, status_updated_by, points_awarded, point_status,
      point_transaction_id FROM cases WHERE id = ? AND last_review_id = ?`).bind(row.id, mutationId),
  ]);
  if (result[0].meta.changes !== 1 || result.at(-2).meta.changes !== 1) throw statusConflict();
  return { ...result.at(-1).results[0],
    duplicate_of_case_id: target?.case_id ?? null };
}

export async function auditLogs(db, page) {
  const { clauses, values } = filterSql(page, "a");
  if (page.cursor) { clauses.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))"); values.push(page.cursor[1], page.cursor[1], page.cursor[2]); }
  const rows = (await db.prepare(`SELECT a.id, a.created_at, a.admin_member_id, a.admin_role, a.action, a.target_type,
    a.target_id, a.target_version, a.before_json, a.after_json, a.reason FROM admin_audit_logs a
    ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
    .bind(...values, page.limit + 1).all()).results;
  const selected = rows.slice(0, page.limit), last = selected.at(-1);
  return { logs: selected.map(({ before_json, after_json, ...row }) => ({ ...row, before: JSON.parse(before_json), after: JSON.parse(after_json) })),
    next_cursor: rows.length > page.limit ? encodeCursor([page.scope, 0, last.created_at, last.id]) : null };
}
