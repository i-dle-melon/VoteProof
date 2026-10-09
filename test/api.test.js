import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { getLeaderboards as legacyLeaderboards } from "../src/lib/legacy-leaderboards.js";
// Historical B1 adapter contract tests remain; actual Worker uses D1 (B5C tests).
const historicalB1 = { fetch: (request, env) => legacyLeaderboards(env, new URL(request.url)) };

const request = (path, method = "GET") => new Request("https://voteproof.example" + path, { method });
const fixture = {
  ok: true,
  generated_at: "2026-10-08T00:00:00Z",
  internal_metadata: "must not be exposed",
  leaderboards: ["LB-SOLO", "LB-GROUP"].map(id => ({
    leaderboard_id: id, name: id, generated_at: "2026-10-08T00:00:00Z",
    internal_metadata: "must not be exposed",
    rankings: [{ rank: 1, member_id: "M-PUBLIC", nickname: "投票者", points: 10,
      proof_count: 1, reached_at: "2026-10-07T12:00:00Z", email: "private@example.invalid" }],
  })),
};
const upstreamEnv = { GOOGLE_PUBLIC_API_URL: "https://example.invalid/public?existing=value&action=wrong&id=old" };

async function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  return body;
}

test("health is exact, uncached and never accesses external services or secrets", async () => {
  const env = new Proxy({}, { get() { throw new Error("Unexpected binding access"); } });
  const response = await worker.fetch(request("/api/health"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), { ok: true, data: { service: "VoteProof API", status: "ok", version: "b1" } });
});

test("campaigns reads an empty D1 registry and retains its public response contract", async () => {
  const response = await worker.fetch(request("/api/campaigns"), { DB: { prepare() { return { bind() { return { all: async () => ({ results: [] }) }; } }; } } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, data: { campaigns: [] } });
});

for (const value of [undefined, "", "   "]) {
  test(`missing/empty upstream configuration returns 503 (${JSON.stringify(value)})`, async t => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("must not fetch"); });
    await assertError(await historicalB1.fetch(request("/api/leaderboards"), { GOOGLE_PUBLIC_API_URL: value }),
      503, "UPSTREAM_NOT_CONFIGURED");
  });
}

test("normalizes public leaderboard fields and uses a 30 second cache", async t => {
  t.mock.method(globalThis, "fetch", (url, options) => {
    assert.equal(url.searchParams.get("action"), "leaderboards");
    assert.equal(url.searchParams.get("existing"), "value");
    assert.equal(url.searchParams.has("id"), false);
    assert.equal(options.method, "GET");
    assert.equal(options.headers.accept, "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(fixture);
  });
  const response = await historicalB1.fetch(request("/api/leaderboards?ignored=private"), upstreamEnv);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=30");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.generated_at, fixture.generated_at);
  assert.equal(body.data.leaderboards.length, 2);
  assert.deepEqual(body.data.leaderboards[0].rankings[0], {
    rank: 1, member_id: "M-PUBLIC", nickname: "投票者", points: 10, proof_count: 1, reached_at: "2026-10-07T12:00:00Z",
  });
  assert.equal(JSON.stringify(body).includes("private@example.invalid"), false);
  assert.equal(JSON.stringify(body).includes("internal_metadata"), false);
});

test("id is safely forwarded and results are filtered even if upstream returns all boards", async t => {
  t.mock.method(globalThis, "fetch", url => {
    assert.equal(url.searchParams.get("id"), "LB-SOLO");
    assert.deepEqual(url.searchParams.getAll("action"), ["leaderboards"]);
    return Response.json(fixture);
  });
  const response = await historicalB1.fetch(request("/api/leaderboards?id=LB-SOLO"), upstreamEnv);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.leaderboards.map(b => b.leaderboard_id), ["LB-SOLO"]);
});

test("special characters in id cannot inject query parameters", async t => {
  const id = "LB-SOLO&action=private+ /?中文";
  t.mock.method(globalThis, "fetch", url => {
    assert.equal(url.searchParams.get("id"), id);
    assert.deepEqual(url.searchParams.getAll("action"), ["leaderboards"]);
    return Response.json(fixture);
  });
  const url = new URL("https://voteproof.example/api/leaderboards");
  url.searchParams.set("id", id);
  const response = await historicalB1.fetch(new Request(url), upstreamEnv);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.leaderboards, []);
});

