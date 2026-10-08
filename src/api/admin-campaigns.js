import { adminHandler } from "./admin-response.js";
import { jsonSuccess } from "./response.js";
import { authDatabase } from "../lib/auth-session.js";
import { adminIdentity, adminCsrf, ELEVATED_ROLES } from "../lib/admin-identity.js";
import { readReviewJson } from "./admin-validation.js";
import { campaignInput, campaignMissing, CAMPAIGN_ID } from "../lib/campaign-policy.js";
import { getAdminCampaign, saveCampaign, listCampaigns } from "../lib/campaign-store.js";

const pathId = url => { const id = url.pathname.split("/")[4]; if (typeof id !== "string" || id.length > 100 || !CAMPAIGN_ID.test(id)) throw campaignMissing(); return id; };
export const listAdminCampaigns = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env); return jsonSuccess(await listCampaigns(authDatabase(env), url));
});
export const readAdminCampaign = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env); return jsonSuccess(await getAdminCampaign(authDatabase(env), pathId(url)));
});
export const createAdminCampaign = adminHandler(async (env, _url, request) => {
  const actor = await adminIdentity(request, env, ELEVATED_ROLES); await adminCsrf(request, env, actor);
  return jsonSuccess(await saveCampaign(authDatabase(env), actor, campaignInput(await readReviewJson(request))), "no-store", 201);
});
export const updateAdminCampaign = adminHandler(async (env, url, request) => {
  const actor = await adminIdentity(request, env, ELEVATED_ROLES); await adminCsrf(request, env, actor);
  const db = authDatabase(env), existing = await getAdminCampaign(db, pathId(url));
  return jsonSuccess(await saveCampaign(db, actor, campaignInput(await readReviewJson(request), true), existing));
});
export function campaignRoute(path, method) {
  if (path === "/api/admin/campaigns") return method === "POST" ? { method: "POST", handler: createAdminCampaign }
    : { method: "GET", handler: listAdminCampaigns, allow: "GET, POST" };
  if (/^\/api\/admin\/campaigns\/[^/]+\/update$/.test(path)) return { method: "POST", handler: updateAdminCampaign };
  if (/^\/api\/admin\/campaigns\/[^/]+$/.test(path)) return { method: "GET", handler: readAdminCampaign };
}
