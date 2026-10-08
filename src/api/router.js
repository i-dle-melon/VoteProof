import { getHealth } from "./health.js";
import { getCampaigns } from "./campaigns.js";
import { getLeaderboards } from "./leaderboards.js";
import { jsonError } from "./response.js";
import { prepareUpload, completeUpload } from "./uploads.js";
import { createCase, getCase } from "./cases.js";
import { startLogin, verifyLogin, currentMember, logout } from "./auth.js";
import { updateProfile, listMemberCases, getMemberCase } from "./members.js";

const routes = new Map([
  ["/api/health", { method: "GET", handler: getHealth }],
  ["/api/campaigns", { method: "GET", handler: getCampaigns }],
  ["/api/leaderboards", { method: "GET", handler: getLeaderboards }],
  ["/api/uploads/prepare", { method: "POST", handler: prepareUpload }],
  ["/api/uploads/complete", { method: "POST", handler: completeUpload }],
  ["/api/cases", { method: "POST", handler: createCase }],
  ["/api/auth/start", { method: "POST", handler: startLogin }],
  ["/api/auth/verify", { method: "POST", handler: verifyLogin }],
  ["/api/auth/me", { method: "GET", handler: currentMember }],
  ["/api/auth/logout", { method: "POST", handler: logout }],
  ["/api/me/profile", { method: "PATCH", handler: updateProfile }],
  ["/api/me/cases", { method: "GET", handler: listMemberCases }],
]);

export async function routeApi(request, env, url) {
  const route = routes.get(url.pathname) ?? (/^\/api\/cases\/[^/]+$/.test(url.pathname)
    ? { method: "GET", handler: getCase } : /^\/api\/me\/cases\/[^/]+$/.test(url.pathname)
      ? { method: "GET", handler: getMemberCase } : undefined);
  if (!route) {
    return jsonError(404, "NOT_FOUND", "API endpoint not found");
  }
  if (request.method !== route.method) {
    return jsonError(405, "METHOD_NOT_ALLOWED", `Only ${route.method} is supported`, { allow: route.method });
  }
  try {
    return await route.handler(env, url, request);
  } catch {
    // Never expose exception messages, environment bindings or upstream URLs.
    return jsonError(500, "INTERNAL_ERROR", "API request failed");
  }
}
