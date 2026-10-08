// Paste into DevTools Console on the Production homepage, then run:
// voteProofB2.run(prompt("Production public Turnstile Site Key"))
// Temporary browser session only; never loads a Worker secret or bypasses Siteverify.
(() => {
  const origin = "https://voteproof.i-dle-melon.workers.dev";
  if (location.origin !== origin) throw new Error("Open the VoteProof Production homepage first");
  const rows = [];
  let prepared, expiryTimer, running = false;
  const record = (test, result) => { rows.push({ test, result }); console.table(rows); };
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  async function post(path, body, status, code) {
    const response = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    ensure(response.status === status, "Unexpected API HTTP status");
    ensure(response.headers.get("cache-control") === "no-store", "Missing no-store");
    const payload = await response.json();
    if (code) ensure(payload.ok === false && payload.error.code === code, "Unexpected API error");
    else ensure(payload.ok === true, "API did not succeed");
    return payload;
  }
  async function check(name, action, needsVisibleRejection = false) {
    try { await action(); record(name, "PASS"); }
    catch (error) {
      // R2 rejection responses can omit CORS headers (notably ExpiredRequest).
      // A network error is neither proof of rejection nor a successful test.
      record(name, needsVisibleRejection && error instanceof TypeError
        ? "NEEDS_TERMINAL: read the real R2 status without browser CORS"
        : "FAIL (inspect HTTP status; do not share token/URL)");
    }
  }
  async function tokenFromWidget(sitekey) {
    if (!window.turnstile) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.onload = resolve; script.onerror = () => reject(new Error("Official widget did not load"));
        document.head.append(script);
      });
    }
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;background:white;padding:16px;color:black";
    container.textContent = "B2 Production 驗收：如需人機驗證，請手動完成。";
    document.body.append(container);
    return new Promise((resolve, reject) => {
      let widget, finished = false;
      const timeout = setTimeout(() => finish(null), 180000);
      function finish(token) {
        if (finished) return;
        finished = true; clearTimeout(timeout);
        if (widget !== undefined) window.turnstile.remove(widget);
        container.remove();
        if (token) resolve(token); else reject(new Error("Turnstile did not finish"));
      }
      widget = window.turnstile.render(container, {
        sitekey, callback: token => finish(token),
        "error-callback": () => { finish(null); return true; },
        "expired-callback": () => finish(null),
      });
    });
  }
  async function run(sitekey) {
    ensure(typeof sitekey === "string" && sitekey.trim(), "Public Site Key required");
    ensure(!running, "A run is already active; reload before repeating");
    running = true;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    canvas.getContext("2d").fillRect(0, 0, 1, 1);
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    try {
      const token = await tokenFromWidget(sitekey.trim());
      prepared = (await post("/api/uploads/prepare", {
        turnstile_token: token,
        files: Array.from({ length: 5 }, (_, i) => ({ name: `acceptance-${i}.png`, type: "image/png", size: png.size })),
      }, 200)).data;
      ensure(prepared.expires_in === 300 && prepared.uploads.length === 5, "Wrong upload contract");
      for (const upload of prepared.uploads) {
        const url = new URL(upload.upload_url);
        ensure(url.searchParams.get("X-Amz-Expires") === "300", "Wrong TTL");
        ensure(url.searchParams.get("X-Amz-SignedHeaders") === "content-type;host", "Content-Type not signed");
        ensure(upload.method === "PUT" && upload.headers["Content-Type"] === "image/png", "Wrong method/MIME");
        ensure(upload.key.startsWith("proofs/staging/") && upload.key.includes(`/${prepared.session_id}/`), "Wrong staging key");
      }
      record("prepare real Turnstile / server UUID keys / 300s / signed MIME", "PASS");
      const [normal, large, mixed, missing, expiry] = prepared.uploads;
      const put = (upload, body, type = "image/png") => fetch(upload.upload_url, {
        method: "PUT", headers: { "Content-Type": type }, body, signal: AbortSignal.timeout(30000),
      });
      const complete = (keys, status, code, session = prepared.session_id) => post("/api/uploads/complete", { session_id: session, keys }, status, code);
      await check("browser direct PNG PUT + CORS + complete", async () => {
        const response = await put(normal, png);
        ensure(response.ok, "PUT failed");
        ensure(response.headers.get("ETag"), "ETag not exposed by CORS");
        const payload = await complete([normal.key], 200);
        ensure(payload.data.files[0].size === png.size, "Incorrect actual size");
        ensure(!JSON.stringify(payload).includes("https://"), "Unexpected public URL");
      });
      await check("changed Content-Type rejected", async () => {
        // A CORS network error alone does not prove signature rejection.
        const response = await put(normal, png, "image/jpeg");
        ensure(response.status === 403, "Expected visible R2 403");
      }, true);
      await check("nonexistent object", () => complete([missing.key], 400, "UPLOAD_INCOMPLETE"));
      await check("different session rejected", () => complete([normal.key], 400, "INVALID_UPLOAD_REQUEST", crypto.randomUUID()));
      await check("actual oversize rejected + deleted", async () => {
        ensure((await put(large, new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" }))).ok, "Oversize fixture PUT failed");
        await complete([large.key], 400, "UPLOAD_VALIDATION_FAILED");
        await complete([large.key], 400, "UPLOAD_INCOMPLETE");
      });
      await check("mixed successful/missing cannot succeed", async () => {
        ensure((await put(mixed, png)).ok, "Mixed fixture PUT failed");
        await complete([mixed.key, missing.key], 400, "UPLOAD_INCOMPLETE");
      });
      await check("expiry fixture initially accepts PUT", async () => ensure((await put(expiry, png)).ok, "Initial expiry fixture PUT failed"));
      const date = new URL(expiry.upload_url).searchParams.get("X-Amz-Date");
      const issued = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15));
      expiryTimer = setTimeout(() => check("PUT rejected after 300 seconds", async () => {
        const response = await put(expiry, png);
        ensure(response.status === 403, "Expired PUT must return visible 403");
      }, true), Math.max(0, issued + 306000 - Date.now()));
      record("expiry timer", "WAIT: leave this tab open until expiry result appears");
      console.log("For GET/private checks and staging cleanup follow docs/b2-production-acceptance.md. Never share signed URLs/tokens.");
    } catch { record("real Turnstile / prepare", "FAIL: check widget and API status without sharing credentials"); }
  }
  window.voteProofB2 = {
    run,
    report: () => rows.map(row => ({ ...row })),
    getPutUrl: () => prepared?.uploads[0].upload_url,
    getCleanupKeys: () => prepared?.uploads.map(upload => upload.key) ?? [],
    stopTimer: () => clearTimeout(expiryTimer),
  };
  console.log("Ready: voteProofB2.run(prompt('Production public Turnstile Site Key'))");
})();
