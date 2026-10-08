// Disposable local workerd/D1/R2. Upstream mocking exists only in this harness.
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery } from "wrangler";

export async function localCaseRuntime({ emailService, turnstileService } = {}) {
  const emails = [];
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../../src/index.js", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
  const options = {
    name: "case-test", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-07",
    d1Databases: ["DB"], r2Buckets: ["PROOFS_BUCKET"],
    bindings: {
      R2_ACCOUNT_ID: randomBytes(16).toString("hex"), R2_BUCKET_NAME: "local-case-test",
      R2_ACCESS_KEY_ID: randomBytes(16).toString("hex"), R2_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
      TURNSTILE_SECRET_KEY: randomBytes(32).toString("hex"),
      CASE_QUERY_KEY_SECRET: randomBytes(32).toString("hex"),
      AUTH_SECRET: randomBytes(32).toString("hex"), AUTH_ORIGIN: "https://voteproof.example",
      AUTH_EMAIL_API_KEY: randomBytes(32).toString("hex"), AUTH_EMAIL_FROM: "login@example.test",
    },
    outboundService: async request => {
      if (request.url === "https://api.resend.com/emails") {
        const message = await request.json();
        emails.push({ email: message.to[0], code: message.text.match(/\d{8}/)?.[0] });
        return emailService ? emailService(message) : Response.json({ id: crypto.randomUUID() });
      }
      if (request.url !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") throw new Error("Unexpected test upstream");
      return turnstileService ? turnstileService() : Response.json({ success: true });
    },
  };
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  try {
    let db = await runtime.getD1Database("DB"), bucket = await runtime.getR2Bucket("PROOFS_BUCKET");
    const migrations = new URL("../../migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
      const migration = await readFile(new URL(name, migrations), "utf8");
      // Static checked-in schema only; no user input or SQL interpolation.
      // Wrangler's splitter preserves trigger BEGIN/END bodies and SQL quotes.
      await db.batch(unstable_splitSqlQuery(migration).map(sql => db.prepare(sql)));
    }
    const fetch = (path, method = "GET", body, headers = {}) => runtime.dispatchFetch("https://voteproof.example" + path, {
      method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    async function upload({ count = 1, completed = true } = {}) {
      const response = await fetch("/api/uploads/prepare", "POST", {
        turnstile_token: randomBytes(24).toString("hex"),
        files: Array.from({ length: count }, () => ({ name: "local.png", type: "image/png", size: 3 })),
      });
      if (response.status !== 200) throw new Error("Local prepare failed");
      const prepared = (await response.json()).data;
      const reference = { session_id: prepared.session_id, keys: prepared.uploads.map(file => file.key) };
      for (const key of reference.keys) await bucket.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
      if (completed) {
        const complete = await fetch("/api/uploads/complete", "POST", reference);
        if (complete.status !== 200) throw new Error("Local complete failed");
      }
      return reference;
    }
    const setQuerySecret = async secret => {
      options.bindings.CASE_QUERY_KEY_SECRET = secret;
      await runtime.setOptions(convertV4MiniflareOptions(options));
      db = await runtime.getD1Database("DB");
      bucket = await runtime.getR2Bucket("PROOFS_BUCKET");
    };
    const setAuthConfig = async config => {
      for (const [name, value] of Object.entries(config)) {
        if (value === undefined) delete options.bindings[name];
        else options.bindings[name] = value;
      }
      await runtime.setOptions(convertV4MiniflareOptions(options));
      db = await runtime.getD1Database("DB"); bucket = await runtime.getR2Bucket("PROOFS_BUCKET");
    };
    return { runtime, get db() { return db; }, get bucket() { return bucket; },
      fetch, upload, setQuerySecret, setAuthConfig, emails, get authSecret() { return options.bindings.AUTH_SECRET; }, querySecret: options.bindings.CASE_QUERY_KEY_SECRET };
  } catch (error) { await runtime.dispose(); throw error; }
}

export const guestBody = reference => ({ nickname: "測試訪客", player_id: "local-player", campaign_id: "LOCAL-TEST",
  vote_type: "Solo", vote_date: new Date().toISOString().slice(0, 10), upload_session: reference });
