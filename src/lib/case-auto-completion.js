export const CASE_COMPLETION_CRON = '0 0 1 nov *';

export function isCaseCompletionCron(cron) {
  if (typeof cron !== 'string') return false;
  const expression = cron.trim().toLowerCase().replace(/\s+/g, ' ');
  return expression === CASE_COMPLETION_CRON || expression === '0 0 1 11 *';
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 200;
const APPROVAL_TIME = 'COALESCE(status_updated_at, reviewed_at)';
const selectedCases = `SELECT json_extract(value,'$.id') AS case_internal_id,
  json_extract(value,'$.version') AS approved_version, json_extract(value,'$.approved_at') AS approved_at,
  json_extract(value,'$.last_review_id') AS approval_review_id, json_extract(value,'$.audit_id') AS audit_id
  FROM json_each(?)`;
const stillApproved = `c.id = selected.case_internal_id AND c.status = 'approved'
  AND c.version = selected.approved_version
  AND COALESCE(c.status_updated_at, c.reviewed_at) = selected.approved_at
  AND c.last_review_id IS selected.approval_review_id`;

export async function completeDueCases(db, now = new Date()) {
  const completedAt = now.toISOString();
  const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString();
  const { results: due } = await db.prepare(`SELECT id, version, last_review_id, ${APPROVAL_TIME} approved_at
    FROM cases WHERE status = 'approved' AND ${APPROVAL_TIME} GLOB '????-??-??*'
      AND julianday(${APPROVAL_TIME}) <= julianday(?)
    ORDER BY julianday(${APPROVAL_TIME}), id LIMIT ?`).bind(cutoff, BATCH_LIMIT).all();
  if (!due.length) return 0;

  const selection = JSON.stringify(due.map(row => ({ ...row, audit_id: crypto.randomUUID() })));
  // Use one fenced transaction with a fixed statement count even during catch-up.
  // A case that changed after selection is omitted from the audit and update.
  const [audit] = await db.batch([
    db.prepare(`INSERT INTO case_auto_completion_audit
      (id, case_id, approved_at, completed_at, approved_version, completed_version, approval_review_id)
      SELECT selected.audit_id, c.case_id, selected.approved_at, ?, c.version, c.version + 1, selected.approval_review_id
      FROM (${selectedCases}) selected JOIN cases c ON ${stillApproved}`)
      .bind(completedAt, selection),
    db.prepare(`UPDATE cases AS c SET status = 'completed', version = c.version + 1, updated_at = ?,
      status_updated_at = ?, status_updated_by = NULL, last_review_id = selected.audit_id
      FROM (${selectedCases}) selected JOIN case_auto_completion_audit a ON a.id = selected.audit_id
      WHERE ${stillApproved}`)
      .bind(completedAt, completedAt, selection),
    db.prepare(`INSERT INTO auth_atomic_guards(id,valid) SELECT ?,0 WHERE EXISTS(
      SELECT 1 FROM (${selectedCases}) selected
      JOIN case_auto_completion_audit a ON a.id = selected.audit_id
      LEFT JOIN cases c ON c.id = selected.case_internal_id
      WHERE c.status IS NOT 'completed' OR c.last_review_id IS NOT a.id OR c.version IS NOT a.completed_version
    )`).bind(crypto.randomUUID(), selection),
  ]);
  return audit.meta.changes;
}
