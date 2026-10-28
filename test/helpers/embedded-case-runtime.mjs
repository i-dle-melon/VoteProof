// Network-free component harness. Real Worker handlers and SQLite schema/SQL;
// R2 and Turnstile are synthetic. This does not replace workerd/provider tests.
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { unstable_splitSqlQuery } from "wrangler";
import worker from "../../src/index.js";

export const origin = "https://voteproof.example";
export const image = new Uint8Array([1, 2, 3]);
export async function embeddedCaseRuntime({ migrationHook, migrationThrough } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const plain = (row) => (row ? Object.fromEntries(Object.entries(row)) : null);
  const db = {
    prepare(sql) {
      const statement = (values = []) => ({
        sql,
        values,
        bind: (...v) => statement(v),
        execute() {
          const s = sqlite.prepare(sql),
            returns = s.columns().length > 0;
          const results = returns ? s.all(...values).map(plain) : [];
          const changes = returns
            ? sqlite.prepare("SELECT changes() n").get().n
            : Number(s.run(...values).changes);
          return { success: true, results, meta: { changes } };
        },
        async all() {
          return this.execute();
        },
        async first(column) {
          const row = (await this.all()).results[0] ?? null;
          return column ? (row?.[column] ?? null) : row;
        },
        async run() {
          return this.all();
        },
      });
      return statement();
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        // Do not yield inside a transaction: independent requests cannot read
        // partial rows from a pending batch on this one SQLite connection.
        const result = statements.map(s => s.execute());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter((n) => /^\d+_.+\.sql$/.test(n)).sort()) {
    if (migrationThrough && name > migrationThrough) break;
    await db.batch(
      unstable_splitSqlQuery(await readFile(new URL(name, directory), "utf8")).map((s) =>
        db.prepare(s),
      ),
    );
    await migrationHook?.(db, name);
  }
  // Disposable current-schema fixture only. Missing migration still fails closed in real handlers.
  const historical=migrationThrough && migrationThrough<'0025_storage_cold_v1.sql';
  if(!historical)await db.prepare("UPDATE storage_capacity SET blocked=0,observed_at=0,trusted_until=CAST(strftime('%s','now') AS INTEGER)+86400 WHERE id=1").run();
  const objects = new Map();
  const bucket = {
    async put(key, body, options = {}) {
      if (options.onlyIf?.get("If-None-Match") === "*" && objects.has(key)) return null;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer()),
        digest = createHash("sha256").update(bytes).digest();
      if (options.sha256 && options.sha256 !== digest.toString("hex"))
        throw Error("Synthetic checksum mismatch");
      const object = {
        key,
        size: bytes.length,
        etag: digest.toString("hex"),
        httpMetadata: options.httpMetadata ?? {},
        customMetadata: options.customMetadata ?? {},
        checksums: { sha256: new Uint8Array(digest).buffer },
      };
      objects.set(key, { object, bytes });
      return object;
    },
    async head(key) {
      return objects.get(key)?.object ?? null;
    },
    async get(key) {
      const stored = objects.get(key);
      return stored
        ? {
            ...stored.object,
            body: new Blob([stored.bytes]).stream(),
            arrayBuffer: async () => stored.bytes.slice().buffer,
          }
        : null;
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  const env = {
    DB: db,
    PROOFS_BUCKET: bucket,
    AUTH_SECRET: randomBytes(32).toString("hex"),
    AUTH_ORIGIN: origin,
    UPLOAD_GRANT_SECRET: randomBytes(32).toString("hex"),
    CASE_QUERY_KEY_SECRET: randomBytes(32).toString("hex"),
    TURNSTILE_SECRET_KEY: "synthetic-component-test",
    DIRECT_INTENT_CASE_ENABLED: "true",
    GOOGLE_DRIVE_BACKUP_ENABLED: "true",
    DRIVE_BACKUP_TRANSPORT: "apps_script_pull",
    DRIVE_BACKUP_RELAY_SECRET: randomBytes(32).toString("hex"),
  };
  crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const fetch = (path, method = "GET", body, headers = {}) =>
    worker.fetch(
      new Request(origin + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
      env,
    );
  async function identity(role) {
    const id = randomUUID(),
      memberId = "M-" + id,
      token = randomBytes(32).toString("base64url"),
      now = Math.floor(Date.now() / 1000),
      stamp = new Date().toISOString();
    const hash = createHash("sha256")
      .update("VoteProof/member-session/v1:" + token)
      .digest("hex");
    await db
      .prepare(
        "INSERT INTO members(id,member_id,login_name,nickname,player_id,status,created_at,updated_at,last_login_at) VALUES(?,?,?,'Component fixture',?,'active',?,?,?)",
      )
      .bind(id, memberId, id.replaceAll("-", ""), "fan_" + id, stamp, stamp, stamp)
      .run();
    await db
      .prepare(
        "INSERT INTO auth_sessions(token_hash,member_id,created_at,expires_at,elevated_until) VALUES(?,?,?,?,?)",
      )
      .bind(hash, memberId, now, now + 3600, now + 3600)
      .run();
    if (role)
      await db
        .prepare(
          "INSERT INTO admin_memberships(id,member_id,role,status,created_at,created_by,updated_at) VALUES(?,?,?,'active',?,NULL,?)",
        )
        .bind(randomUUID(), memberId, role, stamp, stamp)
        .run();
    const csrf = createHmac("sha256", Buffer.from(env.AUTH_SECRET, "hex"))
      .update(JSON.stringify(["VoteProof/auth/v1", "csrf", hash]))
      .digest("hex");
    return {
      memberId,
      headers: { Origin: origin, Cookie: "__Host-vp-session=" + token, "X-CSRF-Token": csrf },
    };
  }
  async function upload(campaignId, actor, { direct = true, storageVersion = 2 } = {}) {
    const headers = { Origin: origin, ...actor?.headers };
    const response = await fetch(
      "/api/uploads/prepare",
      "POST",
      {
        ...(storageVersion === 2 ? { campaign_id: campaignId, storage_version: 2 } : {}),
        ...(direct ? { completion_mode: "direct" } : {}),
        turnstile_token: "synthetic",
        files: [
          {
            name: "fixture.png",
            type: "image/png",
            size: image.length,
            algorithm: "sha256",
            sha256: createHash("sha256").update(image).digest("hex"),
          },
        ],
      },
      headers,
    );
    const json = await response.json();
    if (response.status !== 200) throw Error(JSON.stringify(json));
    const p = json.data,
      u = p.uploads[0];
    if(historical) {
      // Model the pre-0025 writer solely to populate historical migration data.
      // Current API requests remain fail-closed without storage tables.
      await bucket.put(u.key,image,{sha256:createHash('sha256').update(image).digest('hex'),httpMetadata:{contentType:'image/png'}});
    } else {
    const put = await worker.fetch(
      new Request(u.upload_url, {
        method: "PUT",
        headers: { ...u.headers, ...headers, "Content-Length": String(image.length) },
        body: image,
      }),
      env,
    );
    if (put.status !== 200) throw Error(await put.text());
    }
    const ref = {
      session_id: p.session_id,
      keys: [u.key],
      ...(p.capability ? { capability: p.capability } : {}),
    };
    if (!direct) {
      const complete = await fetch("/api/uploads/complete", "POST", ref, headers);
      if (complete.status !== 200) throw Error(await complete.text());
    }
    return { p, ref };
  }
  return { db, sqlite, env, fetch, identity, upload, bucket, close: () => sqlite.close() };
}
