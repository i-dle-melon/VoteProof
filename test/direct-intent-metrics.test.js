// Structural operation counts, never CPU timing. Everything uses disposable D1/R2.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";
import { prepareUpload, putUpload, completeUpload } from "../src/api/uploads.js";
import { createCase, createDirectCase } from "../src/api/cases.js";
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const origin = "https://voteproof.example",
  bytes = new Uint8Array([1, 2, 3]);
function observed(env) {
  const count = {
      statements: 0,
      trips: 0,
      r2: { head: 0, get: 0, put: 0, delete: 0 },
      crypto: {
        digest: 0,
        importKey: 0,
        sign: 0,
        encrypt: 0,
        decrypt: 0,
        randomUUID: 0,
        getRandomValues: 0,
      },
    },
    raw = new WeakMap();
  const wrap = (s) => {
    const p = new Proxy(s, {
      get(t, k) {
        if (k === "bind") return (...a) => wrap(t.bind(...a));
        if (["first", "all", "run"].includes(k))
          return (...a) => {
            count.statements++;
            count.trips++;
            return t[k](...a);
          };
        return typeof t[k] === "function" ? t[k].bind(t) : t[k];
      },
    });
    raw.set(p, s);
    return p;
  };
  const DB = {
    prepare: (s) => wrap(env.DB.prepare(s)),
    batch: (list) => {
      count.statements += list.length;
      count.trips++;
      return env.DB.batch(list.map((s) => raw.get(s)));
    },
  };
  const PROOFS_BUCKET = Object.fromEntries(
    Object.keys(count.r2).map((k) => [
      k,
      async (...args) => {
        count.r2[k]++;
        // Host<->workerd RPC cannot transfer the Node-native request stream. This
        // test-only bridge buffers it; production receives the native stream intact.
        if (k === "put" && args[1] instanceof ReadableStream)
          args[1] = new Uint8Array(await new Response(args[1]).arrayBuffer());
        return env.PROOFS_BUCKET[k](...args);
      },
    ]),
  );
  return {
    env: { ...env, DB, PROOFS_BUCKET },
    count,
    async run(fn) {
      const restore = [];
      for (const name of Object.keys(count.crypto)) {
        const owner = name === "randomUUID" || name === "getRandomValues" ? crypto : crypto.subtle,
          original = owner[name];
        owner[name] = function (...args) {
          count.crypto[name]++;
          return original.apply(this, args);
        };
        restore.push(() => {
          owner[name] = original;
        });
      }
      const fetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
        return Response.json({ success: true });
      };
      try {
        const r = await fn(this.env);
        assert.ok(r.status === 200 || r.status === 201, await r.clone().text());
        return (await r.json()).data;
      } finally {
        globalThis.fetch = fetch;
        for (const f of restore) f();
      }
    },
  };
}
test("measured old/new member/guest D1/R2/crypto counts include foreground backup enqueue and durable storage reservation", async () => {
  const h = await localAdminRuntime({ directIntent: true }),
    l = h.local,
    results = [];
  try {
    const actor = await h.identity();
    await l.setAuthConfig({
      GOOGLE_DRIVE_BACKUP_ENABLED: "true",
      DRIVE_BACKUP_RELAY_SECRET: "a".repeat(64),
    });
    for (const direct of [false, true])
      for (const member of [true, false]) {
        const env = { ...l.authConfig, DB: l.db, PROOFS_BUCKET: l.bucket },
          headers = { Origin: origin, ...(member ? actor.headers : {}) },
          stages = {};
        const req = (path, body, extra = {}) =>
          new Request(origin + path, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers, ...extra },
            body: JSON.stringify(body),
          });
        async function stage(name, fn) {
          const o = observed(env),
            value = await o.run(fn);
          stages[name] = o.count;
          return value;
        }
        const p = await stage("prepare", (e) =>
          prepareUpload(
            e,
            null,
            req("/api/uploads/prepare", {
              storage_version: 2,
              ...(direct ? { completion_mode: "direct" } : {}),
              campaign_id: "LOCAL-TEST",
              turnstile_token: "synthetic",
              files: [
                {
                  name: "fixture.png",
                  size: 3,
                  type: "image/png",
                  algorithm: "sha256",
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                },
              ],
            }),
          ),
        );
        await stage("put", (e) =>
          putUpload(
            e,
            new URL(p.uploads[0].upload_url),
            new Request(p.uploads[0].upload_url, {
              method: "PUT",
              headers: { ...headers, ...p.uploads[0].headers, "Content-Length": "3" },
              body: bytes,
            }),
          ),
        );
        const reference = {
          session_id: p.session_id,
          keys: [p.uploads[0].key],
          ...(p.capability ? { capability: p.capability } : {}),
        };
        if (!direct)
          await stage("complete", (e) =>
            completeUpload(e, null, req("/api/uploads/complete", reference)),
          );
        const idempotencyKey = randomUUID(),
          path = direct ? "/api/cases/direct" : "/api/cases";
        await stage("case", (e) =>
          (direct ? createDirectCase : createCase)(
            e,
            null,
            req(
              path,
              {
                campaign_id: "LOCAL-TEST",
                vote_type: "Solo",
                vote_date: new Date().toISOString().slice(0, 10),
                upload_session: reference,
              },
              { "Idempotency-Key": idempotencyKey },
            ),
          ),
        );
        assert.equal(
          (
            await l.db
              .prepare(
                "SELECT count(*) n FROM proof_backups b JOIN case_files f ON f.id=b.file_id WHERE f.object_key=?",
              )
              .bind(p.uploads[0].key)
              .first()
          ).n,
          1,
        );
        const total = {
          statements: 0,
          trips: 0,
          r2: { head: 0, get: 0, put: 0, delete: 0 },
          crypto: Object.fromEntries(Object.keys(stages.case.crypto).map((k) => [k, 0])),
        };
        for (const s of Object.values(stages)) {
          total.statements += s.statements;
          total.trips += s.trips;
          for (const k of Object.keys(total.r2)) total.r2[k] += s.r2[k];
          for (const k of Object.keys(total.crypto)) total.crypto[k] += s.crypto[k];
        }
        assert.equal(total.r2.get, 0);
        assert.equal(total.r2.put, 1);
        assert.equal(total.r2.head, direct ? 1 : 2);
        assert.equal(total.r2.delete, 0);
        assert.deepEqual(
          [stages.case.statements, stages.case.trips],
          direct ? (member ? [7, 5] : [6, 4]) : member ? [9, 5] : [8, 4],
        );
        assert.deepEqual(
          [total.statements, total.trips],
          direct ? (member ? [19, 17] : [16, 14]) : member ? [30, 22] : [26, 18],
        );
        results.push({
          flow: direct ? "direct" : "legacy-v2",
          identity: member ? "member" : "guest",
          stages,
          total,
          ...(direct
            ? {
                analysisOnlyWithoutBackup: {
                  caseStatements: stages.case.statements - 1,
                  caseTrips: stages.case.trips - 1,
                  totalStatements: total.statements - 1,
                  totalTrips: total.trips - 1,
                  randomUUID: total.crypto.randomUUID - 1,
                },
              }
            : {}),
        });
      }
    await mkdir(".wrangler/direct-intent-poc", { recursive: true });
    await writeFile(
      ".wrangler/direct-intent-poc/metrics.json",
      JSON.stringify(
        {
          cpu: "NOT MEASURED",
          counts:
            "binding calls/statements; trigger-internal SQL excluded; crypto is host handler WebCrypto plus random API calls, excludes native R2 verification",
          results,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify(results));
  } finally {
    await l.runtime.dispose();
  }
});
