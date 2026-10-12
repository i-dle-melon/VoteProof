// Review exactly the deployable assets, not ignored local credentials/logs.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { TIER_ARTWORK } from "../public/js/tier-artwork.js";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const paths = [];
async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, "Static asset symlinks are not allowed");
    const name = resolve(path, entry.name);
    if (entry.isDirectory()) await visit(name); else paths.push(name);
  }
}
await visit(root);
const expected = ["_headers", "css/app.css", "index.html", "js/api.js", "js/app.js", "js/submission.js", "js/turnstile.js", "js/admin.js", "js/admin-api.js", "js/admin-backup.js", "js/member-api.js", "js/member.js", "js/member-tier-progress.js", "js/qr.js", "js/tier-artwork.js", "js/preview.js", "js/preview-fixtures.js", "js/vendor/qrcode.js", ...Object.values(TIER_ARTWORK).map(art => art.src.slice(1))];
assert.deepEqual(paths.map((p) => relative(root, p).replaceAll("\\", "/")).sort(), expected.sort(), "Unexpected deployable static assets");
const forbidden = /AUTH_SECRET|AUTH_PASSWORD_PEPPER|AUTH_TOTP_ENCRYPTION_KEY|CASE_QUERY_KEY_SECRET|TURNSTILE_SECRET_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|MAIL_RELAY_(?:URL|SECRET)|SUPABASE_(?:URL|PUBLISHABLE_KEY|SECRET_KEY)|GMAIL_(?:CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|SENDER_EMAIL|SENDER_NAME)|X-Amz-(?:Signature|Credential)=|https:\/\/script\.google\.com\/macros\/s\/|-----BEGIN .*PRIVATE KEY-----|(?:C:\\Users\\|C:\/Users\/)/i;
let totalBytes = 0, gzipBytes = 0;
for (const path of paths) {
  const data = await readFile(path), source = data.toString("utf8");
  if (extname(path) === ".webp") {
    assert.equal(data.subarray(0, 4).toString(), "RIFF", "Invalid tier image");
    assert.equal(data.subarray(8, 12).toString(), "WEBP", "Invalid tier image");
  }
  assert.equal(forbidden.test(source), false, "Sensitive literal found in static asset");
  if (extname(path) === ".js") {
    assert.equal(/console\.|localStorage\.setItem\((?!"voteproof-theme")|sessionStorage|indexedDB/.test(source), false, "Browser module contains logging, credentials storage");
    if (!["member-api.js", "admin-api.js", "admin.js", "preview-fixtures.js"].includes(path.split(/[\\/]/).at(-1)))
      assert.equal(/\/api\/admin\//.test(source), false, "Admin requests must stay in the explicit authorized modules");
    if (!["member-api.js", "member.js", "admin-api.js", "admin.js", "preview-fixtures.js"].includes(path.split(/[\\/]/).at(-1)))
      assert.equal(/\/api\/(?:auth|me)\//.test(source), false, "Public module calls member endpoints");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const imported = resolve(dirname(path), match[1]);
      assert.equal(paths.includes(imported), true, "Browser module imports outside static assets");
    }
  }
  totalBytes += data.byteLength; gzipBytes += gzipSync(data).byteLength;
}
// Compilation check only, write:false: no new build pipeline or output files.
const bundle = await build({ entryPoints: [resolve(root, "js/app.js")], bundle: true, format: "esm", platform: "browser", write: false, minify: true });
assert.equal(forbidden.test(bundle.outputFiles[0].text), false);
console.log(JSON.stringify({ static_files: paths.length, static_bytes: totalBytes, per_file_gzip_bytes: gzipBytes,
  browser_js_minified_bytes: bundle.outputFiles[0].contents.length, browser_js_minified_gzip_bytes: gzipSync(bundle.outputFiles[0].contents).byteLength,
  sensitive_findings: 0, module_graph: "public, member and explicitly authorized admin", benchmark_database_fixture_files: "excluded" }, null, 2));
