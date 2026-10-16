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
