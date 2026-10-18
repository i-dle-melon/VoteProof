import { authAtomic } from "./auth-store.js";
import { AdminError } from "./admin-identity.js";
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
export async function storageAudit(db, action, target, detail = {}) {
  await db
    .prepare("INSERT INTO storage_audit VALUES(?,?,?,?,?)")
    .bind(crypto.randomUUID(), nowSeconds(), action, target, JSON.stringify(detail))
    .run();
}
export async function reserveStorage(env, key, size) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new StorageCapacityError();
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO storage_reservations(id,object_key,bytes,state,created_at) VALUES(?,?,?,'reserved',?)",
    )
      .bind(id, key, size, nowSeconds())
      .run();
  } catch {
    const error = new StorageCapacityError();
    error.noWrite = true;
    throw error;
  }
  return id;
}
export async function capacityPut(env, key, body, options, size) {
  const id = await reserveStorage(env, key, size);
  // Never expire ambiguous reservations: a timed-out native PUT may still finish.
  const object = await env.PROOFS_BUCKET.put(key, body, options);
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
  try{await evaluateCapacity(env.DB);}catch{throw new StorageCapacityError();}
  return object;
}
export async function evaluateCapacity(db) {
  const row = await capacityRow(db),
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
export async function storageSummary(db,{live=false}={}) {
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
    blocked: !!row.blocked || row.trusted_until <= nowSeconds() || !!row.anomaly || row.used_bytes+row.reserved_bytes>=STORAGE.stop,
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
