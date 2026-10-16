import { AdminError } from "./admin-identity.js";

export const soloTargetUnavailable = () =>
  new AdminError(400, "SOLO_TARGET_UNAVAILABLE", "Solo 對象不存在或已停用，請重新選擇。");
export async function requireActiveSoloTarget(db, input) {
  if (input.category !== "Solo") return;
  if (
    !(await db
      .prepare("SELECT target_id FROM solo_targets WHERE target_id=? AND active=1")
      .bind(input.solo_target)
      .first())
  )
    throw soloTargetUnavailable();
}
export async function listSoloTargets(db) {
  return (
    await db
      .prepare(
        "SELECT target_id,display_name,active,sort_order FROM solo_targets ORDER BY sort_order,target_id",
      )
      .all()
  ).results.map((row) => ({ ...row, active: Boolean(row.active) }));
}
export async function soloArtistRankings(db) {
  // Registry is the mother set: artists with no Campaign/proof/points survive
  // the LEFT JOIN. Reversal metadata retains the original stable target ID.
  const rows = (
    await db
      .prepare(
        `WITH totals AS (
    SELECT json_extract(metadata_json,'$.solo_target') target_id,SUM(points) points,
      SUM(CASE WHEN category IN ('proof_approved','proof_reapproved') THEN 1 WHEN category='proof_revoked' THEN -1 ELSE 0 END) proof_count,
      MAX(created_at) generated_at FROM point_transactions WHERE vote_type='Solo' GROUP BY target_id
  ) SELECT r.target_id,r.display_name,r.active,r.sort_order,COALESCE(t.points,0) points,
    COALESCE(t.proof_count,0) proof_count,t.generated_at,
    DENSE_RANK() OVER(ORDER BY COALESCE(t.points,0) DESC) rank
    FROM solo_targets r LEFT JOIN totals t ON t.target_id=r.target_id
    ORDER BY points DESC,r.sort_order,r.target_id`,
      )
      .all()
  ).results;
  if (rows.some((r) => !Number.isSafeInteger(r.points) || !Number.isSafeInteger(r.proof_count)))
    throw new AdminError(503, "LEADERBOARD_SERVICE_UNAVAILABLE", "排行榜統計暫時無法取得。");
  return rows.map((row) => ({ ...row, active: Boolean(row.active) }));
}
