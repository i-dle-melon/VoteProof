import { jsonSuccess } from "./response.js";
import { adminHandler } from "./admin-response.js";
import { readReviewJson, UUID_PATTERN } from "./admin-validation.js";
import { memberSession, authDatabase } from "../lib/auth-session.js";
import { adminIdentity, adminCsrf, ELEVATED_ROLES, AdminError } from "../lib/admin-identity.js";
import { pointSummary, adjustmentInput, adjustmentIdentity, adjustPoints } from "../lib/point-ledger.js";

export const memberPoints = adminHandler(async (env, _url, request) => {
  const member = await memberSession(request, env); return jsonSuccess(await pointSummary(authDatabase(env), member.member_id));
});
export const adminMemberPoints = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env, ELEVATED_ROLES);
  const id = url.pathname.split("/")[4], db = authDatabase(env);
  if (typeof id !== "string" || id.length !== 38 || !id.startsWith("M-") || !UUID_PATTERN.test(id.slice(2)) ||
      !await db.prepare("SELECT member_id FROM members WHERE member_id = ?").bind(id).first()) throw new AdminError(404, "MEMBER_NOT_FOUND", "Member not found");
  return jsonSuccess(await pointSummary(db, id));
});
export const createAdjustment = adminHandler(async (env, _url, request) => {
  const actor = await adminIdentity(request, env, ELEVATED_ROLES); await adminCsrf(request, env, actor);
  const input = adjustmentInput(await readReviewJson(request)), identity = await adjustmentIdentity(request, actor, input);
  return jsonSuccess(await adjustPoints(authDatabase(env), actor, input, identity), "no-store", 201);
});
export function pointRoute(path) {
  if (path === "/api/me/points") return { method: "GET", handler: memberPoints };
  if (path === "/api/admin/points/adjustments") return { method: "POST", handler: createAdjustment };
  if (/^\/api\/admin\/members\/[^/]+\/points$/.test(path)) return { method: "GET", handler: adminMemberPoints };
}
