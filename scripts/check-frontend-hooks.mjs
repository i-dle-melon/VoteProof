import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export function htmlHooks(html) {
  const nodes = new Map();
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const match of source.matchAll(/<([a-z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attributes = Object.fromEntries([...match[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
      .map(a => [a[1], a[2] ?? a[3] ?? a[4] ?? ""]));
    if (!attributes.id) continue;
    assert.equal(nodes.has(attributes.id), false, "Duplicate DOM id: " + attributes.id);
    nodes.set(attributes.id, { tag: match[1].toLowerCase(), attributes });
  }
  return nodes;
}
export function functionalDataHooks(html) {
  const hooks = new Map();
  for (const match of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<([a-z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attributes = [...match[2].matchAll(/(data-[\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)].map(a => [a[1], a[2] ?? a[3] ?? ""]);
    if (!attributes.length) continue;
    const signature = JSON.stringify([match[1].toLowerCase(), attributes.sort()]);
    hooks.set(signature, (hooks.get(signature) ?? 0) + 1);
  }
  return Object.fromEntries(hooks);
}
export function verifyHooks(html, required, dataHooks = {}) {
  const nodes = htmlHooks(html);
  for (const [id, expected] of Object.entries(required)) {
    const node = nodes.get(id); assert.ok(node, "Missing required DOM hook: " + id);
    assert.equal(node.tag, expected.tag, "Changed required DOM element: " + id);
    for (const [key, value] of Object.entries(expected.attributes)) assert.equal(node.attributes[key], value, "Changed functional attribute: " + id + "/" + key);
  }
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html), false, "Inline scripts are prohibited");
  assert.equal(/\bon\w+\s*=|javascript:/i.test(html.replace(/<!--[\s\S]*?-->/g, "")), false, "Inline event handlers are prohibited");
  assert.ok(html.includes('src="/js/app.js"'), "Keep the functional module import");
  assert.equal(/name="voteproof-preview"/.test(html), false, "Preview marker must never enter Production source");
  const currentData = functionalDataHooks(html);
  for (const [signature, minimum] of Object.entries(dataHooks)) assert.ok(currentData[signature] >= minimum, "Missing functional data-* hooks: " + signature);
  return nodes.size;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const html = await readFile("public/index.html", "utf8"), required = JSON.parse(await readFile("test/fixtures/frontend-dom-hooks.json", "utf8"));
  const dataHooks = JSON.parse(await readFile("test/fixtures/frontend-data-hooks.json", "utf8"));
  process.stdout.write(`Required frontend hooks PASS: ${verifyHooks(html, required, dataHooks)} IDs checked; data-* hooks protected\n`);
}
