import { getHealth } from "./health.js";
import { getCampaigns } from "./campaigns.js";
import { getLeaderboards } from "./leaderboards.js";
import { jsonError } from "./response.js";

const routes = new Map([
  ["/api/health", getHealth],
  ["/api/campaigns", getCampaigns],
  ["/api/leaderboards", getLeaderboards],
]);

export async function routeApi(request, env, url) {
  const handler = routes.get(url.pathname);
  if (!handler) {
    return jsonError(404, "NOT_FOUND", "API endpoint not found");
  }
  if (request.method !== "GET") {
    return jsonError(405, "METHOD_NOT_ALLOWED", "Only GET is supported", { allow: "GET" });
  }
  try {
    return await handler(env, url);
  } catch {
    // Never expose exception messages, environment bindings or upstream URLs.
    return jsonError(500, "INTERNAL_ERROR", "API request failed");
  }
}
