import { adminHandler } from "./admin-response.js";
import { adminIdentity, adminCsrf, ELEVATED_ROLES, AdminError } from "../lib/admin-identity.js";
import { authenticateRelay } from "../lib/drive-backup-relay.js";
import { readReviewJson } from "./admin-validation.js";
import { jsonSuccess, jsonError } from "./response.js";
import {
  inventoryPage,
  storageSummary,
  nowSeconds,
  evaluateCapacity,
} from "../lib/storage-capacity.js";
import { cleanupArchive } from "../lib/storage-archive.js";
import { processStorageAlerts } from "../lib/storage-alerts.js";
import { scanInventoryPage,finalizeInventory } from "../lib/storage-inventory.js";
const validObject = (v) => v && typeof v === "object" && !Array.isArray(v);
export async function quotaSnapshot(env, v) {
  if (
    !validObject(v) ||
    Object.keys(v).some(
      (k) => !["id", "observed_at", "state", "total_bytes", "used_bytes"].includes(k),
    ) ||
    !/^[a-f0-9-]{36}$/.test(v.id ?? "") ||
    !Number.isSafeInteger(v.observed_at) ||
    Math.abs(nowSeconds() - v.observed_at) > 120 ||
    !["known", "unlimited", "unknown", "error"].includes(v.state)
  )
    throw new AdminError(400, "INVALID_STORAGE_REQUEST", "容量快照無效。");
  const number = (n) => n === null || (Number.isSafeInteger(n) && n >= 0);
  if (
    !number(v.total_bytes) ||
    !number(v.used_bytes) ||
    (v.state === "known" &&
      (!(v.total_bytes > 0) || v.used_bytes === null || v.used_bytes > v.total_bytes)) ||
    (v.state !== "known" && v.total_bytes !== null)
  )
    throw new AdminError(400, "INVALID_STORAGE_REQUEST", "容量快照無效。");
  await env.DB.prepare(
    "INSERT INTO drive_quota_snapshots VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(v.id, v.observed_at, nowSeconds(), v.total_bytes, v.used_bytes, v.state)
    .run();
  return { accepted: true };
}
const historyList = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env, ELEVATED_ROLES);
  const raw=url.searchParams.get('page') ?? '1',page=Number(raw);
  if([...url.searchParams.keys()].some(k=>k!=='page') || url.searchParams.getAll('page').length>1 ||
     !/^[1-9]\\d*$/.test(raw) || !Number.isSafeInteger(page) || !Number.isSafeInteger(page*10))
    throw new AdminError(400,'INVALID_PAGINATION','容量歷史分頁無效。');
  // Read-only metadata listing. No R2, Drive, cleanup, or inventory actions.
  const [count,rows]=await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS total FROM storage_history'),
    env.DB.prepare('SELECT created_at,bytes,object_count,staging_bytes,other_bytes FROM storage_history ORDER BY created_at DESC,id DESC LIMIT 10 OFFSET ?').bind((page-1)*10),
  ]);
  const total=count.results[0].total;
  return jsonSuccess({history:rows.results,page,page_size:10,total,total_pages:Math.max(1,Math.ceil(total/10))});
});
const admin = adminHandler(async (env, url, request) => {
  const actor = await adminIdentity(request, env, ELEVATED_ROLES);
  if (url.search) throw new AdminError(400, "INVALID_STORAGE_REQUEST", "不支援查詢參數。");
  if (request.method === "GET") return jsonSuccess(await storageSummary(env.DB, {live:env.STORAGE_CLEANUP_LIVE_ENABLED==="true"}));
  await adminCsrf(request, env, actor);
  const v = await readReviewJson(request);
  if (!validObject(v) || Object.keys(v).length)
    throw new AdminError(400, "INVALID_STORAGE_REQUEST", "參數無效。");
  return jsonSuccess(
    url.pathname.endsWith("/inventory") ? await inventoryPage(env) : await cleanupArchive(env, {previewOnly:true}),
  );
});
const internal = async (env, url, request) => {
  try {
    await authenticateRelay(request, env);
    if (url.search) throw Error();
    const v = await readReviewJson(request);
    if (url.pathname.endsWith("/quota")) return jsonSuccess(await quotaSnapshot(env, v));
    if(url.pathname.endsWith('/inventory/finalize')){
      if(!validObject(v)||Object.keys(v).length!==2||!Object.hasOwn(v,'inventory_id')||!Object.hasOwn(v,'inventory_version')||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.inventory_id??'')||
        !Number.isSafeInteger(v.inventory_version)||v.inventory_version<1)throw Error();
      return jsonSuccess({inventory:await finalizeInventory(env,v.inventory_id,v.inventory_version),
        cleanup:null,alerts:{state:'skipped_inventory_only',sent:0},inventory_only:true});
    }
    const inventoryOnly = url.pathname.endsWith("/tick") && validObject(v) &&
      Object.keys(v).length === 1 && v.inventory_only === true;
    if (!validObject(v) || (Object.keys(v).length && !inventoryOnly)) throw Error();
    if (url.pathname.endsWith("/archive")) return jsonSuccess({cleanup:await cleanupArchive(env)});
    if (!inventoryOnly) await evaluateCapacity(env.DB);
    const inventory = inventoryOnly?await scanInventoryPage(env):await inventoryPage(env);
    let cleanup = null;
    // Archival A and B run in separate authenticated requests after inventory.
    // Scheduled inventory must never enter mail delivery, regardless of its flag.
    const alerts = inventoryOnly
      ? { state: "skipped_inventory_only", sent: 0 }
      : await processStorageAlerts(env);
    return jsonSuccess({ inventory, cleanup, alerts,
      ...(inventoryOnly ? { inventory_only: true } : {}) });
  } catch (e) {
    return jsonError(
      e.status ?? 503,
      e.code ?? "STORAGE_MAINTENANCE_UNAVAILABLE",
      "Storage maintenance unavailable",
    );
  }
};
export function storageRoute(path) {
  if (path === "/api/admin/storage") return { method: "GET", handler: admin };
  if (path === "/api/admin/storage/history") return { method: "GET", handler: historyList };
  if (["/api/admin/storage/inventory", "/api/admin/storage/dry-run"].includes(path))
    return { method: "POST", handler: admin };
  if (
    [
      "/api/internal/drive-backup/storage/quota",
      "/api/internal/drive-backup/storage/tick",
      "/api/internal/drive-backup/storage/inventory/finalize",
      "/api/internal/drive-backup/storage/archive",
    ].includes(path)
  )
    return { method: "POST", handler: internal };
}
