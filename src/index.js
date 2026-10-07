import { routeApi } from "./api/router.js";

export default {
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
