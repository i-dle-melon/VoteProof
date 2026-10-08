import { jsonError } from "./response.js";
import { AuthError } from "./auth-validation.js";
import { AdminError } from "../lib/admin-identity.js";

export const adminHandler = action => async (env, url, request) => {
  try { return await action(env, url, request); }
  catch (e) {
    if (e instanceof AdminError || e instanceof AuthError) return jsonError(e.status, e.code, e.message);
    return jsonError(503, "ADMIN_SERVICE_UNAVAILABLE", "Administrative service is unavailable");
  }
};
