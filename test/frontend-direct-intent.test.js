import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { Submission, BatchSubmission, directIntentPocEnabled } from "../public/js/submission.js";
import { PublicError } from "../public/js/api.js";
globalThis.location = { origin: "https://voteproof.example" };
const metadata = { campaign_id: "LOCAL-TEST", vote_type: "Solo", vote_date: "2026-10-15" };
const file = () => new File([new Uint8Array([1, 2, 3])], "fixture.png", { type: "image/png" });
function harness({
  direct = true,
  failPut = false,
  failCase = false,
  missing = false,
  badMode = false,
} = {}) {
  const calls = [],
    puts = [],
    result = {
      case_id: "VP-20261015-" + "A".repeat(16),
      query_key: randomBytes(32).toString("base64url"),
      status: "pending",
    };
  let putFailed = false,
    caseFailed = false,
    clock = Date.now();
  const deps = {
    directIntent: direct,
    now: () => clock,
    token: async () => "synthetic",
    put: async (u) => {
      puts.push(u);
      if (failPut && !putFailed) {
        putFailed = true;
        throw new PublicError("UPLOAD_REPREPARE_REQUIRED");
      }
    },
    api: async (path, options) => {
      calls.push({ path, ...options });
      if (path.endsWith("prepare")) {
        const s = randomUUID(),
          p = randomUUID();
        return {
          session_id: s,
          expires_in: 300,
          ...(!badMode ? { completion_mode: "direct" } : {}),
          uploads: [
            {
              key: `proofs/final/${s}/${p}.png`,
              method: "PUT",
              upload_url: `https://voteproof.example/api/uploads/put/${s}/${p}`,
              headers: {
                "Content-Type": "image/png",
                "X-Upload-Grant": randomBytes(48).toString("base64url"),
              },
            },
          ],
        };
      }
      if (path.endsWith("complete")) return {};
      if (!caseFailed && (failCase || missing)) {
        caseFailed = true;
        throw new PublicError(missing ? "UPLOAD_INCOMPLETE" : "NETWORK_ERROR");
      }
      return result;
    },
  };
  const flow = new Submission(deps);
  flow.start(metadata, [file()]);
  return { flow, calls, puts, result, deps, advance: (ms) => (clock += ms) };
}
test("POC selector is explicit and limited to local/reserved test hosts", () => {
  for (const hostname of ["localhost", "127.0.0.1", "[::1]", "voteproof.example"]) {
    assert.equal(directIntentPocEnabled({ hostname, search: "?upload-flow=direct" }), true);
    assert.equal(directIntentPocEnabled({ hostname, search: "" }), false);
  }
  for (const hostname of ["i-dle-melon.github.io", "voteproof.workers.dev", "evil.example"])
    assert.equal(directIntentPocEnabled({ hostname, search: "?upload-flow=direct" }), false);
});
test("direct frontend runs Prepare/PUT/Case without Complete", async () => {
  const h = harness();
  assert.deepEqual(await h.flow.attempt(), h.result);
  assert.deepEqual(
    h.calls.map((x) => x.path),
    ["/api/uploads/prepare", "/api/cases/direct"],
  );
  assert.equal(h.calls[0].body.completion_mode, "direct");
  assert.equal(h.puts.length, 1);
});
test("legacy remains default and calls Complete", async () => {
  const h = harness({ direct: false });
  await h.flow.attempt();
  assert.deepEqual(
    h.calls.map((x) => x.path),
    ["/api/uploads/prepare", "/api/uploads/complete", "/api/cases"],
  );
  assert.equal(h.calls[0].body.completion_mode, undefined);
});
test("ambiguous PUT continues to authoritative Case HEAD using same intent", async () => {
  const h = harness({ failPut: true });
  await h.flow.attempt();
  assert.equal(h.puts.length, 1);
  assert.equal(h.calls.length, 2);
});
test("lost Case ACK replays identical payload/key without another Prepare or PUT even after expiry", async () => {
  const h = harness({ failCase: true });
  await assert.rejects(h.flow.attempt(), { code: "NETWORK_ERROR" });
  h.advance(86400000);
  await h.flow.attempt();
  const cs = h.calls.filter((x) => x.path === "/api/cases/direct");
  assert.equal(cs.length, 2);
  assert.equal(cs[0].body, cs[1].body);
  assert.equal(cs[0].headers["Idempotency-Key"], cs[1].headers["Idempotency-Key"]);
  assert.equal(h.puts.length, 1);
  assert.equal(h.calls.filter((x) => x.path.endsWith("prepare")).length, 1);
});
test("missing object after ambiguous PUT retries PUT on same intent/key", async () => {
  const h = harness({ failPut: true, missing: true });
  await assert.rejects(h.flow.attempt(), { code: "UPLOAD_INCOMPLETE" });
  await h.flow.attempt();
  assert.equal(h.puts.length, 2);
  const cs = h.calls.filter((x) => x.path.endsWith("/direct"));
  assert.equal(cs[0].body, cs[1].body);
  assert.equal(cs[0].headers["Idempotency-Key"], cs[1].headers["Idempotency-Key"]);
  assert.equal(h.calls.filter((x) => x.path.endsWith("prepare")).length, 1);
});
test("mode mismatch stays fail closed on every retry", async () => {
  const h = harness({ badMode: true });
  for (let i = 0; i < 2; i++)
    await assert.rejects(h.flow.attempt(), { code: "SERVICE_UNAVAILABLE" });
  assert.equal(h.puts.length, 0);
  assert.equal(h.calls.length, 1);
});
test("direct Submission accepts exactly one proof; BatchSubmission sequences 20 independent cases", async () => {
  const h = harness();
  h.flow.abandon();
  assert.throws(() => h.flow.start(metadata, [file(), file()]), {
    code: "INVALID_UPLOAD_REFERENCE",
  });
  let n = 0,
    active = 0,
    maxActive = 0;
  const b = new BatchSubmission({
    ...h.deps,
    gate: async () => {},
    put: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
    },
    api: async (...args) => {
      const r = await h.deps.api(...args);
      if (args[0] === "/api/cases/direct") {
        n++;
        return { ...r, case_id: "VP-20261015-" + String.fromCharCode(65 + (n % 8)).repeat(16) };
      }
      return r;
    },
  });
  b.start(metadata, Array.from({ length: 20 }, file));
  assert.equal((await b.attempt()).succeeded, 20);
  assert.equal(n, 20);
  assert.equal(maxActive, 1);
  assert.equal(
    h.calls.some((x) => x.path.endsWith("complete")),
    false,
  );
});
