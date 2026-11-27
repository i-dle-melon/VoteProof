import {AdminError} from './admin-identity.js';

const pageSize = 200;
// The hourly scheduler can run slightly before the last completion time.
const intervalSeconds = 45 * 60;
const enabled = env => env.STORAGE_CAPACITY_ENFORCEMENT === 'disabled' &&
  env.PRELAUNCH_RESET_FENCE_ENABLED === 'true' && env.R2_EXCLUSIVE_WRITER_CONFIRMED === 'true';
const fail = (code = 'R2_SAFETY_SCAN_CHANGED') => new AdminError(409, code, 'R2 安全盤點暫停，稍後重新檢查。');
const count = value => Number.isSafeInteger(value) && value >= 0;
const pending = "pending_r2>0 OR (state='unknown' AND r2_writes>0)";
const allReviewed = `NOT EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE (${pending})
 AND NOT (o.epoch=1 AND o.isolated_r2_key IS NULL AND o.pending_r2=1 AND o.r2_writes=1
 AND EXISTS(SELECT 1 FROM json_each(?) j WHERE j.value=o.id)))`;
const openControl = "EXISTS(SELECT 1 FROM prelaunch_reset_control WHERE id=1 AND mode='open' AND epoch=? AND version=?)";
const observe = "EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND upload_policy='observe' AND anomaly IS NULL)";

function observation(row) {
  const latest = JSON.parse(row.latest ?? 'null');
  return {
    state: row.scan_id ? (row.invalidated ? 'waiting' : 'scanning') : (latest ? 'complete' : 'waiting'),
    latest,
  };
}

export async function safetyInventorySummary(env) {
  if (!enabled(env)) return null;
  try {
    const row = await env.DB.prepare('SELECT scan_id,invalidated,latest FROM r2_safety_inventory WHERE id=1').first();
    return row ? observation(row) : null;
  } catch (error) {
    // The extension is optional until installed alongside the reset fence.
    if (/no such table:\s*r2_safety_inventory\b/i.test(String(error))) return null;
    throw error;
  }
}

export async function safetyInventoryPage(env, reviewedLegacyOperations) {
  const epoch = env.PRELAUNCH_RESET_CONTEXT?.epoch;
  if (!enabled(env) || !Number.isSafeInteger(epoch) || epoch < 1)
    throw fail('R2_SAFETY_SCAN_UNAVAILABLE');
  const db = env.DB, reviewed = reviewedLegacyOperations ?? '[]';
  await env.PRELAUNCH_RESET_CONTEXT.assertOpen();
  let row = await db.prepare(`SELECT s.*,c.version AS control_version
    FROM r2_safety_inventory s JOIN prelaunch_reset_control c ON c.id=1
    WHERE s.id=1 AND c.epoch=? AND c.mode='open'`).bind(epoch).first();
  if (!row || !count(row.control_version)) throw fail('R2_SAFETY_SCAN_UNAVAILABLE');
  const controlVersion = row.control_version;
  const now = Math.floor(Date.now() / 1000);
  const latest = observation(row).latest;
  if (!row.scan_id && latest?.epoch === epoch && latest.control_version === controlVersion &&
      latest.observed_at > now - intervalSeconds)
    return {state:'current', latest};
  if (!row.scan_id || row.invalidated || row.scan_epoch !== epoch || row.scan_control_version !== controlVersion) {
    row = await db.prepare(`UPDATE r2_safety_inventory SET scan_id=?,scan_epoch=?,scan_control_version=?,cursor=NULL,
      scan_bytes=0,scan_objects=0,invalidated=0
      WHERE id=1 AND scan_id IS ?
      AND (scan_id IS NULL OR invalidated=1 OR scan_epoch IS NOT ? OR scan_control_version IS NOT ?)
      AND ${openControl} AND ${observe} AND ${allReviewed} RETURNING *`)
      .bind(crypto.randomUUID(),epoch,controlVersion,row.scan_id,epoch,controlVersion,epoch,controlVersion,reviewed).first();
    if (!row) throw fail('R2_SAFETY_SCAN_PRECONDITION');
  }

  const page = await env.PROOFS_BUCKET.list({limit:pageSize,...(row.cursor ? {cursor:row.cursor} : {})});
  if (!Array.isArray(page?.objects) || page.objects.length > pageSize || typeof page.truncated !== 'boolean' ||
      (page.truncated && (typeof page.cursor !== 'string' || !page.cursor || page.cursor === row.cursor)))
    throw fail('R2_SAFETY_SCAN_RESPONSE');
  let bytes = row.scan_bytes, objects = row.scan_objects + page.objects.length;
  for (const object of page.objects) {
    if (!count(object?.size)) throw fail('R2_SAFETY_SCAN_RESPONSE');
    bytes += object.size;
  }
  if (!count(bytes) || !count(objects)) throw fail('R2_SAFETY_SCAN_RESPONSE');
  const guard = `id=1 AND scan_id=? AND scan_epoch=? AND scan_control_version=? AND cursor IS ? AND invalidated=0
    AND ${openControl} AND ${observe} AND ${allReviewed}`;
  const args = [row.scan_id,epoch,controlVersion,row.cursor,epoch,controlVersion,reviewed];
  if (page.truncated) {
    const saved = await db.prepare(`UPDATE r2_safety_inventory SET cursor=?,scan_bytes=?,scan_objects=?
      WHERE ${guard} RETURNING id`).bind(page.cursor,bytes,objects,...args).first();
    if (!saved) throw fail();
    return {state:'scanning', objects};
  }

  const safety = await db.prepare(`SELECT reserved_bytes,
    (SELECT COUNT(*) FROM prelaunch_reset_operations WHERE ${pending}) AS pending_operations
    FROM storage_capacity WHERE id=1`).first();
  if (!count(safety?.reserved_bytes) || !count(safety.pending_operations) || !count(bytes + safety.reserved_bytes))
    throw fail('R2_SAFETY_SCAN_RESPONSE');
  const result = {id:row.scan_id,epoch,control_version:controlVersion,observed_at:Math.floor(Date.now()/1000),bytes,objects,
    reserved_bytes:safety.reserved_bytes,accounted_upper_bytes:bytes+safety.reserved_bytes,
    pending_operations:safety.pending_operations};
  const detail = JSON.stringify(result);
  let saved;
  try {
    // The append-only audit trigger and snapshot commit in the same update.
    saved = await db.prepare(`UPDATE r2_safety_inventory SET scan_id=NULL,scan_epoch=NULL,
      scan_control_version=NULL,cursor=NULL,scan_bytes=0,scan_objects=0,latest=? WHERE ${guard}
      AND EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND reserved_bytes=?)
      AND (SELECT COUNT(*) FROM prelaunch_reset_operations WHERE ${pending})=?
      RETURNING latest`).bind(detail,...args,result.reserved_bytes,result.pending_operations).first('latest');
  } catch (error) {
    saved = await db.prepare('SELECT latest FROM r2_safety_inventory WHERE id=1').first('latest');
    if (saved !== detail) throw error;
  }
  if (saved !== detail) throw fail();
  return {state:'complete',latest:result};
}
