// Disposable artifact, always generated from the same public/ source.
import { cp, mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TIER_ARTWORK } from "../public/js/tier-artwork.js";

// Balanced HTML helpers retained for operator edits and regression checks.
function elementRange(html, openingMatch) {
  const tags = /<!--[\s\S]*?-->|<\/?([a-z][\w-]*)\b[^>]*>/gi;
  let start = -1,
    tag,
    depth = 0;
  for (const match of html.matchAll(tags)) {
    if (!match[1]) continue;
    const closing = match[0].startsWith("</");
    if (start < 0 && !closing && openingMatch(match[0])) {
      start = match.index;
      tag = match[1].toLowerCase();
      depth = 1;
      continue;
    }
    if (start >= 0 && match[1].toLowerCase() === tag) {
      depth += closing ? -1 : 1;
      if (!depth) return { start, close: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}
export function removeElement(html, id) {
  const range = elementRange(html, (opening) => new RegExp(`\\bid="${id}"`).test(opening));
  if (!range) throw new Error("Required preview exclusion boundary missing: " + id);
  return html.slice(0, range.start) + html.slice(range.end);
}
export function removeMatchingElements(html, openingPattern) {
  let range;
  while ((range = elementRange(html, (opening) => openingPattern.test(opening)))) {
    html = html.slice(0, range.start) + html.slice(range.end);
  }
  return html;
}
function replaceRequired(source, before, after) {
  if (!source.includes(before)) throw new Error("Required preview runtime boundary missing");
  return source.replace(before, after);
}
export async function buildPagesPreview(output) {
  const allowed = resolve(".wrangler/pages-preview");
  if (resolve(output) !== allowed)
    throw new Error("Preview output must be the isolated generated artifact");
  await mkdir(allowed, { recursive: true });
  // Explicit file allowlist: stale protected JS from an earlier artifact cannot
  // survive a rebuild. Only files under this fixed generated directory removed.
  const files = [
    "index.html",
    "css/app.css",
    "js/app.js",
    "js/leaderboard-ui.js", "js/vote-date.js",
    "js/campaign-guidance.js", "js/announcements.js",
    "js/api.js",
    "js/member.js",
    "js/admin.js", "js/admin-proof-thumbnails.js",
    "js/admin-api.js",
    "js/admin-backup.js",
    "js/admin-duplicate.js",
    "js/admin-export.js", "js/export-format.js", "js/zip-store.js", "js/export-worker.js",
    "js/member-tier-progress.js",
    "js/qr.js",
    "js/vendor/qrcode.js",
    "js/tier-artwork.js",
    "js/ui-system.js",
    ...Object.values(TIER_ARTWORK).map((art) => art.src.slice(1)),
  ];
  async function discardStale(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = resolve(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Preview symlinks are not allowed");
      if (entry.isDirectory()) await discardStale(file);
      else await unlink(file);
    }
  }
  await discardStale(allowed);
  for (const file of files) {
    await mkdir(resolve(allowed, file, ".."), { recursive: true });
    await cp(resolve("public", file), resolve(allowed, file));
  }
  let html = await readFile(resolve(allowed, "index.html"), "utf8");
  html = html.replace(
    "<head>",
    "<head>\n<meta name=\"voteproof-preview\" content=\"isolated\">\n<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">",
  );
  html = html.replaceAll('href="/css/', 'href="./css/').replaceAll('src="/js/', 'src="./js/');
  const controls = await readFile("scripts/lib/pages-preview-controls.html", "utf8");
  html = html
    .replace("<body>", "<body>\n" + controls)
    .replaceAll('href="/admin#admin"', 'href="#admin"');
  html = html.replace(/<meta\b[^>]*name="turnstile-site-key"[^>]*>/, "");
  const adapters = {
    "pages-preview-runtime.js": "preview.js",
    "pages-preview-fixtures.js": "preview-fixtures.js",
    "pages-preview-content.js": "preview-content.js",
    "pages-preview-state.js": "pages-preview-state.js",
    "pages-public-ui.js": "member-api.js",
    "pages-preview-challenge.js": "turnstile.js",
    "pages-preview-submission.js": "pages-preview-submission.js",
    "pages-preview-batch.js": "submission.js",
    "pages-preview-exports.js": "preview-exports.js",
  };
  for (const [from, to] of Object.entries(adapters))
    await cp(resolve("scripts/lib", from), resolve(allowed, "js", to));
  await cp(resolve("public/js/member-api.js"), resolve(allowed, "js/member-rules.js"));
  await cp(resolve("public/js/submission.js"), resolve(allowed, "js/submission-core.js"));
  let app = await readFile(resolve(allowed, "js/app.js"), "utf8");
  // No unsaved real submission exists in a read-only fixture page.
  app = app.replace(/window\.addEventListener\("beforeunload",[\s\S]*?\n\}\);/, "");
  app += `\nimport {mountSubmissionScene} from './pages-preview-submission.js';
    await Promise.all([member.ready,campaignRequest,gateRequest]);
    submission.activatePreview();syncForm();
    await mountSubmissionScene({images(files){clearImages();images=files.map(file=>({file,url:URL.createObjectURL(file)}));renderImages();},batch:renderBatch,receipt:renderSubmissionReceipt,progress:renderSubmissionProgress,failure(){renderSubmissionFailure(new PublicError('PUT_FAILED'));}});
    document.documentElement.dataset.previewReady='true';`;
  await writeFile(resolve(allowed, "js/app.js"), app);
  // Preview-only framing: the banner must not cover the fixed desktop brand.
  await writeFile(
    resolve(allowed, "css/app.css"),
    (await readFile(resolve("public/css/app.css"), "utf8")) +
      "\n" +
      (await readFile(resolve("scripts/lib/pages-preview.css"), "utf8")),
  );
  const fixture = await readFile(resolve(allowed, "js/preview-fixtures.js"), "utf8");
  if (
    /csrf_token|query_key|otpauth_uri|recovery_codes|authorize_url|SUPABASE_|AUTH_SECRET/.test(
      fixture,
    )
  )
    throw Error("Forbidden credential/data field in Preview fixtures");
  await writeFile(resolve(allowed, "index.html"), html);
  await writeFile(resolve(allowed, ".nojekyll"), "");
  return allowed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildPagesPreview(resolve(".wrangler/pages-preview"));
  process.stdout.write("Pages preview artifact ready; Production source unchanged\n");
}
