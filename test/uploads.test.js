import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { completeUpload } from "../src/api/uploads.js";
import worker from "../src/index.js";
import { verifyTurnstile } from "../src/api/turnstile.js";
import { validatePrepare, UPLOAD_LIMITS } from "../src/api/upload-validation.js";
import { AwsV4Signer } from "aws4fetch";

// Ephemeral synthetic values are generated at runtime; no real secrets or token fixtures.
const session = "550e8400-e29b-41d4-a716-446655440000";
const fileId = "2cb3b938-1a34-4515-9bf2-a616be0f4bf0";
const key = `proofs/staging/2026/10/08/${session}/${fileId}.png`;
const token = () => randomBytes(24).toString("hex");
const prepareBody = () => ({ turnstile_token: token(), files: [{ name: "private-name@example.invalid.png", type: "image/png", size: 123 }] });
const post = (body, contentType = "application/json", path = "/api/uploads/complete") => new Request("https://voteproof.example" + path, {
  method: "POST", headers: { "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const prepareRequest = (body, contentType) => post(body, contentType, "/api/uploads/prepare");
// Lightweight D1 contract fixture; real D1 atomicity is covered in integration tests.
function uploadDb() {
  let state, files = [];
  return {
    prepare(sql) { let args=[]; const statement={
      bind(...values) { args=values; return statement; },
      async first() { return sql.includes('submission_settings') ? { submissions_enabled:1, submissions_message:null, version:0 } : state; },
      async all() { return { results:files }; },
      async run() { return { success:true }; },
      apply() {
        if (sql.startsWith('INSERT INTO completed_uploads ')) state={session_id:args[0],manifest_hash:args[1],expires_at:args[3],consumed_case_id:null};
        if (sql.includes('INSERT INTO completed_upload_files')) files.push({key:args[1],type:args[2],size:args[3],etag:args[4]});
        return {success:true};
      }
    }; return statement; },
    async batch(statements) { return statements.map(s=>s.apply()); }
  };
}
const configuredEnv = () => ({
  DB: uploadDb(),
  R2_ACCOUNT_ID: randomBytes(16).toString("hex"), R2_BUCKET_NAME: "synthetic-test-bucket",
  R2_ACCESS_KEY_ID: randomBytes(16).toString("hex"), R2_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
  TURNSTILE_SECRET_KEY: token(),
});
const completeBody = () => ({ session_id: session, keys: [key] });
const head = () => ({ size: 123, httpMetadata: { contentType: "image/png" }, etag: "opaque-etag" });
function bucket(value = head()) {
  const deleted = [], inspected = [];
  return { deleted, inspected, async head(k) { inspected.push(k); return value; }, async delete(k) { deleted.push(k); } };
}
async function errorResponse(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.deepEqual(Object.keys(result).sort(), ["error", "ok"]);
}

for (const [label, change, code] of [
  ["missing Turnstile", b => delete b.turnstile_token, "TURNSTILE_REQUIRED"],
  ["blank Turnstile", b => b.turnstile_token = "  ", "TURNSTILE_REQUIRED"],
  ["missing files", b => delete b.files, "INVALID_UPLOAD_REQUEST"],
  ["zero files", b => b.files = [], "INVALID_UPLOAD_REQUEST"],
  ["more than five files", b => b.files = Array(6).fill(b.files[0]), "TOO_MANY_FILES"],
  ["zero byte file", b => b.files[0].size = 0, "INVALID_UPLOAD_REQUEST"],
  ["negative size", b => b.files[0].size = -1, "INVALID_UPLOAD_REQUEST"],
  ["numeric string size", b => b.files[0].size = "123", "INVALID_UPLOAD_REQUEST"],
  ["fractional size", b => b.files[0].size = 1.5, "INVALID_UPLOAD_REQUEST"],
  ["oversize file", b => b.files[0].size = UPLOAD_LIMITS.maxFileBytes + 1, "FILE_TOO_LARGE"],
  ["blank filename", b => b.files[0].name = "  ", "INVALID_UPLOAD_REQUEST"],
  ["filename with control characters", b => b.files[0].name = "x\u0000.png", "INVALID_UPLOAD_REQUEST"],
]) {
  test(`prepare metadata rejects ${label}`, () => {
    const body = prepareBody(); change(body);
    assert.throws(() => validatePrepare(body), error => error.code === code && error.status === 400);
  });
}
for (const mime of ["image/svg+xml", "image/gif", "image/heic", "image/heif", "application/x-msdownload", "application/octet-stream", "", "IMAGE/PNG"]) {
  test(`prepare rejects MIME ${JSON.stringify(mime)}`, () => {
    const body = prepareBody(); body.files[0].type = mime;
    assert.throws(() => validatePrepare(body), error => error.code === "UNSUPPORTED_FILE_TYPE");
  });
}
test("prepare accepts five files exactly at the 25 MiB batch limit and drops filenames", () => {
  const body = prepareBody(); body.files = Array.from({ length: 5 }, () => ({ name: "pii.png", size: UPLOAD_LIMITS.maxFileBytes, type: "image/png" }));
  const result = validatePrepare(body);
  assert.equal(result.files.reduce((sum, f) => sum + f.size, 0), UPLOAD_LIMITS.maxBatchBytes);
  assert.equal(JSON.stringify(result.files).includes("pii"), false);
});

test("Turnstile missing secret returns 503", async () => {
  await assert.rejects(() => verifyTurnstile(post({}), {}, token()), e => e.status === 503 && e.code === "TURNSTILE_NOT_CONFIGURED");
});
test("Turnstile always calls official Siteverify with secret, response and optional IP", async t => {
  const secret = token(), responseToken = token();
  t.mock.method(globalThis, "fetch", (url, options) => {
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(options.method, "POST");
    assert.equal(options.body.get("secret"), secret);
    assert.equal(options.body.get("response"), responseToken);
    assert.equal(options.body.get("remoteip"), "192.0.2.1");
    return Response.json({ success: true });
  });
  const request = post({}); request.headers.set("CF-Connecting-IP", "192.0.2.1");
  await verifyTurnstile(request, { TURNSTILE_SECRET_KEY: secret }, responseToken);
});
test("Turnstile success false returns 403", async t => {
  t.mock.method(globalThis, "fetch", () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }));
  await assert.rejects(() => verifyTurnstile(post({}), { TURNSTILE_SECRET_KEY: token() }, token()), e => e.status === 403 && e.code === "TURNSTILE_INVALID");
});
for (const [label, response] of [
  ["HTTP error", () => new Response("sensitive", { status: 500 })],
  ["invalid JSON", () => new Response("<html>sensitive</html>")],
  ["invalid schema", () => Response.json({ success: "true" })],
  ["fetch error", () => { throw Error("sensitive"); }],
]) {
  test(`Turnstile ${label} returns sanitized 502`, async t => {
    t.mock.method(globalThis, "fetch", response);
    await assert.rejects(() => verifyTurnstile(post({}), { TURNSTILE_SECRET_KEY: token() }, token()), e => e.status === 502 && e.code === "TURNSTILE_UPSTREAM_ERROR" && !e.message.includes("sensitive"));
  });
}
for (const stage of ["fetch", "body"]) {
  test(`Turnstile 5 second timeout covers ${stage}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    t.mock.method(globalThis, "fetch", async (_url, opts) => {
      signal = opts.signal;
      const wait = () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
      return stage === "fetch" ? wait() : { ok: true, json: wait };
    });
    const pending = verifyTurnstile(post({}), { TURNSTILE_SECRET_KEY: token() }, token());
    const assertion = assert.rejects(pending, e => e.status === 502 && e.code === "TURNSTILE_UPSTREAM_ERROR");
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(UPLOAD_LIMITS.turnstileTimeoutMs);
    await assertion; assert.equal(signal.aborted, true);
  });
}

for (const [label, body, contentType, code] of [
  ["invalid JSON", "{invalid", "application/json", "INVALID_JSON"],
  ["non JSON body", "x", "text/plain", "INVALID_JSON"],
  ["invalid UUID", { session_id: "bad", keys: [key] }, "application/json", "INVALID_UPLOAD_REQUEST"],
  ["empty keys", { session_id: session, keys: [] }, "application/json", "INVALID_UPLOAD_REQUEST"],
  ["more than five keys", { session_id: session, keys: Array(6).fill(key) }, "application/json", "TOO_MANY_FILES"],
  ["another session", { session_id: crypto.randomUUID(), keys: [key] }, "application/json", "INVALID_UPLOAD_REQUEST"],
  ["path traversal", { session_id: session, keys: [key.replace(fileId, "../" + fileId)] }, "application/json", "INVALID_UPLOAD_REQUEST"],
  ["encoded traversal", { session_id: session, keys: [key.replace(fileId, "%2e%2e%2f" + fileId)] }, "application/json", "INVALID_UPLOAD_REQUEST"],
  ["wrong prefix", { session_id: session, keys: [key.replace("staging", "private")] }, "application/json", "INVALID_UPLOAD_REQUEST"],
  ["duplicate keys", { session_id: session, keys: [key, key] }, "application/json", "INVALID_UPLOAD_REQUEST"],
  ["invalid calendar date", { session_id: session, keys: [key.replace("10/08", "02/30")] }, "application/json", "INVALID_UPLOAD_REQUEST"],
  ["newline key suffix", { session_id: session, keys: [key + "\n"] }, "application/json", "INVALID_UPLOAD_REQUEST"],
  ["newline UUID suffix", { session_id: session + "\n", keys: [key] }, "application/json", "INVALID_UPLOAD_REQUEST"],
]) {
  test(`complete rejects ${label} before R2 access`, async () => {
    const response = await completeUpload({}, null, post(body, contentType));
    await errorResponse(response, 400, code);
  });
}
test("complete missing binding returns 503", async () => {
  await errorResponse(await completeUpload({}, null, post(completeBody())), 503, "R2_UPLOAD_NOT_CONFIGURED");
});
test("complete missing object returns UPLOAD_INCOMPLETE", async () => {
  const proofs = bucket(null);
  await errorResponse(await completeUpload({ DB: uploadDb(), PROOFS_BUCKET: proofs }, null, post(completeBody())), 400, "UPLOAD_INCOMPLETE");
  assert.deepEqual(proofs.inspected, [key]); assert.deepEqual(proofs.deleted, []);
});
for (const [label, change] of [
  ["oversize object", o => o.size = UPLOAD_LIMITS.maxFileBytes + 1],
  ["zero byte object", o => o.size = 0],
  ["invalid actual MIME", o => o.httpMetadata.contentType = "image/svg+xml"],
  ["missing actual MIME", o => o.httpMetadata = {}],
  ["MIME does not match extension", o => o.httpMetadata.contentType = "image/jpeg"],
]) {
  test(`complete deletes and rejects ${label}`, async () => {
    const object = head(); change(object); const proofs = bucket(object);
    await errorResponse(await completeUpload({ DB: uploadDb(), PROOFS_BUCKET: proofs }, null, post(completeBody())), 400, "UPLOAD_VALIDATION_FAILED");
    assert.deepEqual(proofs.deleted, [key]);
  });
}
test("complete uses actual HEAD size/type and returns no public URL or client metadata", async () => {
  const proofs = bucket(); const body = completeBody(); body.size = 999; body.type = "bad";
  const response = await completeUpload({ DB: uploadDb(), PROOFS_BUCKET: proofs }, null, post(body));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, data: { session_id: session, files: [{ key, size: 123, type: "image/png", etag: "opaque-etag" }] } });
  assert.deepEqual(proofs.inspected, [key]);
});
test("complete accepts all three allowed MIME/extension pairs at the exact file size limit", async () => {
  for (const [type, extension] of [["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"]]) {
    const actualKey = key.replace(/png$/, extension);
    const proofs = bucket({ size: UPLOAD_LIMITS.maxFileBytes, httpMetadata: { contentType: type }, etag: "etag" });
    const response = await completeUpload({ DB: uploadDb(), PROOFS_BUCKET: proofs }, null, post({ session_id: session, keys: [actualKey] }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.files[0].type, type);
    assert.deepEqual(proofs.deleted, []);
  }
});
test("mixed invalid/missing batch inspects all objects, deletes invalid file and never succeeds", async () => {
  const second = key.replace(fileId, crypto.randomUUID()), deleted = [], inspected = [];
  const proofs = { async head(k) { inspected.push(k); return k === key ? null : { ...head(), size: UPLOAD_LIMITS.maxFileBytes + 1 }; }, async delete(k) { deleted.push(k); } };
  await errorResponse(await completeUpload({ DB: uploadDb(), PROOFS_BUCKET: proofs }, null, post({ session_id: session, keys: [key, second] })), 400, "UPLOAD_VALIDATION_FAILED");
  assert.deepEqual(inspected, [key, second]); assert.deepEqual(deleted, [second]);
});
for (const operation of ["head", "delete"]) {
  test(`complete handles R2 ${operation} failure without claiming cleanup or success`, async () => {
    const proofs = bucket({ ...head(), size: 0 }); proofs[operation] = async () => { throw Error("sensitive"); };
    await errorResponse(await completeUpload({ DB: uploadDb(), PROOFS_BUCKET: proofs }, null, post(completeBody())), 502, "R2_UPLOAD_ERROR");
  });
}
for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
  test(`complete HTTP ${method} returns 405 with Allow POST`, async () => {
    const response = await worker.fetch(new Request("https://voteproof.example/api/uploads/complete", { method }), {});
    assert.equal(response.headers.get("allow"), "POST");
    await errorResponse(response, 405, "METHOD_NOT_ALLOWED");
  });
}
test("complete HTTP POST is routed and unknown upload path retains 404", async () => {
  const response = await worker.fetch(post(completeBody()), { DB: uploadDb(), PROOFS_BUCKET: bucket() });
  assert.equal(response.status, 200);
  await errorResponse(await worker.fetch(new Request("https://voteproof.example/api/uploads/not-found"), {}), 404, "NOT_FOUND");
});
test("metadata body limit applies even without Content-Length", async () => {
  const response = await completeUpload({}, null, post({ ...completeBody(), padding: "x".repeat(UPLOAD_LIMITS.maxJsonBytes) }));
  await errorResponse(response, 413, "INVALID_UPLOAD_REQUEST");
});

for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
  test(`prepare HTTP ${method} returns 405 with Allow POST`, async () => {
    const response = await worker.fetch(new Request("https://voteproof.example/api/uploads/prepare", { method }), {});
    assert.equal(response.headers.get("allow"), "POST");
    await errorResponse(response, 405, "METHOD_NOT_ALLOWED");
  });
}
for (const [label, body, contentType, code] of [
  ["invalid JSON", "{bad", "application/json", "INVALID_JSON"],
  ["non-JSON body", "x", "text/plain", "INVALID_JSON"],
  ["array body", [], "application/json", "INVALID_UPLOAD_REQUEST"],
  ["missing token", { files: [] }, "application/json", "TURNSTILE_REQUIRED"],
  ["missing files", { turnstile_token: token() }, "application/json", "INVALID_UPLOAD_REQUEST"],
  ["zero files", { turnstile_token: token(), files: [] }, "application/json", "INVALID_UPLOAD_REQUEST"],
]) {
  test(`prepare HTTP rejects ${label} before Siteverify`, async t => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("Siteverify must not be called"); });
    await errorResponse(await worker.fetch(prepareRequest(body, contentType), configuredEnv()), 400, code);
  });
}
for (const [label, change, code] of [
  ["too many files", b => b.files = Array(6).fill(b.files[0]), "TOO_MANY_FILES"],
  ["zero-byte file", b => b.files[0].size = 0, "INVALID_UPLOAD_REQUEST"],
  ["oversize file", b => b.files[0].size = UPLOAD_LIMITS.maxFileBytes + 1, "FILE_TOO_LARGE"],
  ["unsupported MIME", b => b.files[0].type = "image/svg+xml", "UNSUPPORTED_FILE_TYPE"],
]) {
  test(`prepare HTTP rejects ${label} before Siteverify`, async t => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("Siteverify must not be called"); });
    const body = prepareBody(); change(body);
    await errorResponse(await worker.fetch(prepareRequest(body), configuredEnv()), 400, code);
  });
}
for (const name of ["R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
  test(`prepare missing ${name} returns sanitized 503 without consuming token`, async t => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("Siteverify must not be called"); });
    const env = configuredEnv(); delete env[name];
    const response = await worker.fetch(prepareRequest(prepareBody()), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: { code: "R2_UPLOAD_NOT_CONFIGURED", message: "Upload service is not configured" } });
  });
}
for (const field of ["R2_ACCOUNT_ID", "R2_BUCKET_NAME"]) {
  test(`prepare invalid ${field} cannot inject host/path`, async () => {
    const env = configuredEnv(); env[field] = "host.invalid/?sensitive";
    await errorResponse(await worker.fetch(prepareRequest(prepareBody()), env), 503, "R2_UPLOAD_NOT_CONFIGURED");
  });
}
test("prepare missing Turnstile config is 503, never bypassed", async t => {
  const env = configuredEnv(); delete env.TURNSTILE_SECRET_KEY;
  t.mock.method(globalThis, "fetch", () => { assert.fail("Siteverify must not be called without secret"); });
  await errorResponse(await worker.fetch(prepareRequest(prepareBody()), env), 503, "TURNSTILE_NOT_CONFIGURED");
});
test("prepare Siteverify failure returns 403 and no signed URLs", async t => {
  t.mock.method(globalThis, "fetch", () => Response.json({ success: false }));
  await errorResponse(await worker.fetch(prepareRequest(prepareBody()), configuredEnv()), 403, "TURNSTILE_INVALID");
});
test("prepare Siteverify upstream error is JSON 502", async t => {
  t.mock.method(globalThis, "fetch", () => new Response("sensitive HTML", { status: 502 }));
  await errorResponse(await worker.fetch(prepareRequest(prepareBody()), configuredEnv()), 502, "TURNSTILE_UPSTREAM_ERROR");
});

test("prepare produces private 300 second PUT URLs, fresh UUIDs and no PII or secret leakage", async t => {
  const env = configuredEnv(), body = prepareBody();
  body.key = "client-chosen"; body.files[0].key = "client-chosen";
  body.files.push({ name: "email-member-name.jpg", type: "image/jpeg", size: 456 }, { name: "player.webp", type: "image/webp", size: 789 });
  let calls = 0;
  t.mock.method(globalThis, "fetch", (url, options) => {
    calls++;
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(options.body.get("secret"), env.TURNSTILE_SECRET_KEY);
    assert.equal(options.body.get("response"), body.turnstile_token);
    return Response.json({ success: true });
  });
  for (const method of ["log", "warn", "error"]) t.mock.method(console, method, () => { assert.fail("Must not log tokens, signatures or credentials"); });
  const response = await worker.fetch(prepareRequest(body), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(calls, 1);
  assert.match(result.data.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.data.expires_in, 300);
  assert.equal(result.data.uploads.length, 3);
  assert.equal(new Set(result.data.uploads.map(u => u.key)).size, 3);
  assert.deepEqual(Object.keys(result.data).sort(), ["expires_in", "session_id", "uploads"]);
  for (let i = 0; i < result.data.uploads.length; i++) {
    const upload = result.data.uploads[i], type = body.files[i].type;
    assert.deepEqual(Object.keys(upload).sort(), ["headers", "key", "method", "upload_url"]);
    assert.equal(upload.method, "PUT");
    assert.deepEqual(upload.headers, { "Content-Type": type });
    assert.match(upload.key, new RegExp("^proofs/staging/\\d{4}/\\d{2}/\\d{2}/" + result.data.session_id + "/[0-9a-f-]{36}\\.(png|jpg|webp)$"));
    assert.equal(upload.key.includes(body.files[i].name), false);
    assert.equal(upload.key.includes("client-chosen"), false);
    const url = new URL(upload.upload_url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, env.R2_ACCOUNT_ID + ".r2.cloudflarestorage.com");
    assert.equal(url.pathname, "/" + env.R2_BUCKET_NAME + "/" + upload.key);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
    assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-type;host");
    assert.match(url.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
    // Approved unavoidable access-key identifier only in X-Amz-Credential.
    assert.equal(url.searchParams.get("X-Amz-Credential").split("/")[0], env.R2_ACCESS_KEY_ID);
    assert.equal(JSON.stringify(upload.headers).includes(env.R2_ACCESS_KEY_ID), false);
  }
  const text = JSON.stringify(result);
  for (const secret of [env.R2_SECRET_ACCESS_KEY, env.TURNSTILE_SECRET_KEY, body.turnstile_token]) assert.equal(text.includes(secret), false);
  assert.equal(text.includes("Authorization"), false);
});

test("presigned signature binds exact MIME, method and key; changing them invalidates it", async t => {
  const env = configuredEnv();
  t.mock.method(globalThis, "fetch", () => Response.json({ success: true }));
  const response = await worker.fetch(prepareRequest(prepareBody()), env);
  const upload = (await response.json()).data.uploads[0];
  const original = new URL(upload.upload_url), signature = original.searchParams.get("X-Amz-Signature");
  original.searchParams.delete("X-Amz-Signature");
  async function resign(type, method = "PUT", pathChanged = false) {
    const url = new URL(original);
    if (pathChanged) url.pathname += "-changed";
    const signer = new AwsV4Signer({
      url, method, headers: { "Content-Type": type }, accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto", signQuery: true,
      allHeaders: true, datetime: original.searchParams.get("X-Amz-Date"),
    });
    return (await signer.sign()).url.searchParams.get("X-Amz-Signature");
  }
  assert.equal(await resign("image/png"), signature);
  assert.notEqual(await resign("image/jpeg"), signature);
  assert.notEqual(await resign("image/png", "GET"), signature);
  assert.notEqual(await resign("image/png", "PUT", true), signature);
});
