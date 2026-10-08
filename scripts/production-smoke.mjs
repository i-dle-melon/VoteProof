// Live HTTP checks only: no uploads, credentials, or Dashboard changes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const origin = "https://voteproof.i-dle-melon.workers.dev";
const results = [];
async function check(name, action) {
  try { await action(); results.push({ test: name, result: "PASS" }); }
  catch { results.push({ test: name, result: "FAIL" }); }
}
async function request(path, status, code, body) {
  const response = await fetch(origin + path, {
    ...(body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  if (path.includes("uploads")) assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  if (code) {
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, code);
    assert.deepEqual(Object.keys(payload).sort(), ["error", "ok"]);
  } else assert.equal(payload.ok, true);
  return payload;
}
await check("B1 health", async () => {
  const payload = await request("/api/health", 200);
  assert.equal(payload.data.status, "ok");
});
await check("B1 campaigns", async () => {
  assert.ok(Array.isArray((await request("/api/campaigns", 200)).data.campaigns));
});
await check("B1 leaderboards", async () => {
  assert.ok(Array.isArray((await request("/api/leaderboards", 200)).data.leaderboards));
});
await check("B1 homepage bytes", async () => {
  const response = await fetch(origin + "/", { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  // Git deployment uses the committed bytes, while Windows checkout may use CRLF.
  const committed = execFileSync("git", ["show", "HEAD:public/index.html"], { encoding: "utf8" });
  assert.equal(await response.text(), committed);
});
await check("B1 unknown API", () => request("/api/not-a-real-endpoint", 404, "NOT_FOUND"));
for (const path of ["prepare", "complete"]) {
  await check(`${path} GET 405`, () => request(`/api/uploads/${path}`, 405, "METHOD_NOT_ALLOWED"));
}
const file = { name: "acceptance.png", type: "image/png", size: 67 };
for (const [name, body, status, code] of [
  ["prepare missing Turnstile", { files: [file] }, 400, "TURNSTILE_REQUIRED"],
  ["prepare invalid Turnstile", { turnstile_token: randomUUID(), files: [file] }, 403, "TURNSTILE_INVALID"],
  ["prepare too many files", { turnstile_token: randomUUID(), files: Array(6).fill(file) }, 400, "TOO_MANY_FILES"],
  ["prepare oversized metadata", { turnstile_token: randomUUID(), files: [file], padding: "x".repeat(16 * 1024) }, 413, "INVALID_UPLOAD_REQUEST"],
  ["prepare unsupported MIME", { turnstile_token: randomUUID(), files: [{ ...file, type: "image/svg+xml" }] }, 400, "UNSUPPORTED_FILE_TYPE"],
]) await check(name, () => request("/api/uploads/prepare", status, code, body));
const session = randomUUID();
const date = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
const key = `proofs/staging/${date}/${session}/${randomUUID()}.png`;
await check("complete nonexistent key", () => request("/api/uploads/complete", 400, "UPLOAD_INCOMPLETE", {
  session_id: session, keys: [key],
}));
await check("complete different session", () => request("/api/uploads/complete", 400, "INVALID_UPLOAD_REQUEST", {
  session_id: randomUUID(), keys: [key],
}));
await check("complete traversal", () => request("/api/uploads/complete", 400, "INVALID_UPLOAD_REQUEST", {
  session_id: session, keys: [`proofs/staging/${date}/${session}/../outside.png`],
}));
console.table(results); // Never print response bodies, signed URLs or credentials.
console.log(`${results.filter(r => r.result === "PASS").length}/${results.length} live HTTP checks passed`);
if (results.some(r => r.result === "FAIL")) process.exitCode = 1;
