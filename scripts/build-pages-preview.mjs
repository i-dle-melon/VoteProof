// Disposable artifact, always generated from the same public/ source.
import { cp, mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TIER_ARTWORK } from "../public/js/tier-artwork.js";

// Remove whole balanced elements, including nested sections. Fail the build if
// an operator accidentally renames a boundary; never publish the private view.
export function removeElement(html, id) {
  const tags = /<!--[\s\S]*?-->|<\/?([a-z][\w-]*)\b[^>]*>/gi;
  let start = -1, tag, depth = 0;
  for (const match of html.matchAll(tags)) {
    if (!match[1]) continue;
    const closing = match[0].startsWith("</");
    if (start < 0 && !closing && new RegExp(`\\bid="${id}"`).test(match[0])) {
      start = match.index; tag = match[1].toLowerCase(); depth = 1; continue;
    }
    if (start >= 0 && match[1].toLowerCase() === tag) {
      depth += closing ? -1 : 1;
      if (!depth) return html.slice(0, start) + html.slice(match.index + match[0].length);
    }
  }
  throw new Error("Required preview exclusion boundary missing: " + id);
}
function replaceRequired(source, before, after) {
  if (!source.includes(before)) throw new Error("Required preview runtime boundary missing");
  return source.replace(before, after);
}
export async function buildPagesPreview(output) {
  const allowed = resolve(".wrangler/pages-preview");
  if (resolve(output) !== allowed) throw new Error("Preview output must be the isolated generated artifact");
  await mkdir(allowed, { recursive: true });
  // Explicit file allowlist: stale protected JS from an earlier artifact cannot
  // survive a rebuild. Only files under this fixed generated directory removed.
  const files = ["index.html", "css/app.css", "js/app.js", "js/api.js", "js/submission.js", "js/turnstile.js", "js/preview.js", "js/preview-fixtures.js", "js/tier-artwork.js", ...Object.values(TIER_ARTWORK).map(a => a.src.slice(1))];
  async function discardStale(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = resolve(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Preview symlinks are not allowed");
      if (entry.isDirectory()) await discardStale(file); else await unlink(file);
    }
  }
  await discardStale(allowed);
  for (const file of files) {
    await mkdir(resolve(allowed, file, ".."), { recursive: true });
    await cp(resolve("public", file), resolve(allowed, file));
  }
  let html = await readFile(resolve(allowed, "index.html"), "utf8");
  html = html.replace("<head>", '<head>\n<meta name="voteproof-preview" content="isolated">\n<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' blob:; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">');
  html = html.replaceAll('href="/css/', 'href="./css/').replaceAll('src="/js/', 'src="./js/');
  // Banner is present before JavaScript runs; a failed module cannot disguise it.
  html = html.replace(/id="ui-preview-banner"\s+hidden/, 'id="ui-preview-banner"');
  for (const id of ["view-admin", "admin-ui-copy", "admin-nav-group", "view-security", "view-member", "view-register", "view-recover", "view-google", "login-totp-form"]) html = removeElement(html, id);
  html = html.replace(/<meta\b[^>]*name="turnstile-site-key"[^>]*>/, "");
  html = html.replace(/<button\b[^>]*data-preview-scene="(?:admin|member)"[^>]*>[\s\S]*?<\/button>/g, "");
  html = html.replace(/<a\b[^>]*href="#security"[^>]*>[\s\S]*?<\/a>/g, "");
  html = html.replace(/href="#(?:member|register|recover|google)"/g, 'href="#login"').replace(/data-view="member"/g, 'data-view="login"');
  const gallery = `<div class="card" id="preview-tier-artwork"><h2>等級圖案預覽</h2><p>僅供外觀檢視，不代表已開放等級。</p>${Object.values(TIER_ARTWORK).map(a => `<figure><img class="approved-tier-artwork" src=".${a.src}" alt="${a.name}等級" width="${a.width}" height="${a.height}" loading="lazy"><figcaption>${a.name}</figcaption></figure>`).join("")}</div>`;
  html = replaceRequired(html, '<footer class="footer-note">', gallery + '<footer class="footer-note">');
  let app = await readFile(resolve(allowed, "js/app.js"), "utf8");
  for (const module of ["admin", "member", "member-api"]) app = replaceRequired(app, `from "./${module}.js"`, 'from "./pages-public-ui.js"');
  app = replaceRequired(app, '["home", "submit", "lookup", "leaderboards", "about", "register", "login", "recover", "member", "google", "security", "admin"]', '["home", "submit", "lookup", "leaderboards", "about", "login"]');
  await writeFile(resolve(allowed, "js/app.js"), app);
  await cp(resolve("scripts/lib/pages-public-ui.js"), resolve(allowed, "js/pages-public-ui.js"));
  if (/id="(?:view-(?:admin|security|member|register|recover|google)|admin-ui-copy|login-totp-form)"|href="#(?:admin|security)"|data-preview-scene="(?:admin|member)"/.test(html)) throw new Error("Protected view in public preview");
  await writeFile(resolve(allowed, "index.html"), html);
  await writeFile(resolve(allowed, ".nojekyll"), "");
  return allowed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildPagesPreview(resolve(".wrangler/pages-preview"));
  process.stdout.write("Pages preview artifact ready; Production source unchanged\n");
}
