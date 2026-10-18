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
import { cleanupDryRun } from "../lib/cold-storage.js";
import { processStorageAlerts } from "../lib/storage-alerts.js";
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
const admin = adminHandler(async (env, url, request) => {
  const actor = await adminIdentity(request, env, ELEVATED_ROLES);
  if (url.search) throw new AdminError(400, "INVALID_STORAGE_REQUEST", "不支援查詢參數。");
  if (request.method === "GET") return jsonSuccess(await storageSummary(env.DB));
  await adminCsrf(request, env, actor);
  const v = await readReviewJson(request);
  if (!validObject(v) || Object.keys(v).length)
    throw new AdminError(400, "INVALID_STORAGE_REQUEST", "參數無效。");
  return jsonSuccess(
    url.pathname.endsWith("/inventory") ? await inventoryPage(env) : await cleanupDryRun(env),
  );
});
const internal = async (env, url, request) => {
  try {
    await authenticateRelay(request, env);
    if (url.search) throw Error();
    const v = await readReviewJson(request);
    if (url.pathname.endsWith("/quota")) return jsonSuccess(await quotaSnapshot(env, v));
    if (!validObject(v) || Object.keys(v).length) throw Error();
    await evaluateCapacity(env.DB);
    const inventory = await inventoryPage(env);
    let cleanup = null;
    if (inventory.complete) cleanup = await cleanupDryRun(env);
    const alerts = await processStorageAlerts(env);
    return jsonSuccess({ inventory, cleanup, alerts });
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
  if (["/api/admin/storage/inventory", "/api/admin/storage/dry-run"].includes(path))
    return { method: "POST", handler: admin };
  if (
    [
      "/api/internal/drive-backup/storage/quota",
      "/api/internal/drive-backup/storage/tick",
    ].includes(path)
  )
    return { method: "POST", handler: internal };
}
