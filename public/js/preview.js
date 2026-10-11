// Build marker + isolated host are both required. Production never uses fixtures.
export function previewAllowed(marker, hostname, protocol = "https:") {
  return marker === "isolated" && ["https:", "http:"].includes(protocol) &&
    (/^[a-z0-9-]+\.github\.io$/i.test(hostname) || ["localhost", "127.0.0.1", "[::1]"].includes(hostname));
}
export const PREVIEW = typeof document !== "undefined" && typeof location !== "undefined" &&
  previewAllowed(document.querySelector('meta[name="voteproof-preview"]')?.content, location.hostname, location.protocol);
export function assetURL(path) {
  return PREVIEW ? new URL(".." + path, import.meta.url).href : path;
}
export async function previewFetch(path, options = {}) {
  const denied = () => new Response(JSON.stringify({ ok: false, error: { code: "UI_PREVIEW_ONLY" } }),
    { status: 403, headers: { "Content-Type": "application/json" } });
  if (!PREVIEW || (options.method ?? "GET") !== "GET" || typeof path !== "string" || !path.startsWith("/api/")) return denied();
  // No fetch, provider redirects, tokens or persisted state inside this adapter.
  const { fixtureResponse } = await import("./preview-fixtures.js");
  return fixtureResponse(path);
}
export function setupPreview() {
  if (!PREVIEW) return;
  document.getElementById("ui-preview-banner").hidden = false;
  document.documentElement.dataset.preview = "isolated";
  // Authentication and all form submissions are inert, including future forms.
  document.addEventListener("submit", event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
  for (const id of ["login-google", "register-google", "security-google-step", "security-link-confirm"]) {
    const button = document.getElementById(id);
    if (button) { button.disabled = true; button.title = "預覽不會啟動登入或身份驗證"; }
  }
  for (const button of document.querySelectorAll("[data-preview-scene]")) button.addEventListener("click", () => {
    const url = new URL(location.href); url.searchParams.set("ui", button.dataset.previewScene);
    url.hash = button.dataset.previewScene === "admin" ? "admin" : button.dataset.previewScene === "member" ? "member" : "login";
    location.replace(url.href);
  });
}
