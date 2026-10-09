// Fixed SQL, evaluated entirely inside the publish transaction. No client SQL.
// A member reaches their final pair at the start of its final uninterrupted
// suffix. Departing and later returning resets this time (including reversals).
export const LEDGER_CTE = `WITH scoped AS (
  SELECT t.*, CASE WHEN t.category IN ('proof_approved','proof_reapproved') THEN 1
    WHEN t.category = 'proof_revoked' THEN -1 ELSE 0 END AS proof_delta
  FROM point_transactions t JOIN leaderboards b ON b.leaderboard_id = ?
  WHERE (b.campaign_id IS NULL OR t.campaign_id = b.campaign_id)
    AND (b.vote_type IS NULL OR t.vote_type = b.vote_type)
    AND (b.type != 'custom' OR t.vote_date BETWEEN b.start_date AND b.end_date)
), history AS (
  SELECT *, ROW_NUMBER() OVER w AS step, SUM(points) OVER w AS running_points,
    SUM(proof_delta) OVER w AS running_proofs FROM scoped
  WINDOW w AS (PARTITION BY member_id ORDER BY created_at, CASE WHEN category = 'proof_revoked' THEN 1 ELSE 0 END, transaction_id ROWS UNBOUNDED PRECEDING)
), totals AS (
  SELECT member_id, SUM(points) AS points, SUM(proof_delta) AS proof_count FROM scoped GROUP BY member_id
), departure AS (
  SELECT h.member_id, COALESCE(MAX(CASE WHEN h.running_points != t.points OR h.running_proofs != t.proof_count THEN h.step END),0) AS last_departure
  FROM history h JOIN totals t USING(member_id) GROUP BY h.member_id
), candidates AS (
  SELECT t.member_id, m.nickname, t.points, t.proof_count, MIN(h.created_at) AS reached_at
  FROM totals t JOIN members m USING(member_id) JOIN departure d USING(member_id) JOIN history h USING(member_id)
  WHERE m.status = 'active' AND t.points > 0 AND h.step > d.last_departure
  GROUP BY t.member_id, m.nickname, t.points, t.proof_count
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY points DESC, proof_count DESC, reached_at ASC, member_id ASC) AS rank FROM candidates
)`;
// Validate ALL scoped history, even zero/negative or suspended participants.
// Negative prefix proof counts indicate malformed chronological lifecycle data.
export const INTEGRITY_SQL = `(SELECT COUNT(*) FROM history WHERE running_proofs < 0
  OR typeof(running_points) != 'integer' OR abs(running_points) > 9007199254740991
  OR typeof(running_proofs) != 'integer' OR running_proofs > 9007199254740991
  OR created_at NOT GLOB '????-??-??T??:??:??.???Z')`;
