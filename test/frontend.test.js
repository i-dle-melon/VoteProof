globalThis.location={origin:'https://voteproof.example'};
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { Submission, normalizedMetadata, validateImages, queryInformation } from "../public/js/submission.js";
import { api, errorMessage, PublicError } from "../public/js/api.js";
import { localCaseRuntime, guestBody } from "../scripts/lib/local-case-runtime.mjs";

const metadata = () => ({ nickname: "  訪客  ", player_id: "  player  ", campaign_id: "LOCAL-TEST", vote_type: "Solo",
  vote_date: new Date().toISOString().slice(0, 10), note: "  備註  " });
const image = (extra = {}) => ({ name: "private-filename.png", type: "image/png", size: 100, arrayBuffer:async()=>new Uint8Array(100).buffer, ...extra });
function harness({ count = 2 } = {}) {
  const files = Array.from({ length: count }, () => image()), calls = [], puts = [], stages = [];
  const result = { case_id: "VP-20261009-" + "A".repeat(16), query_key: randomBytes(32).toString("base64url"), status: "pending" };
  let clock = Date.now(), tokens = 0;
  const prepared = () => { const session_id = randomUUID(); return { session_id, expires_in: 300,
    uploads: files.map(() => ({ key: `proofs/staging/2026/10/09/${session_id}/${randomUUID()}.png`, method: "PUT",
      upload_url: `https://voteproof.example/api/uploads/put/${randomUUID()}/${randomUUID()}`,
      headers: { 'Content-Type':'image/png','X-Upload-Grant':randomBytes(48).toString('base64url') } })) }; };
  const dependencies = { api: async (path, options) => {
    calls.push({ path, ...options });
    if (path.endsWith("prepare")) return prepared();
    if (path.endsWith("complete")) return { session_id: options.body.session_id, files: [] };
    return result;
  }, put: async (upload, file, progress) => { puts.push(upload); progress(1); },
  token: async () => { tokens++; return randomBytes(24).toString("base64url"); },
  progress: (stage) => stages.push(stage), now: () => clock };
  const flow = new Submission(dependencies);
  return { flow, dependencies, files, calls, puts, stages, result, get tokens() { return tokens; }, advance: (ms) => { clock += ms; } };
}
test("frontend normalizes metadata without rewriting backend business rules", () => {
  const normalized = normalizedMetadata(metadata());
  assert.equal("nickname" in normalized,false); assert.equal("player_id" in normalized,false); assert.equal(normalized.note, "備註");
  assert.equal(normalizedMetadata({ ...metadata(), note: " " }).note, null);
  for (const field of ["vote_type", "category", "solo_target"])
    assert.equal(field in normalizedMetadata({ ...metadata(), vote_type: "forged", category: "團體", solo_target: "forged" }), false);
});
for (const [label, extra] of [["empty campaign", {campaign_id:" "}], ["invalid campaign",{campaign_id:"../other"}],
  ["invalid date", { vote_date: "2026-02-30" }], ["long note", { note: "x".repeat(501) }]]) {
  test(`frontend input rejects ${label}`, () => assert.throws(() => normalizedMetadata({ ...metadata(), ...extra }), PublicError));
}
for (const [label, files, code] of [["empty", [], "IMAGES_REQUIRED"], ["too many", Array.from({ length: 6 }, () => image()), "TOO_MANY_FILES"],
  ["zero bytes", [image({ size: 0 })], "FILE_TOO_LARGE"], ["oversize", [image({ size: 5 * 1024 * 1024 + 1 })], "FILE_TOO_LARGE"],
  ["SVG", [image({ type: "image/svg+xml" })], "UNSUPPORTED_FILE_TYPE"], ["blank MIME", [image({ type: "" })], "UNSUPPORTED_FILE_TYPE"]]) {
  test(`frontend image validation: ${label}`, () => assert.throws(() => validateImages(files), { code }));
}
test("full prepare/PUT/complete/case flow uses metadata, exact MIME and safe names", async () => {
  const h = harness(); h.flow.start(metadata(), h.files); const response = await h.flow.attempt();
  assert.equal(response, h.result); assert.equal(h.flow.pending, false);
  assert.deepEqual(h.calls.map((c) => c.path), ["/api/uploads/prepare", "/api/uploads/complete", "/api/cases"]);
  assert.equal(h.puts.length, 2); assert.equal(h.tokens, 1);
  assert.equal(h.calls[0].body.files.some((f) => f.name.includes("private-filename")), false);
  assert.equal(h.calls[2].headers["Idempotency-Key"].length, 64);
  assert.equal(h.stages.at(-1).phase, "case");
});
test("case response lost: exact payload/key replay; no second prepare/PUT/complete", async () => {
  const h = harness(), original = h.dependencies.api; let fail = true;
  h.flow.api = async (...args) => { const response = await original(...args); if (args[0] === "/api/cases" && fail) { fail = false; throw new PublicError("NETWORK_ERROR"); } return response; };
  const input = metadata(); h.flow.start(input, h.files);
  await assert.rejects(h.flow.attempt(), { code: "NETWORK_ERROR" });
  input.nickname = "changed";
  assert.equal(h.flow.pending, true); await h.flow.attempt();
  const creates = h.calls.filter((c) => c.path === "/api/cases");
  assert.equal(creates.length, 2); assert.equal(creates[0].body === creates[1].body, true);
  assert.equal(creates[0].headers["Idempotency-Key"] === creates[1].headers["Idempotency-Key"], true);
  assert.equal("nickname" in JSON.parse(creates[1].body),false);
  assert.equal(h.puts.length, 2); assert.equal(h.calls.filter((c) => c.path.endsWith("prepare")).length, 1);
});
test("concurrent double attempt shares a single running submission", async () => {
  const h = harness(); h.flow.start(metadata(), h.files);
  const first = h.flow.attempt(), second = h.flow.attempt(); assert.equal(first === second, true);
  await Promise.all([first, second]); assert.equal(h.calls.filter((c) => c.path === "/api/cases").length, 1);
});
test("definitive pre-PUT validation rejection resumes the failed image with same unexpired grant", async () => {
  const h = harness(), original = h.dependencies.put; let calls = 0;
  h.flow.put = async (...args) => { calls++; if (calls === 2) throw new PublicError("UPLOAD_VALIDATION_FAILED",400); return original(...args); };
  h.flow.start(metadata(), h.files); await assert.rejects(h.flow.attempt(), { code: "UPLOAD_VALIDATION_FAILED" }); await h.flow.attempt();
  assert.equal(calls, 3); assert.equal(h.tokens, 1); assert.equal(h.calls.filter((c) => c.path.endsWith("prepare")).length, 1);
});
test('browser computes each digest once across grant expiry and technical retries',async()=>{
  const h=harness({count:1});let reads=0,failed=true;
  h.files[0].arrayBuffer=async()=>{reads++;return new Uint8Array(h.files[0].size).buffer;};
  const original=h.flow.put;h.flow.put=async(...args)=>{if(failed){failed=false;throw new PublicError('UPLOAD_VALIDATION_FAILED',400);}return original(...args);};
  h.flow.start(metadata(),h.files);await assert.rejects(h.flow.attempt());h.advance(301000);await h.flow.attempt();
  assert.equal(reads,1);assert.equal(h.calls.filter(c=>c.path.endsWith('prepare')).length,2);
  assert.ok(h.calls.filter(c=>c.path.endsWith('prepare')).every(c=>c.body.files[0].algorithm==='sha256'&&/^[0-9a-f]{64}$/.test(c.body.files[0].sha256)));
});
test('prepare cannot redirect an upload grant to another origin',async()=>{const h=harness({count:1}),original=h.flow.api;h.flow.api=async(...args)=>{const v=await original(...args);if(args[0].endsWith('prepare'))v.uploads[0].upload_url='https://evil.example/api/uploads/put/'+randomUUID()+'/'+randomUUID();return v;};h.flow.start(metadata(),h.files);await assert.rejects(h.flow.attempt(),{code:'SERVICE_UNAVAILABLE'});assert.equal(h.puts.length,0);});
test("expired pending PUT grants prepare again before the immutable case POST exists", async () => {
  const h = harness(), original = h.dependencies.put; let fail = true;
  h.flow.put = async (...args) => { if (fail) { fail = false; throw new PublicError("UPLOAD_VALIDATION_FAILED",400); } return original(...args); };
  h.flow.start(metadata(), h.files); await assert.rejects(h.flow.attempt()); h.advance(301000); await h.flow.attempt();
  assert.equal(h.tokens, 2); assert.equal(h.calls.filter((c) => c.path.endsWith("prepare")).length, 2);
});
test("prepare network retry consumes a fresh challenge token", async () => {
  const h = harness(), original = h.dependencies.api; let fail = true;
  h.flow.api = async (...args) => { if (args[0].endsWith("prepare") && fail) { fail = false; throw new PublicError("NETWORK_ERROR"); } return original(...args); };
  h.flow.start(metadata(), h.files); await assert.rejects(h.flow.attempt()); await h.flow.attempt(); assert.equal(h.tokens, 2);
});
test("complete network retry preserves upload reference and skips successful PUTs", async () => {
  const h = harness(), original = h.dependencies.api; let fail = true;
  h.flow.api = async (...args) => { const response = await original(...args); if (args[0].endsWith("complete") && fail) { fail = false; throw new PublicError("NETWORK_ERROR"); } return response; };
  h.flow.start(metadata(), h.files); await assert.rejects(h.flow.attempt()); await h.flow.attempt();
  assert.equal(h.puts.length, 2); const completes = h.calls.filter((c) => c.path.endsWith("complete"));
  assert.equal(JSON.stringify(completes[0].body) === JSON.stringify(completes[1].body), true);
});
test("no Turnstile token stops before prepare without a bypass", async () => {
  const h = harness(); h.flow.token = async () => ""; h.flow.start(metadata(), h.files);
  await assert.rejects(h.flow.attempt(), { code: "TURNSTILE_REQUIRED" }); assert.equal(h.calls.length, 0);
});
test("pending context cannot be replaced; explicit abandon creates a fresh key", async () => {
  const h = harness(), original = h.dependencies.api;
  h.flow.api = async (...args) => { const result = await original(...args); if (args[0] === "/api/cases") throw new PublicError("NETWORK_ERROR"); return result; };
  h.flow.start(metadata(), h.files); await assert.rejects(h.flow.attempt());
  assert.throws(() => h.flow.start(metadata(), h.files), { code: "SUBMISSION_PENDING" });
  h.flow.abandon(); h.flow.api = original; h.flow.start(metadata(), h.files); await h.flow.attempt();
  const creates = h.calls.filter((c) => c.path === "/api/cases");
  assert.equal(creates[0].headers["Idempotency-Key"] !== creates[1].headers["Idempotency-Key"], true);
});
test("API fetch omits auth cookies, browser cache and credential referrer", async (t) => {
  let options;
  t.mock.method(globalThis, "fetch", async (_path, opt) => { options = opt; return Response.json({ ok: true, data: {} }); });
  await api("/api/campaigns"); assert.equal(options.credentials, "omit"); assert.equal(options.cache, "no-store"); assert.equal(options.referrerPolicy, "no-referrer");
});
test("upstream exceptions/HTML/raw messages never become displayed API errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private upstream information"); });
  await assert.rejects(api("/api/campaigns"), { message: "NETWORK_ERROR" });
  assert.equal(errorMessage(new PublicError("unknown" )).includes("unknown"), false);
});
test("copy-all format contains exactly the guest query information", () => {
  const h = harness(); assert.equal(queryInformation(h.result).startsWith("VoteProof\n案件編號：VP-"), true);
  assert.equal(queryInformation(h.result).endsWith("查詢碼：" + h.result.query_key), true);
});
test("missing all optional auth settings fails closed while public and Guest case flow works", async () => {
  const h = await localCaseRuntime();
  try {
    // Upload origin is required independently of optional member login keys.
    await h.setAuthConfig({ AUTH_SECRET: undefined, AUTH_PASSWORD_PEPPER: undefined, AUTH_TOTP_ENCRYPTION_KEY: undefined });
    assert.equal((await h.fetch("/api/health")).status, 200); assert.equal((await h.fetch("/api/campaigns")).status, 200);
    assert.equal((await h.fetch("/api/leaderboards")).status, 200);
    const auth = await h.fetch("/api/auth/login", "POST", {}, { Origin: "https://voteproof.example", "X-VoteProof-Request": "1" });
    assert.equal(auth.status, 503); assert.equal((await auth.json()).error.code, "AUTH_NOT_CONFIGURED");
    assert.equal((await h.fetch("/api/auth/me")).status, 401);
    const reference = await h.upload();
    const created = await h.fetch("/api/cases", "POST", guestBody(reference), { "Idempotency-Key": randomUUID() });
    assert.equal(created.status, 201);
    const data = (await created.json()).data;
    assert.equal((await h.fetch(`/api/cases/${data.case_id}?key=${data.query_key}`)).status, 200);
  } finally { await h.runtime.dispose(); }
});
