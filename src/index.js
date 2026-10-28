import { routeApi } from "./api/router.js";
import { processBackups } from "./lib/proof-backup-processor.js";
import { legacyBackupTransport } from "./lib/drive-backup-relay.js";
import { fencedRequest, resetControlRoute, resetEnabled } from './lib/prelaunch-reset-fence.js';

export default {
  async scheduled(_event, env, ctx) {
    // No trigger is configured by this change; activation is a separate rollout.
    // Deprecated direct OAuth executor is opt-in for isolated rollback comparison only.
    // Apps Script owns scheduling; a Worker Cron cannot run the pull transport.
    if (resetEnabled(env)) throw new Error('RESET_SCHEDULED_REQUIRES_REQUEST_ADMISSION');
    if (legacyBackupTransport(env)) ctx.waitUntil(processBackups(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    // API requests must never fall through to the static website.
    if (url.pathname.startsWith("/api/")) {
      try {
        const control=await resetControlRoute(request,env,url);
        if(control)return control;
        return await fencedRequest(env,request,scoped=>routeApi(request,scoped,url));
      } catch(error) {
        return Response.json({ok:false,error:{code:error?.code??'PRELAUNCH_FENCE_UNAVAILABLE',message:'Service temporarily unavailable'}},{status:Number.isInteger(error?.status)?error.status:503,headers:{'Cache-Control':'no-store'}});
      }
    }

    // 其他請求交給現有網站
    return env.ASSETS.fetch(request);
  }
};
