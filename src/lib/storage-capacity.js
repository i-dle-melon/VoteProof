import { authAtomic } from "./auth-store.js";
import { AdminError } from "./admin-identity.js";
import {storageAdmissionStatements} from './storage-admission.js';
export const R2_STORAGE_BUDGET_BYTES=10000000000;
export const R2_CLEANUP_START_BYTES=9000000000;
export const R2_UPLOAD_STOP_BYTES=9500000000;
export const R2_CLEANUP_TARGET_BYTES=8500000000;
export const R2_RESUME_BELOW_BYTES=9000000000;
export const STORAGE=Object.freeze({budget:R2_STORAGE_BUDGET_BYTES,cleanupStart:R2_CLEANUP_START_BYTES,stop:R2_UPLOAD_STOP_BYTES,target:R2_CLEANUP_TARGET_BYTES,resume:R2_RESUME_BELOW_BYTES,freshSeconds:600});
export const CAPACITY_MESSAGE = "目前儲存空間不足，暫時停止圖片上傳，請稍後再試。";
export class StorageCapacityError extends AdminError {
  constructor() {
    super(503, "R2_STORAGE_CAPACITY_EXCEEDED", CAPACITY_MESSAGE);
  }
}
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const capacityRow = (db) => db.prepare("SELECT * FROM storage_capacity WHERE id=1").first();
export const capacityAccountingOnly = env => env.STORAGE_CAPACITY_ENFORCEMENT === 'disabled';
export const uploadCapacityBlocked = (row,accountingOnly=false) => accountingOnly&&row.upload_policy==='observe'
  ?!!row.anomaly||!Number.isSafeInteger(row.used_bytes+row.reserved_bytes)||row.used_bytes<0||row.reserved_bytes<0
  :!!row.blocked||row.trusted_until<=nowSeconds()||!!row.anomaly||row.used_bytes+row.reserved_bytes>=STORAGE.stop;
