// Disposable local workerd/D1/R2. Upstream mocking exists only in this harness.
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { randomBytes, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery } from "wrangler";
import { authProviderFixture } from "./local-auth-provider.mjs";
import { emailHash } from "../../src/lib/auth-identity.js";

export async function localCaseRuntime({ turnstileService, seedCampaign = true, submissionsEnabled = true, migrationHook, migrationThrough, providerOptions, backupService, resourcePersistencePath, duplicateProcessorSecret } = {}) {
  const unexpectedUpstreams = [];
  const provider = authProviderFixture(providerOptions);
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../../src/index.js", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
  const options = {
    name: "case-test", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-07",
    ...(resourcePersistencePath ? { resourcePersistencePath } : {}),
    d1Databases: ["DB"], r2Buckets: ["PROOFS_BUCKET"],
    bindings: {
      ...provider.config,
      ...(duplicateProcessorSecret ? {DUPLICATE_PROCESSOR_SECRET:duplicateProcessorSecret,DUPLICATE_PROCESSOR_ENABLED:'true'} : {}),
      R2_ACCOUNT_ID: randomBytes(16).toString("hex"), R2_BUCKET_NAME: "local-case-test",
      R2_ACCESS_KEY_ID: randomBytes(16).toString("hex"), R2_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
      TURNSTILE_SECRET_KEY: randomBytes(32).toString("hex"),
      UPLOAD_GRANT_SECRET: randomBytes(32).toString('hex'),
      CASE_QUERY_KEY_SECRET: randomBytes(32).toString("hex"),
      AUTH_SECRET: randomBytes(32).toString("hex"), AUTH_ORIGIN: "https://voteproof.example",
      AUTH_TOTP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    },
    outboundService: async request => {
      if (backupService && ['oauth2.googleapis.com','www.googleapis.com'].includes(new URL(request.url).hostname)) {
        const mocked = await backupService(request); if (mocked) return mocked;
      }
      const response = await provider.fetch(request);
      if (response) return response;
      if (request.url !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
        unexpectedUpstreams.push(new URL(request.url).origin); throw new Error("Unexpected test upstream");
      }
      return turnstileService ? turnstileService() : Response.json({ success: true });
    },
  };
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  try {
    let db = await runtime.getD1Database("DB"), bucket = await runtime.getR2Bucket("PROOFS_BUCKET");
    const migrations = new URL("../../migrations/", import.meta.url);
    // Opt-in isolated connection runner only; normal tests stay disposable.
    if (resourcePersistencePath) await db.prepare('CREATE TABLE IF NOT EXISTS local_fixture_migrations(name TEXT PRIMARY KEY)').run();
    for (const name of (await readdir(migrations)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
      if (migrationThrough && name > migrationThrough) break;
      if (resourcePersistencePath && await db.prepare('SELECT name FROM local_fixture_migrations WHERE name=?').bind(name).first()) continue;
      const migration = await readFile(new URL(name, migrations), "utf8");
      // Static checked-in schema only; no user input or SQL interpolation.
      // Wrangler's splitter preserves trigger BEGIN/END bodies and SQL quotes.
      await db.batch(unstable_splitSqlQuery(migration).map(sql => db.prepare(sql)));
      if (resourcePersistencePath) await db.prepare('INSERT INTO local_fixture_migrations(name) VALUES(?)').bind(name).run();
      if (migrationHook) await migrationHook(db, name);
    }
    // Explicit fixture opt-in only. The migration/Production default stays OFF.
    if (submissionsEnabled) await db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
    // Explicit disposable fixture only. Migrations/Worker never seed Campaigns.
    async function campaign({ campaign_id = "LOCAL-TEST", name = "Local fixture", category = "local", start_at = "2000-01-01T00:00:00.000Z",
      end_at = "2100-01-01T00:00:00.000Z", campaign_timezone = "UTC", vote_start_date = "2000-01-01", vote_end_date = "2099-12-31",
      points_per_proof = 0, daily_limit = 0, status = "active" } = {}) {
      await db.prepare(`INSERT INTO campaigns (campaign_id, name, category, start_at, end_at, campaign_timezone,
        vote_start_date, vote_end_date, points_per_proof, daily_limit, status, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE campaign_id = ?)`)
        .bind(campaign_id, name, category, start_at, end_at, campaign_timezone, vote_start_date, vote_end_date,
          points_per_proof, daily_limit, status, new Date().toISOString(), new Date().toISOString(), campaign_id).run();
      return campaign_id;
    }
    if (seedCampaign) await campaign();
    const fetch = (path, method = "GET", body, headers = {}) => {
      // Incoming Node headers are lowercase. Normalize before adding defaults so
      // a forwarded JSON request does not become "application/json, application/json".
      const forwardedHeaders = new Headers(headers);
      if (body !== undefined && !forwardedHeaders.has("Content-Type")) forwardedHeaders.set("Content-Type", "application/json");
      return runtime.dispatchFetch("https://voteproof.example" + path, {
        method, redirect: "manual", headers: forwardedHeaders,
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      });
    };
    async function upload({ count = 1, completed = true } = {}) {
      const response = await fetch("/api/uploads/prepare", "POST", {
        turnstile_token: randomBytes(24).toString("hex"),
        files: Array.from({ length: count }, () => ({ name: "local.png", type: "image/png", size: 3, algorithm:'sha256',sha256:createHash('sha256').update(new Uint8Array([1,2,3])).digest('hex') })),
      });
      if (response.status !== 200) throw new Error("Local prepare failed");
      const prepared = (await response.json()).data;
      const reference = { session_id: prepared.session_id, keys: prepared.uploads.map(file => file.key) };
      for (const upload of prepared.uploads) await put(upload,new Uint8Array([1,2,3]));
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
    async function put(upload,bytes,headers={}) {
      const response=await runtime.dispatchFetch(upload.upload_url,{method:'PUT',headers:{Origin:options.bindings.AUTH_ORIGIN,...upload.headers,'Content-Length':String(bytes.length),...headers},body:bytes});
      if(response.status!==200)throw Error('Local verified PUT failed: '+(await response.json()).error.code);
      return response;
    }
    return { runtime, provider, put, emailHash: email => emailHash(options.bindings, email.trim().toLowerCase()), get db() { return db; }, get bucket() { return bucket; },
      fetch, upload, campaign, setQuerySecret, setAuthConfig, unexpectedUpstreams, get authSecret() { return options.bindings.AUTH_SECRET; }, get authConfig() { return { ...options.bindings }; }, querySecret: options.bindings.CASE_QUERY_KEY_SECRET };
  } catch (error) { await runtime.dispose(); throw error; }
}

export const guestBody = reference => ({ nickname: "測試訪客", player_id: "local-player", campaign_id: "LOCAL-TEST",
  vote_type: "Solo", vote_date: new Date().toISOString().slice(0, 10), upload_session: reference });
