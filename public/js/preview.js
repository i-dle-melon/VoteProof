// Build marker + isolated host are both required. Production never uses fixtures.
export function previewAllowed(marker, hostname, protocol = "https:") {
  return marker === "isolated" && ["https:", "http:"].includes(protocol) &&
    (/^[a-z0-9-]+\.github\.io$/i.test(hostname) || ["localhost", "127.0.0.1", "[::1]"].includes(hostname));
}
// Production cannot activate fixtures through DOM, query strings or storage.
// The isolated builder replaces this whole transport module.
export const PREVIEW = false;
export function assetURL(path) {
  return path;
}
export async function previewFetch(path, options = {}) {
  const denied = () => new Response(JSON.stringify({ ok: false, error: { code: "UI_PREVIEW_ONLY" } }),
    { status: 403, headers: { "Content-Type": "application/json" } });
  return denied();
}
export function setupPreview() {
  // No Preview UI exists in the Production source.
}