test("accepts numeric strings and empty boards from the public API", async t => {
  const payload = structuredClone(fixture);
  Object.assign(payload.leaderboards[0].rankings[0], { rank: "1", points: "10", proof_count: "1", reached_at: null });
  payload.leaderboards[1].rankings = [];
  t.mock.method(globalThis, "fetch", () => Response.json(payload));
  const response = await historicalB1.fetch(request("/api/leaderboards"), upstreamEnv);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.leaderboards[0].rankings[0].points, 10);
  assert.deepEqual(body.data.leaderboards[1].rankings, []);
});

for (const [name, makeResponse] of [
  ["network failure", () => { throw new Error("Sensitive URL or credential"); }],
  ["upstream HTTP 500", () => new Response("Sensitive HTML", { status: 500 })],
  ["HTML login/error page", () => new Response("<html>Sensitive error</html>")],
  ["invalid JSON", () => new Response("{bad")],
  ["ok false", () => Response.json({ ok: false, message: "Sensitive error" })],
  ["missing array", () => Response.json({ ok: true, generated_at: "now" })],
  ["malformed board", () => Response.json({ ok: true, generated_at: "now", leaderboards: [null] })],
  ["malformed rank", () => { const p = structuredClone(fixture); p.leaderboards[0].rankings[0].rank = "bad"; return Response.json(p); }],
]) {
  test(`${name} returns a concise JSON 502 without upstream details`, async t => {
    t.mock.method(globalThis, "fetch", makeResponse);
    const body = await assertError(await historicalB1.fetch(request("/api/leaderboards"), upstreamEnv), 502, "UPSTREAM_ERROR");
    assert.equal(JSON.stringify(body).includes("Sensitive"), false);
  });
}

test("invalid configured URL returns sanitized 502", async () => {
  await assertError(await historicalB1.fetch(request("/api/leaderboards"), { GOOGLE_PUBLIC_API_URL: "not a URL" }), 502, "UPSTREAM_ERROR");
});

for (const stage of ["fetch", "response body"]) {
  test(`8 second timeout aborts stalled ${stage}`, async t => {
    let abortSignal;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
      abortSignal = signal;
      const stalled = () => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")), { once: true });
      });
      return stage === "fetch" ? stalled() : { ok: true, json: stalled };
    });
    const pending = historicalB1.fetch(request("/api/leaderboards"), upstreamEnv);
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(8000);
    await assertError(await pending, 502, "UPSTREAM_ERROR");
    assert.equal(abortSignal.aborted, true);
  });
}

test("unknown API returns exact 404 and never falls through to assets", async () => {
  const body = await assertError(await worker.fetch(request("/api/unknown"), {}), 404, "NOT_FOUND");
  assert.deepEqual(body, { ok: false, error: { code: "NOT_FOUND", message: "API endpoint not found" } });
  await assertError(await worker.fetch(request("/api/health/child"), {}), 404, "NOT_FOUND");
});

for (const path of ["/api/health", "/api/campaigns", "/api/leaderboards"]) {
  test(`POST ${path} is rejected without upstream access`, async () => {
    const response = await worker.fetch(request(path, "POST"), {});
    assert.equal(response.headers.get("allow"), "GET");
    await assertError(response, 405, "METHOD_NOT_ALLOWED");
  });
}

test("home and other static requests preserve the original Assets request and response", async () => {
  for (const path of ["/", "/index.html", "/favicon.ico", "/assets/style.css", "/apiary"]) {
    const originalRequest = request(path);
    const originalResponse = new Response(path === "/" ? readFileSync(new URL("../public/index.html", import.meta.url)) : "static", {
      headers: { "content-type": "text/html", "x-asset": "unchanged" },
    });
    const env = { ASSETS: { fetch(value) { assert.equal(value, originalRequest); return originalResponse; } } };
    assert.equal(await worker.fetch(originalRequest, env), originalResponse);
  }
});
