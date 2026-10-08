// Console-only diagnostic: paste, then call voteProofB2Diagnose(publicSiteKey, copy).
// Copies a fresh PUT URL privately to clipboard, never prints it or any token.
window.voteProofB2Diagnose = async function (sitekey, copyUrl) {
  if (location.origin !== "https://voteproof.i-dle-melon.workers.dev" || typeof copyUrl !== "function") {
    throw new Error("Use the Production DevTools Console with its copy helper");
  }
  const result = {};
  const update = () => { document.documentElement.dataset.voteproofB2Diagnostic = JSON.stringify(result); };
  if (!window.turnstile) throw new Error("Load the main acceptance script first");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  canvas.getContext("2d").fillRect(0, 0, 1, 1);
  const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;background:white;padding:16px;color:black";
  container.textContent = "B2 診斷：請手動完成官方 Turnstile。";
  document.body.append(container);
  try {
    const token = await new Promise((resolve, reject) => {
      window.turnstile.render(container, {
        sitekey, callback: resolve,
        "error-callback": () => { reject(new Error("Turnstile failed")); return true; },
      });
    });
    const response = await fetch("/api/uploads/prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstile_token: token, files: [{ name: "diagnostic.png", type: "image/png", size: png.size }] }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    result.prepareStatus = response.status;
    if (!payload.ok) { result.code = payload.error?.code; update(); return; }
    const upload = payload.data.uploads[0];
    result.session_id = payload.data.session_id; result.key = upload.key;
    result.expires_in = payload.data.expires_in;
    result.issued_at = new URL(upload.upload_url).searchParams.get("X-Amz-Date");
    copyUrl(upload.upload_url); result.urlCopied = true; update();
    try {
      const put = await fetch(upload.upload_url, {
        method: "PUT", headers: upload.headers, body: png, signal: AbortSignal.timeout(30000),
      });
      result.browserPutStatus = put.status;
      result.etagExposed = Boolean(put.headers.get("ETag"));
      if (put.ok) {
        const complete = await fetch("/api/uploads/complete", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: result.session_id, keys: [upload.key] }),
          signal: AbortSignal.timeout(15000),
        });
        result.browserCompleteStatus = complete.status;
      }
    } catch { result.browserPutError = "NETWORK_OR_CORS"; }
  } catch { result.diagnosticError = "Widget or request failed; no sensitive details logged"; }
  finally { container.remove(); result.finished = true; update(); console.log("B2 diagnostic finished; safe result is in the page dataset. URL is only in clipboard."); }
};
