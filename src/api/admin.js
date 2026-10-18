import {batchReviewInput,batchApprove} from "../lib/review-batch.js";
import { jsonSuccess } from "./response.js";
import { adminHandler } from "./admin-response.js";
import { authDatabase, csrfToken } from "../lib/auth-session.js";
import { AdminError, adminIdentity, adminCsrf, ELEVATED_ROLES } from "../lib/admin-identity.js";
import { CASE_ID_PATTERN } from "../lib/case-keys.js";
import { caseNotFound, reviewInput } from "../lib/case-review.js";
import { adminPage, readReviewJson, UUID_PATTERN } from "./admin-validation.js";
import { adminCases, adminCase, adminFiles, applyReview, auditLogs } from "../lib/admin-store.js";
import { allowedMime, UPLOAD_LIMITS } from "./upload-validation.js";
import { adminExactEvidence } from '../lib/proof-exact-hash.js';

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
export const getAdminOverview = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env);
  if (url.search) throw new AdminError(400, "INVALID_ADMIN_QUERY", "Unexpected overview query");
  const { member_count } = await authDatabase(env).prepare("SELECT COUNT(*) AS member_count FROM members").first();
  return jsonSuccess({ member_count });
});
export const getAdminCase = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env);
  const db = authDatabase(env), { id, upload_intent_id, ...row } = await requireCase(db, url);
  return jsonSuccess({ ...row, files: await adminFiles(db, id), duplicate_evidence:upload_intent_id?null:await adminExactEvidence(db,id) });
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
  return privateProofResponse(env,file);
});
export async function privateProofResponse(env,file) {
  let object = await env.PROOFS_BUCKET.get(file.object_key);
  if (!object) {
    const archived=await env.DB.prepare("SELECT p.state FROM case_files f JOIN cold_proofs p ON p.file_id=f.id WHERE f.object_key=?").bind(file.object_key).first();
    if(archived?.state==='cold')throw new AdminError(410,'PROOF_ARCHIVED_IN_DRIVE','圖片已封存至 Google Drive，請由管理員手動開啟備份。');
    throw new AdminError(404,'PROOF_NOT_FOUND','Proof not found');
  }
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
}
export const listAdminAudit = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env, ELEVATED_ROLES);
  return jsonSuccess(await auditLogs(authDatabase(env), adminPage(url, true)));
});

export const approveAdminBatch=adminHandler(async(env,_url,request)=>{const actor=await adminIdentity(request,env);await adminCsrf(request,env,actor);const items=batchReviewInput(await readReviewJson(request));return jsonSuccess(await batchApprove(authDatabase(env),actor,items));});
const exactRoutes = new Map([
  ["/api/admin/cases/batch-approve",{method:"POST",handler:approveAdminBatch}],
  ["/api/admin/me", { method: "GET", handler: currentAdmin }],
  ["/api/admin/overview", { method: "GET", handler: getAdminOverview }],
  ["/api/admin/cases", { method: "GET", handler: listAdminCases }],
  ["/api/admin/audit-logs", { method: "GET", handler: listAdminAudit }],
]);
export function adminRoute(path) {
  if (exactRoutes.has(path)) return exactRoutes.get(path);
  if (/^\/api\/admin\/cases\/[^/]+$/.test(path)) return { method: "GET", handler: getAdminCase };
  if (/^\/api\/admin\/cases\/[^/]+\/review$/.test(path)) return { method: "POST", handler: reviewAdminCase };
  if (/^\/api\/admin\/cases\/[^/]+\/files\/[^/]+$/.test(path)) return { method: "GET", handler: getAdminProof };
}
