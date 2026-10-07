export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 之後 Turnstile、上傳、會員、案件 API 都放在 /api/*
    if (url.pathname.startsWith("/api/")) {
      return new Response(
        JSON.stringify({
          ok: false,
          message: "VoteProof API 尚未實作"
        }),
        {
          status: 404,
          headers: {
            "content-type": "application/json; charset=utf-8"
          }
        }
      );
    }

    // 其他請求交給現有網站
    return env.ASSETS.fetch(request);
  }
};