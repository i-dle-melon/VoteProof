// Structural operation counts, never CPU timing. Everything uses disposable D1/R2.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import {unstable_splitSqlQuery} from 'wrangler';
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";
import { prepareUpload, putUpload, completeUpload } from "../src/api/uploads.js";
import { createCase, createDirectCase } from "../src/api/cases.js";
import {observeUploadCost as observed} from './helpers/upload-cost-observer.mjs';
import {fencedRequest} from '../src/lib/prelaunch-reset-fence.js';
import {memberSession,csrfToken} from '../src/lib/auth-session.js';
import {RESET_V1_SQL_SHA256} from '../src/lib/prelaunch-reset-schema.js';
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const origin = "https://voteproof.example",
  bytes = new Uint8Array([1, 2, 3]);
test("measured member/guest costs separate atomic admission and Reset Fence OFF/ON", async () => {
 const results=[];
 for(const fenced of [false,true]){
  const h = await localAdminRuntime({ directIntent: true }),
    l = h.local;
  try {
    const actor = await h.identity();
    if(fenced){
      await l.db.batch(unstable_splitSqlQuery(await readFile('migrations-reset-v1/0001_reset_fence.sql','utf8')).map(sql=>l.db.prepare(sql)));
      await l.db.prepare('INSERT INTO prelaunch_reset_schema_versions VALUES(1,?,?)').bind(RESET_V1_SQL_SHA256,new Date().toISOString()).run();
      await l.db.prepare("UPDATE prelaunch_reset_control SET epoch=1,mode='open'").run();
    }
    await l.setAuthConfig({
      GOOGLE_DRIVE_BACKUP_ENABLED: "true",
      DRIVE_BACKUP_RELAY_SECRET: "a".repeat(64),
      PRELAUNCH_RESET_FENCE_ENABLED:fenced?'true':'false',
    });
    if(fenced){const env={...l.authConfig,DB:l.db};const session=await memberSession(new Request(origin,{headers:actor.headers}),env);actor.headers['X-CSRF-Token']=await csrfToken(session,{...env,PRELAUNCH_RESET_CONTEXT:{epoch:1}});}
    const invoke=(e,handler,request)=>fenced?fencedRequest(e,request,scoped=>handler(scoped,new URL(request.url),request)):handler(e,new URL(request.url),request);
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
          invoke(
            e,
            prepareUpload,
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
          invoke(
            e,
            putUpload,
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
            invoke(e,completeUpload,req("/api/uploads/complete", reference)),
          );
        const idempotencyKey = randomUUID(),
          path = direct ? "/api/cases/direct" : "/api/cases";
        await stage("case", (e) =>
          invoke(
            e,
            direct ? createDirectCase : createCase,
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
          rows_read:0,rows_written:0,rows_metadata_complete:true,
          r2: { head: 0, get: 0, put: 0, delete: 0 },
          crypto: Object.fromEntries(Object.keys(stages.case.crypto).map((k) => [k, 0])),
        };
        for (const s of Object.values(stages)) {
          total.statements += s.statements;
          total.trips += s.trips;
          if(!s.rows_metadata_complete){total.rows_metadata_complete=false;total.rows_read=total.rows_written=null;}
          else if(total.rows_metadata_complete){total.rows_read+=s.rows_read;total.rows_written+=s.rows_written;}
          for (const k of Object.keys(total.r2)) total.r2[k] += s.r2[k];
          for (const k of Object.keys(total.crypto)) total.crypto[k] += s.crypto[k];
        }
        assert.equal(total.r2.get, 0);
        assert.equal(total.r2.put, 1);
        assert.equal(total.r2.head, direct ? 1 : 2);
        assert.equal(total.r2.delete, 0);
        const admission=stages.put.batches.filter(b=>b.kinds.includes('pin_cas')&&b.kinds.includes('reservation'));
        assert.equal(admission.length,1,'pin CAS and reservation must share exactly one application trip');
        assert.deepEqual(admission[0].kinds,fenced?['fence_permit','pin_cas','reservation','capacity_receipt','fence_exit']:['pin_cas','reservation','capacity_receipt']);
        assert.equal(admission[0].statements,fenced?5:3);
        // Previous unfenced admission used pin.run + reservation.run: 2 SQL,
        // 2 trips. The new conditional receipt adds one SQL but co-batches both.
        // This is different from fenced admission (6->5 SQL, 2->1 trips).
        if(!fenced)assert.deepEqual(
          [stages.case.statements, stages.case.trips],
          direct ? (member ? [7, 5] : [6, 4]) : member ? [9, 5] : [8, 4],
        );
        // Same-fixture offline baseline measured both modes independently.
        const previous=fenced?(direct?(member?[59,41]:[56,38]):member?[81,55]:[77,51]):direct?(member?[19,17]:[16,14]):member?[30,22]:[26,18];
        assert.deepEqual(
          [total.statements, total.trips],
          [previous[0]+admission[0].statements-(fenced?6:2),previous[1]+admission.length-2],
        );
        results.push({
          flow: direct ? "direct" : "legacy-v2",
          identity: member ? "member" : "guest",
          resetFence:fenced?'ON':'OFF',
          stages,
          total,
          ...(direct
            ? {
                analysisOnlyWithoutBackup: {
                  caseStatements: stages.case.statements - (fenced?3:1),
                  caseTrips: stages.case.trips - 1,
                  totalStatements: total.statements - (fenced?3:1),
                  totalTrips: total.trips - 1,
                  randomUUID: total.crypto.randomUUID - 1,
                },
              }
            : {}),
        });
      }
  } finally {await l.runtime.dispose();}
 }
    await mkdir(".wrangler/direct-intent-poc", { recursive: true });
    await writeFile(
      ".wrangler/direct-intent-poc/metrics.json",
      JSON.stringify(
        {
          cpu: "NOT MEASURED",
          counts:
            "application statements/trips exclude trigger-internal SQL; rows are native LOCAL workerd D1 metadata, not cloud billing; crypto excludes native R2 verification",
          results,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify(results));
});
