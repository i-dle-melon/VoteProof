// Local workerd integration only. Uses the real entrypoint and a local R2 binding.
// Upstream mocks are configured by the test harness, never by production code/env.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { unstable_splitSqlQuery } from "wrangler";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
});
const bindings = {
  R2_ACCOUNT_ID: randomBytes(16).toString("hex"),
  R2_BUCKET_NAME: "local-upload-test",
  R2_ACCESS_KEY_ID: randomBytes(16).toString("hex"),
  R2_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
  TURNSTILE_SECRET_KEY: randomBytes(32).toString("hex"),
};
let siteverifyCalls = 0;
let verificationSuccess = true;
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: "upload-smoke",
  modules: true, script: result.outputFiles[0].text, compatibilityDate: "2026-10-07",
  d1Databases: ["DB"], r2Buckets: ["PROOFS_BUCKET"], bindings,
  outboundService: async request => {
    assert.equal(request.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(request.method, "POST");
    const body = new URLSearchParams(await request.text());
    assert.equal(body.get("secret"), bindings.TURNSTILE_SECRET_KEY);
    assert.ok(body.get("response"));
    siteverifyCalls++;
    return Response.json({ success: verificationSuccess });
  },
}));

async function post(path, body, status, code) {
  const response = await runtime.dispatchFetch("https://voteproof.example" + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  if (code) assert.equal(payload.error.code, code);
  console.log(`${path} -> ${status}${code ? " " + code : ""}`);
  return payload;
}

try {
  const db = await runtime.getD1Database("DB"), migrations = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter(n => /^\d+_.+\.sql$/.test(n)).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(new URL(name, migrations), "utf8")).map(sql => db.prepare(sql)));
  }
  // Disposable fixture opts in; Production migration remains OFF.
  await db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
  const proofs = await runtime.getR2Bucket("PROOFS_BUCKET");
  const prepare = "/api/uploads/prepare";
  const prepareBody = {
    turnstile_token: randomBytes(24).toString("hex"),
    files: [{ name: "local-proof.png", type: "image/png", size: 3 }],
  };
  const prepareMethod = await runtime.dispatchFetch("https://voteproof.example" + prepare);
  assert.equal(prepareMethod.status, 405);
  assert.equal(prepareMethod.headers.get("allow"), "POST");
  console.log(`${prepare} GET -> 405`);
  await post(prepare, { files: prepareBody.files }, 400, "TURNSTILE_REQUIRED");
  assert.equal(siteverifyCalls, 0);
  verificationSuccess = false;
  await post(prepare, prepareBody, 403, "TURNSTILE_INVALID");
  verificationSuccess = true;
  const prepared = await post(prepare, prepareBody, 200);
  assert.equal(siteverifyCalls, 2);
  assert.equal(prepared.data.expires_in, 300);
  const session = prepared.data.session_id;
  const upload = prepared.data.uploads[0];
  const key = upload.key;
  assert.match(session, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(key.includes(`/${session}/`));
  assert.equal(key.includes(prepareBody.files[0].name), false);
  assert.equal(upload.method, "PUT");
  assert.deepEqual(upload.headers, { "Content-Type": "image/png" });
  const signedUrl = new URL(upload.upload_url);
  assert.equal(signedUrl.hostname, `${bindings.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  assert.equal(signedUrl.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(signedUrl.searchParams.get("X-Amz-SignedHeaders"), "content-type;host");
  assert.match(signedUrl.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(prepared).includes(bindings.R2_SECRET_ACCESS_KEY), false);
  assert.equal(JSON.stringify(prepared).includes(bindings.TURNSTILE_SECRET_KEY), false);
  assert.equal(JSON.stringify(prepared).includes(prepareBody.turnstile_token), false);
  const complete = "/api/uploads/complete";
  const body = { session_id: session, keys: [key] };
  const method = await runtime.dispatchFetch("https://voteproof.example" + complete);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "POST");
  console.log(`${complete} GET -> 405`);
  await post(complete, body, 400, "UPLOAD_INCOMPLETE");
  await proofs.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
  const success = await post(complete, body, 200);
  assert.equal(success.data.files[0].size, 3);
  assert.equal(success.data.files[0].type, "image/png");
  assert.ok(success.data.files[0].etag);
  assert.equal(JSON.stringify(success).includes("https://"), false);
  await proofs.put(key, new Uint8Array(5 * 1024 * 1024 + 1), { httpMetadata: { contentType: "image/png" } });
  await post(complete, body, 400, "UPLOAD_VALIDATION_FAILED");
  assert.equal(await proofs.head(key), null);
  await proofs.put(key, "invalid", { httpMetadata: { contentType: "image/svg+xml" } });
  await post(complete, body, 400, "UPLOAD_VALIDATION_FAILED");
  assert.equal(await proofs.head(key), null);
  await post(complete, { ...body, session_id: crypto.randomUUID() }, 400, "INVALID_UPLOAD_REQUEST");
  assert.equal(siteverifyCalls, 2); // complete does not consume/reuse a Turnstile token.
  console.log("Local workerd signing, Siteverify, R2 HEAD/deletion checks passed. No production resources were used.");
} finally {
  await runtime.dispose();
}
