import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildPagesPreview,
  removeElement,
  removeMatchingElements,
} from "../scripts/build-pages-preview.mjs";
test("balanced HTML helpers fail closed without removing neighboring layout", () => {
  assert.equal(
    removeElement(
      '<main><section id="private"><section>inside</section></section><p>next</p></main>',
      "private",
    ),
    "<main><p>next</p></main>",
  );
  assert.throws(() => removeElement("<main/>", "missing"));
  assert.equal(
    removeMatchingElements(
      '<nav><a href="#home">home</a><a href="#security">private</a></nav>',
      /^<a\b[^>]*href="#security"/,
    ),
    '<nav><a href="#home">home</a></nav>',
  );
});
test("isolated artifact shares actual UI sources and contains only build-only fixture transports", async () => {
  const before = await readFile("public/index.html", "utf8"),
    out = await buildPagesPreview(resolve(".wrangler/pages-preview"));
  const html = await readFile(resolve(out, "index.html"), "utf8");
  for (const view of ["home", "member", "security", "admin"])
    assert.match(html, new RegExp('id="view-' + view + '"'));
  assert.match(html, /UI PREVIEW · 非正式網站/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(html, /turnstile-site-key/);
  assert.doesNotMatch(before, /ui-preview-banner|data-preview-control|voteproof-preview/);
  for (const file of [
    "member.js",
    "admin.js",
    "admin-api.js",
    "ui-system.js",
    "tier-artwork.js",
    "admin-export.js",
    "export-format.js",
    "export-worker.js",
    "zip-store.js",
  ])
    assert.equal(
      await readFile(resolve(out, "js", file), "utf8"),
      await readFile(resolve("public/js", file), "utf8"),
    );
  assert.ok(
    (await readFile(resolve(out, "css/app.css"), "utf8")).startsWith(
      await readFile("public/css/app.css", "utf8"),
    ),
  );
  assert.ok((await readdir(resolve(out, "assets/tiers"))).length === 8);
  assert.match(await readFile(resolve(out, "js/member-api.js"), "utf8"), /Build-only transport/);
  assert.doesNotMatch(
    await readFile(resolve(out, "js/member-api.js"), "utf8"),
    /fetch\(|credentials:|csrf_token/,
  );
  const fixture = await readFile(resolve(out, "js/preview-fixtures.js"), "utf8");
  assert.doesNotMatch(
    fixture,
    /csrf_token|query_key|recovery_codes|otpauth_uri|authorize_url|SUPABASE_|AUTH_SECRET/,
  );
  assert.match(fixture, /PREVIEW-MEMBER/);
  assert.match(fixture, /method\s*!==\s*['"]GET['"]/);
  assert.match(await readFile("public/js/preview.js", "utf8"), /PREVIEW = false/);
  assert.doesNotMatch(
    await readFile("public/js/member-api.js", "utf8"),
    /exportSample|previewPicture/,
  );
  assert.match(await readFile(resolve(out, "js/member-api.js"), "utf8"), /exportSample/);
  const exports = await readFile(resolve(out, "js/preview-exports.js"), "utf8");
  assert.match(exports, /BUILD-ONLY/);
  assert.doesNotMatch(exports, /fetch\(|object_key|csrf_token|query_key|credentials|PROOFS_BUCKET/);
  await assert.rejects(readFile("public/js/preview-fixtures.js"));
  assert.equal(await readFile("public/index.html", "utf8"), before);
});
