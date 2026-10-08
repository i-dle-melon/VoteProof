import { jsonSuccess, jsonError } from "./response.js";
import { publicCampaigns } from "../lib/campaign-store.js";

export async function getCampaigns(env) {
  if (typeof env.DB?.prepare !== "function") return jsonError(503, "DB_NOT_CONFIGURED", "Campaign service is not configured");
  try { return jsonSuccess({ campaigns: await publicCampaigns(env.DB) }); }
  catch { return jsonError(503, "CAMPAIGN_SERVICE_UNAVAILABLE", "Campaign service is unavailable"); }
}
