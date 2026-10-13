import { routeApi } from "./api/router.js";
import { processBackups } from "./lib/proof-backup-processor.js";
import { legacyBackupTransport } from "./lib/drive-backup-relay.js";

export default {
  async scheduled(_event, env, ctx) {
    // No trigger is configured by this change; activation is a separate rollout.
    // Deprecated direct OAuth executor is opt-in for isolated rollback comparison only.
    // Apps Script owns scheduling; a Worker Cron cannot run the pull transport.
    if (legacyBackupTransport(env)) ctx.waitUntil(processBackups(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    // API requests must never fall through to the static website.
    if (url.pathname.startsWith("/api/")) {
      return routeApi(request, env, url);
    }

    // 其他請求交給現有網站
    return env.ASSETS.fetch(request);
  }
};
