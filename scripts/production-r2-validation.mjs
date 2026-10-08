// Explicit live acceptance fixtures. Writes only fresh UUID staging objects,
// checks the deployed HEAD/delete flow, then removes only those fixtures.
// Wrangler uses existing local authentication; no credentials in arguments/logs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const origin = "https://voteproof.i-dle-melon.workers.dev";
const bucket = "voteproof-proofs";
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const session = randomUUID();
const date = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
const keys = Array.from({ length: 4 }, () => `proofs/staging/${date}/${session}/${randomUUID()}.png`);
const folder = await mkdtemp(join(tmpdir(), "voteproof-b2-"));
const pngPath = join(folder, "fixture.png"), largePath = join(folder, "large.png"), svgPath = join(folder, "fixture.svg");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=", "base64");
const results = [];
const exec = promisify(execFile);
async function command(args) {
  return exec(process.execPath, [wrangler, ...args], {
    env: { ...process.env, CI: "true" }, timeout: 120000, maxBuffer: 1024 * 1024,
  });
}
async function put(key, file, type) {
  await command(["r2", "object", "put", `${bucket}/${key}`, "--remote", "--file", file, "--content-type", type]);
}
async function complete(selected, status, code) {
  const response = await fetch(origin + "/api/uploads/complete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: session, keys: selected }), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, status);
  const body = await response.json();
  if (code) { assert.equal(body.ok, false); assert.equal(body.error.code, code); }
  else {
    assert.equal(body.ok, true);
    assert.equal(body.data.files[0].size, png.length);
    assert.equal(body.data.files[0].type, "image/png");
    assert.equal(JSON.stringify(body).includes("https://"), false);
  }
}
async function check(name, action) {
  try { await action(); results.push({ test: name, result: "PASS" }); }
  catch { results.push({ test: name, result: "FAIL" }); }
}
try {
  await writeFile(pngPath, png);
  await writeFile(largePath, Buffer.alloc(5 * 1024 * 1024 + 1));
  await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await check("valid actual R2 object", async () => {
    await put(keys[0], pngPath, "image/png");
    await complete([keys[0]], 200);
  });
  await check("actual oversize rejected and deleted", async () => {
    await put(keys[1], largePath, "image/png");
    await complete([keys[1]], 400, "UPLOAD_VALIDATION_FAILED");
    await complete([keys[1]], 400, "UPLOAD_INCOMPLETE");
  });
  await check("actual unsupported MIME rejected and deleted", async () => {
    await put(keys[2], svgPath, "image/svg+xml");
    await complete([keys[2]], 400, "UPLOAD_VALIDATION_FAILED");
    await complete([keys[2]], 400, "UPLOAD_INCOMPLETE");
  });
  await check("mixed valid and missing cannot succeed", () => complete([keys[0], keys[3]], 400, "UPLOAD_INCOMPLETE"));
  await check("mixed valid and invalid cannot succeed; invalid deleted", async () => {
    await put(keys[2], svgPath, "image/svg+xml");
    await complete([keys[0], keys[2]], 400, "UPLOAD_VALIDATION_FAILED");
    await complete([keys[2]], 400, "UPLOAD_INCOMPLETE");
  });
} finally {
  for (const key of keys) await check("cleanup generated staging fixture", () => command(["r2", "object", "delete", `${bucket}/${key}`, "--remote"]));
  assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
  assert.ok(basename(folder).startsWith("voteproof-b2-"));
  await rm(folder, { recursive: true, force: true }); // Verified own mkdtemp directory only.
}
console.table(results);
if (results.some(r => r.result === "FAIL")) process.exitCode = 1;
