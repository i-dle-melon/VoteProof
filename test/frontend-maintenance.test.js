import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyHooks } from "../scripts/check-frontend-hooks.mjs";
import { previewAllowed, PREVIEW } from "../public/js/preview.js";
const html = await readFile("public/index.html", "utf8");
const hooks = JSON.parse(await readFile("test/fixtures/frontend-dom-hooks.json", "utf8"));
const dataHooks = JSON.parse(await readFile("test/fixtures/frontend-data-hooks.json", "utf8"));
test("operator HTML retains every required hook and security attribute", () => assert.ok(verifyHooks(html, hooks, dataHooks) > 300));
test("renaming anonymous navigation or password data hook is rejected", () => {
  assert.throws(() => verifyHooks(html.replace('data-view="home"', 'data-view="renamed"'), hooks, dataHooks));
  assert.throws(() => verifyHooks(html.replace('data-password=', 'data-renamed='), hooks, dataHooks));
});
for (const id of ["campaign", "submission-gate-message", "proof-images", "login-google", "login-form", "member-id", "security-step-form", "admin-panel", "admin-ui-copy"]) {
  test("deleting critical HTML hook is rejected: " + id, () => assert.throws(() => verifyHooks(html.replace(`id="${id}"`, 'id="accidentally-renamed"'), hooks)));
}
test("copy edits do not require changing JS or the hook manifest", () => assert.ok(verifyHooks(html.replace("每一票，都是應援的力量。", "我們的新中文標題。"), hooks) > 300));
test("preview requires both the generated marker and an isolated host", () => {
  assert.equal(PREVIEW, false);
  for (const host of ["voteproof.i-dle-melon.workers.dev", "evil.github.io.attacker.example", "github.io", "example.com"]) assert.equal(previewAllowed("isolated", host), false);
  assert.equal(previewAllowed("isolated", "i-dle-melon.github.io"), true);
  assert.equal(previewAllowed(undefined, "i-dle-melon.github.io"), false);
  assert.equal(previewAllowed("isolated", "localhost"), true);
  assert.equal(previewAllowed("isolated", "localhost", "file:"), false);
});
test("production cannot read preview fixture data even through direct import", async () => {
  const { fixtureResponse } = await import("../public/js/preview-fixtures.js");
  assert.equal(fixtureResponse("/api/auth/me").status, 403);
});
test("workflows isolate automatic Pages from exact-commit manual Production deployment", async () => {
  const pages = await readFile(".github/workflows/pages-preview.yml", "utf8"), production = await readFile(".github/workflows/production-deploy.yml", "utf8");
  assert.match(pages, /push:/); assert.match(pages, /\.wrangler\/pages-preview/);
  assert.doesNotMatch(pages, /CLOUDFLARE|wrangler deploy/);
  assert.match(production, /workflow_dispatch:/); assert.doesNotMatch(production, /^\s*(push|pull_request|schedule):/m);
  assert.match(production, /needs: validate/); assert.match(production, /approved_sha/);
  for (const gate of ["npm test", "test:frontend-unit", "test:frontend", "check-frontend-sensitive", "npm run check"]) assert.ok(production.includes(gate));
  assert.equal((production.match(/npx wrangler deploy/g) ?? []).length, 1);
  assert.doesNotMatch(production, /d1 (execute|migrations)|r2 (object|bucket)|secret (put|delete)|submissions\/update/);
});
