import { getHealth } from "./health.js";
import { getCampaigns } from "./campaigns.js";
import { getLeaderboards } from "./leaderboards.js";
import { jsonError } from "./response.js";
import { prepareUpload, completeUpload } from "./uploads.js";

const routes = new Map([
  ["/api/health", { method: "GET", handler: getHealth }],
  ["/api/campaigns", { method: "GET", handler: getCampaigns }],
  ["/api/leaderboards", { method: "GET", handler: getLeaderboards }],
  ["/api/uploads/prepare", { method: "POST", handler: prepareUpload }],
  ["/api/uploads/complete", { method: "POST", handler: completeUpload }],
]);

export async function routeApi(request, env, url) {
  const route = routes.get(url.pathname);
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