export async function storageAudit(db, action, target, detail = {}) {
  await db
    .prepare("INSERT INTO storage_audit VALUES(?,?,?,?,?)")
    .bind(crypto.randomUUID(), nowSeconds(), action, target, JSON.stringify(detail))
    .run();
}
export async function reserveStorage(env, key, size, claim=null,diagnostic) {
  if(diagnostic)diagnostic.stage='capacity_admission';
  if (!Number.isSafeInteger(size) || size <= 0) throw new StorageCapacityError();
  const id = crypto.randomUUID();
  const input={id,key,size,createdAt:nowSeconds(),claim,accountingOnly:capacityAccountingOnly(env)};
  if(env.PRELAUNCH_RESET_FENCE_ENABLED==='true'&&!env.PRELAUNCH_RESET_CONTEXT?.admitStorage)throw new StorageCapacityError();
  // Never label a thrown/unknown D1 ACK as noWrite. A commit may have acquired
  // both records; its durable Reservation/Pin must survive for reconciliation.
  const results=env.PRELAUNCH_RESET_CONTEXT?.admitStorage
    ?await env.PRELAUNCH_RESET_CONTEXT.admitStorage(input)
    :await env.DB.batch(storageAdmissionStatements(env.DB,input));
  if(!Array.isArray(results)||results.length!==(claim?3:1)||results.some(r=>r?.success!==true))throw new StorageCapacityError();
  const pin=claim?results[0]:null,reservation=results[claim?1:0];
  // Native D1 changes can include Trigger effects; the returned exact IDs are
  // the admission receipt. Do not compare total Trigger changes to one.
  if(reservation.results?.length===1&&reservation.results[0].id===id&&
    (!claim||pin.results?.length===1&&pin.results[0].session_id===claim.sessionId))return id;
  if(reservation?.meta?.changes!==0||reservation.results?.length!==0||claim&&(pin?.meta?.changes!==0||pin.results?.length!==0))throw new StorageCapacityError();
  if(claim){
    const allowed=results[2]?.results;
    if(allowed?.length!==1||![0,1].includes(allowed[0].capacity_allowed))throw new StorageCapacityError();
    if(allowed[0].capacity_allowed===1)return null;
  }
  // The exact zero-row admission proves this request did not dispatch an R2 PUT.
  // Diagnose a concurrent inventory only AFTER that receipt. Never classify
  // thrown D1 acknowledgements or ambiguous native writes as safe-to-retry.
  let current;
  try { current=await env.DB.prepare(`SELECT c.*,
      EXISTS(SELECT 1 FROM storage_reservations WHERE object_key=? AND state='reserved') AS object_reserved,
      EXISTS(SELECT 1 FROM proof_upload_intents WHERE object_key=? AND write_token IS NOT NULL) AS object_pinned
      FROM storage_capacity c WHERE c.id=1`).bind(key,key).first(); } catch { /* Keep the conservative code. */ }
  const error=new StorageCapacityError();
  // An admission failure caused by real capacity, anomaly, or blocked state
  // must never be mislabeled transient even if a scan is also in progress.
  const safelyBelowLimit=current && current.blocked===0 && current.anomaly===null &&
    Number.isSafeInteger(current.used_bytes)&&Number.isSafeInteger(current.reserved_bytes)&&
    current.used_bytes>=0&&current.reserved_bytes>=0&&
    current.used_bytes+current.reserved_bytes+size<STORAGE.stop&&
    current.object_reserved===0&&current.object_pinned===0;
  if(safelyBelowLimit && current.inventory_id && ['scan','ready'].includes(current.inventory_phase)){
    error.code='R2_STORAGE_INVENTORY_BUSY';
    error.message='Background capacity inventory is temporarily blocking upload admission';
  }else if(safelyBelowLimit && current.trusted_until<=nowSeconds()){
    error.code='R2_STORAGE_SNAPSHOT_STALE';
    error.message='Capacity snapshot is not fresh';
  }
  error.noWrite=true;
  throw error;
}
export async function capacityPut(env, key, body, options, size,diagnostic) {
  const id = await reserveStorage(env, key, size,null,diagnostic);
  return putReservedStorage(env,key,body,options,size,id,diagnostic);
}
export async function putReservedStorage(env,key,body,options,size,id,diagnostic) {
  // Never expire ambiguous reservations: a timed-out native PUT may still finish.
  if(diagnostic){diagnostic.stage='r2_put';diagnostic.putState='unknown';}
  const object = await env.PROOFS_BUCKET.put(key, body, options);
  if(diagnostic){diagnostic.stage='reservation_receipt';diagnostic.putState='acknowledged';}
  if (!object) {
    await env.DB.prepare(
      "UPDATE storage_reservations SET state='cancelled' WHERE id=? AND state='reserved' RETURNING id",
    )
      .bind(id)
      .run();
    return object;
  }
  if (object.size !== size) {
    await env.DB.prepare(
      "UPDATE storage_capacity SET blocked=1,anomaly='WRITE_SIZE_MISMATCH' WHERE id=1",
    ).run();
    throw new StorageCapacityError();
  }
  try {
    await env.DB.prepare(
      "UPDATE storage_reservations SET state='committed',etag=?,object_version=? WHERE id=? AND state='reserved' RETURNING id",
    )
      .bind(object.etag, object.version ?? null, id)
      .first().then(r=>{if(!r)throw new StorageCapacityError();});
  } catch {
    throw new StorageCapacityError();
  }
  if(diagnostic)diagnostic.stage='capacity_evaluation';
  // Observation mode retains exact accounting/receipts without adding site
  // quota alerts or threshold writes to the upload path.
  if(!capacityAccountingOnly(env))try{await evaluateCapacity(env.DB);}catch{throw new StorageCapacityError();}
  return object;
}
export async function evaluateCapacity(db, current = null) {
  const row = current ?? await capacityRow(db),
    used = row.used_bytes + row.reserved_bytes,
    now = nowSeconds();
  const kinds = [];
  if (used >= STORAGE.cleanupStart) kinds.push("90");
  if (used >= STORAGE.stop) kinds.push("95");
  if (used >= STORAGE.stop)
    await db.prepare("UPDATE storage_capacity SET blocked=1 WHERE id=1").run();
  if (used >= STORAGE.cleanupStart)
    await db.prepare("UPDATE storage_capacity SET cleanup_requested=1 WHERE id=1").run();
  for (const kind of kinds)
    await db
      .prepare(
        "INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,?,?,?) ON CONFLICT(episode,kind) DO NOTHING",
      )
      .bind(crypto.randomUUID(), row.episode, kind, now)
      .run();
}
export async function inventoryPage(env) {
  const db = env.DB;
  let row = await capacityRow(db);
  if(row.inventory_dirty)throw new AdminError(409,'STORAGE_INVENTORY_INVALIDATED','盤點期間有寫入，不能發布此快照。');
  if (row.inventory_phase) throw new AdminError(409,"STORAGE_FINALIZATION_REQUIRED","分段盤點須使用原有流程完成。");
  if (env.R2_EXCLUSIVE_WRITER_CONFIRMED !== "true")
    throw new AdminError(
      409,
      "STORAGE_WRITER_UNVERIFIED",
      "須先確認 Bucket 唯一寫入來源與無未完成 multipart。",
    );
  if (!row.inventory_id) {
    const claimed = await db
      .prepare(
        `UPDATE storage_capacity SET inventory_id=?,inventory_cursor=NULL,inventory_bytes=0,inventory_count=0,inventory_staging=0,inventory_other=0,
 inventory_version=inventory_version+1,trusted_until=0 WHERE id=1 AND inventory_id IS NULL AND reserved_bytes=0 RETURNING *`,
      )
      .bind(crypto.randomUUID())
      .first();
    if (!claimed)
      throw new AdminError(409, "STORAGE_WRITER_BUSY", "仍有上傳或不確定寫入，不能盤點。");
    row = claimed;
  }
  const page = await env.PROOFS_BUCKET.list({
    limit: 200,
    ...(row.inventory_cursor ? { cursor: row.inventory_cursor } : {}),
  });
  let bytes = 0,
    staging = 0,
    other = 0;
  for (const o of page.objects) {
    if (!Number.isSafeInteger(o.size) || o.size < 0) throw new StorageCapacityError();
    bytes += o.size;
    if (o.key.startsWith("proofs/staging/")) staging += o.size;
    if (!o.key.startsWith("proofs/")) other += o.size;
  }
  if (page.truncated && !page.cursor) throw new StorageCapacityError();
  const total = row.inventory_bytes + bytes,
    at = nowSeconds(),
    anomaly =
      row.anomaly ?? (row.observed_at && total > row.used_bytes ? "UNACCOUNTED_GROWTH" : null);
  const finish = !page.truncated,
    recovered =
      finish && row.observed_at !== null && row.blocked && total < STORAGE.resume && !anomaly;
  const update = db
    .prepare(
      `UPDATE storage_capacity SET inventory_bytes=inventory_bytes+?,inventory_count=inventory_count+?,inventory_staging=inventory_staging+?,inventory_other=inventory_other+?,inventory_cursor=?,inventory_version=inventory_version+1 WHERE id=1`,
    )
    .bind(bytes, page.objects.length, staging, other, page.cursor ?? null);
  const writes = [update];
  if (finish)
    writes.push(
      db
        .prepare(
          "INSERT INTO storage_history SELECT inventory_id,?,inventory_bytes,0,inventory_count,inventory_staging,inventory_other,? FROM storage_capacity WHERE id=1",
        )
        .bind(at, anomaly),
      db
        .prepare(
          `UPDATE storage_capacity SET used_bytes=inventory_bytes,observed_at=?,trusted_until=?,inventory_id=NULL,inventory_cursor=NULL,anomaly=?,
 blocked=CASE WHEN ? IS NOT NULL OR inventory_bytes>=9500000000 THEN 1 WHEN inventory_bytes<9000000000 THEN 0 ELSE blocked END,
 cleanup_requested=CASE WHEN inventory_bytes<=8500000000 THEN 0 WHEN inventory_bytes>=9000000000 THEN 1 ELSE cleanup_requested END WHERE id=1`,
        )
        .bind(at, at + STORAGE.freshSeconds, anomaly, anomaly),
      ...(recovered
        ? [
            db
              .prepare(
                "INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,?,'recovered',?) ON CONFLICT(episode,kind) DO NOTHING",
              )
              .bind(crypto.randomUUID(), row.episode, at),
            db.prepare("UPDATE storage_capacity SET episode=episode+1 WHERE id=1"),
          ]
        : []),
    );
  try {
    await authAtomic(
      db,
      [
        {
          sql: "EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND inventory_id=? AND inventory_version=?)",
          args: [row.inventory_id, row.inventory_version],
        },
      ],
      writes,
    );
  } catch {
    throw new AdminError(409, "STORAGE_SCAN_CONFLICT", "另一個盤點已更新，請重試。");
  }
  if (!finish) return { complete: false, scanned: row.inventory_count + page.objects.length };
  await evaluateCapacity(db);
  await storageAudit(db, "inventory", row.inventory_id, {
    bytes: total,
    objects: row.inventory_count + page.objects.length,
    anomaly,
  });
  return { complete: true, bytes: total, anomaly };
}
export async function storageSummary(db,{live=false,accountingOnly=false}={}) {
  const row = await capacityRow(db);
  const history = (
    await db.prepare("SELECT * FROM storage_history ORDER BY created_at DESC LIMIT 20").all()
  ).results;
  const quota = await db
    .prepare("SELECT * FROM drive_quota_snapshots ORDER BY received_at DESC,rowid DESC LIMIT 1")
    .first();
  return {
    budget: STORAGE,
    used_bytes: row.observed_at===null?null:row.used_bytes,
    reserved_bytes: row.reserved_bytes,
    blocked: uploadCapacityBlocked(row,accountingOnly),
    upload_policy: accountingOnly&&row.upload_policy==='observe'?'observe':'enforced',
    snapshot_stale: row.trusted_until<=nowSeconds(),
    inventory_invalidated: !!row.inventory_dirty,
    observed_at: row.observed_at,
    trusted_until: row.trusted_until,
    anomaly: row.anomaly,
    scanning: !!row.inventory_id,
    cleanup_requested: !!row.cleanup_requested,
    cleanup_mode: live?"live":"dry-run",
    retention_days: 7,
    retention_approved: true,
    history,
    drive_quota: quota
      ? {
          ...quota,
          stale: nowSeconds() - quota.received_at > 3600,
          remaining_percent:
            quota.state === "known" && quota.total_bytes > 0
              ? Math.max(0, ((quota.total_bytes - quota.used_bytes) / quota.total_bytes) * 100)
              : null,
        }
      : { state: "unknown", remaining_percent: null },
  };
}
