import { jsonSuccess, jsonError } from "./response.js";
import { AuthError } from "./auth-validation.js";
import { authDatabase, csrfToken } from "../lib/auth-session.js";
import { AdminError, adminIdentity, adminCsrf, ELEVATED_ROLES } from "../lib/admin-identity.js";
import { CASE_ID_PATTERN } from "../lib/case-keys.js";
import { caseNotFound, reviewInput } from "../lib/case-review.js";
import { adminPage, readReviewJson, UUID_PATTERN } from "./admin-validation.js";
import { adminCases, adminCase, adminFiles, applyReview, auditLogs } from "../lib/admin-store.js";
import { allowedMime, UPLOAD_LIMITS } from "./upload-validation.js";

const adminHandler = action => async (env, url, request) => {
  try { return await action(env, url, request); }
  catch (e) {
    if (e instanceof AdminError || e instanceof AuthError) return jsonError(e.status, e.code, e.message);
    // No exception, binding, key, credential, URL or request-body logging.
    return jsonError(503, "ADMIN_SERVICE_UNAVAILABLE", "Administrative service is unavailable");
  }
};
const pathCaseId = url => {
  const id = url.pathname.split("/")[4];
  if (!CASE_ID_PATTERN.test(id ?? "")) throw caseNotFound();
  return id;
};
const requireCase = async (db, url) => {
  const row = await adminCase(db, pathCaseId(url));
  if (!row) throw caseNotFound();
  return row;
};

export const currentAdmin = adminHandler(async (env, _url, request) => {
  const actor = await adminIdentity(request, env);
  return jsonSuccess({ member_id: actor.member.member_id, role: actor.role, csrf_token: await csrfToken(actor.member, env) });
});
export const listAdminCases = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env);
  return jsonSuccess(await adminCases(authDatabase(env), adminPage(url)));
});
export const getAdminCase = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env);
  const db = authDatabase(env), { id, ...row } = await requireCase(db, url);
  return jsonSuccess({ ...row, files: await adminFiles(db, id) });
});
export const reviewAdminCase = adminHandler(async (env, url, request) => {
  const actor = await adminIdentity(request, env);
  await adminCsrf(request, env, actor);
  const input = reviewInput(await readReviewJson(request), actor.role), db = authDatabase(env);
  const row = await requireCase(db, url);
  return jsonSuccess(await applyReview(db, actor, row, input));
});
export const getAdminProof = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env);
  const caseId = pathCaseId(url), fileId = url.pathname.split("/")[6];
  const missing = () => new AdminError(404, "PROOF_NOT_FOUND", "Proof not found");
  if (!UUID_PATTERN.test(fileId ?? "")) throw missing();
  const file = await authDatabase(env).prepare(`SELECT f.object_key, f.content_type, f.size, f.etag FROM case_files f
    JOIN cases c ON c.id = f.case_id WHERE c.case_id = ? AND f.id = ?`).bind(caseId, fileId).first();
  if (!file) throw missing();
  const object = await env.PROOFS_BUCKET.get(file.object_key);
  if (!object) throw missing();
  if (!allowedMime(file.content_type) || object.httpMetadata?.contentType !== file.content_type ||
      object.size !== file.size || object.etag !== file.etag || object.size > UPLOAD_LIMITS.maxFileBytes || object.size <= 0) {
    await object.body.cancel();
    throw new AdminError(409, "PROOF_INTEGRITY_ERROR", "Proof integrity check failed");
  }
  // Only verified raster types; never forward untrusted object response headers.
  return new Response(object.body, { headers: { "Content-Type": file.content_type, "Content-Length": String(object.size),
    "Content-Disposition": "inline", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer" } });
});
export const listAdminAudit = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env, ELEVATED_ROLES);
  return jsonSuccess(await auditLogs(authDatabase(env), adminPage(url, true)));
});

const exactRoutes = new Map([
  ["/api/admin/me", { method: "GET", handler: currentAdmin }],
  ["/api/admin/cases", { method: "GET", handler: listAdminCases }],
  ["/api/admin/audit-logs", { method: "GET", handler: listAdminAudit }],
]);
export function adminRoute(path) {
  if (exactRoutes.has(path)) return exactRoutes.get(path);
  if (/^\/api\/admin\/cases\/[^/]+$/.test(path)) return { method: "GET", handler: getAdminCase };
  if (/^\/api\/admin\/cases\/[^/]+\/review$/.test(path)) return { method: "POST", handler: reviewAdminCase };
  if (/^\/api\/admin\/cases\/[^/]+\/files\/[^/]+$/.test(path)) return { method: "GET", handler: getAdminProof };
}
