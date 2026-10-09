// Real local Wrangler/workerd HTTP checks with a disposable public-API fixture.
// No production URL, credentials, or Cloudflare resources are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repository = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const homepage = await readFile(new URL("../public/index.html", import.meta.url));
const seenQueries = [];
const fixture = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  seenQueries.push(url.searchParams);
  const id = url.searchParams.get("id");
  if (id === "HTTP-ERROR") {
    response.writeHead(500).end("<html>Upstream failure</html>");
  } else if (id === "HTML-ERROR") {
    response.writeHead(200, { "content-type": "text/html" }).end("<html>Login required</html>");
  } else if (id === "TIMEOUT") {
    // Worker should abort before this upstream response is ready.
    const timer = setTimeout(() => response.end("late"), 12000);
    response.on("close", () => clearTimeout(timer));
  } else {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      ok: true, generated_at: "2026-10-08T00:00:00Z",
      leaderboards: ["LB-SOLO", "LB-GROUP"].filter(board => !id || board === id).map(board => ({
        leaderboard_id: board, name: board, generated_at: "2026-10-08T00:00:00Z",
        rankings: [{ rank: 1, member_id: "M-TEST", nickname: "測試", points: 10,
          proof_count: 1, reached_at: "2026-10-07T00:00:00Z" }],
      })),
    }));
  }
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");

async function freePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function withWorker(configured, check) {
  const port = await freePort();
  const persistTo = ".wrangler/b1-smoke-" + randomUUID();
  const migration = spawn(process.execPath, [wrangler, "d1", "migrations", "apply", "voteproof-cases", "--local", "--persist-to", persistTo], {
    cwd: repository, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
  });
  let migrationLog = "";
  migration.stdout.on("data", data => { migrationLog += data; }); migration.stderr.on("data", data => { migrationLog += data; });
  if ((await once(migration, "exit"))[0] !== 0) throw new Error("Local smoke migrations failed:\n" + migrationLog);
  const args = [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", "0", "--show-interactive-dev-session", "false", "--persist-to", persistTo];
  if (configured) args.push("--var", `GOOGLE_PUBLIC_API_URL:http://127.0.0.1:${fixture.address().port}/public`);
  const child = spawn(process.execPath, args, {
    cwd: repository, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
    windowsHide: true,
  });
  let log = "";
  child.stdout.on("data", data => { log += data; });
  child.stderr.on("data", data => { log += data; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error("Wrangler exited before readiness:\n" + log);
      try {
        const response = await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) });
        if (response.status === 200) { ready = true; break; }
      } catch { /* Server is still starting. */ }
      await delay(250);
    }
    if (!ready) throw new Error("Wrangler startup timed out:\n" + log);
    await check(base);
  } finally {
    if (process.platform === "win32") {
      // Terminate only this test process tree, including its workerd child.
      const cleanup = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      await once(cleanup, "exit");
    } else {
      child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "exit");
    }
  }
}

async function get(base, path, status) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, path);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8", path);
  const body = await response.json();
  console.log(`${path} -> ${status}`);
  return { body, response };
}

try {
  await withWorker(false, async base => {
    const health = await get(base, "/api/health", 200);
    assert.deepEqual(health.body, { ok: true, data: { service: "VoteProof API", status: "ok", version: "b1" } });
    assert.equal(health.response.headers.get("cache-control"), "no-store");
    const campaigns = await get(base, "/api/campaigns", 200);
    assert.deepEqual(campaigns.body, { ok: true, data: { campaigns: [] } });
    assert.equal(campaigns.response.headers.get("cache-control"), "no-store");
    const missing = await get(base, "/api/leaderboards", 200);
    assert.deepEqual(missing.body.data, { generated_at: null, leaderboards: [] });
    const unknown = await get(base, "/api/unknown", 404);
    assert.equal(unknown.body.error.code, "NOT_FOUND");
    for (const path of ["/", "/index.html"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), homepage);
      console.log(`${path} -> 200, homepage bytes unchanged`);
    }
    for (const path of ["css/app.css", "js/app.js", "js/api.js", "js/submission.js", "js/turnstile.js"]) {
      const response = await fetch(base + "/" + path);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL("../public/" + path, import.meta.url)));
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    }
    for (const path of ["/scripts/password-kdf-benchmark.mjs", "/docs/password-kdf-benchmark.json", "/.wrangler/state.sqlite"]) {
      assert.equal((await fetch(base + path)).status, 404, "Developer artifacts must not be assets");
    }
    assert.equal((await fetch(base + "/nonexistent-static-file.txt")).status, 404);
    console.log("Missing static asset -> Assets 404");
  });
  await withWorker(true, async base => {
    const all = await get(base, "/api/leaderboards", 200);
    assert.deepEqual(all.body.data, { generated_at: null, leaderboards: [] });
    assert.equal(all.response.headers.get("cache-control"), "public, max-age=15, must-revalidate");
    const solo = await get(base, "/api/leaderboards?id=LB-SOLO", 200);
    assert.deepEqual(solo.body.data.leaderboards, []);
    assert.equal(seenQueries.length, 0, "D1 Worker must never request legacy Google fixture");
  });
  console.log("Wrangler HTTP smoke checks passed. D1 empty-registry contract passed; Google fixture was never accessed.");
} finally {
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
