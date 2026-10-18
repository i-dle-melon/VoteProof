import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createHmac, createHash, randomBytes, randomUUID } from "node:crypto";
import { storageSignature, shaBytes, readColdProof } from "../src/lib/cold-storage.js";
const backupSource = readFileSync("apps-script/drive-backup/Code.gs", "utf8"),
  alertSource = readFileSync("apps-script/storage-alert/Code.gs", "utf8");
function fixture(source, { email = "idle.voteproof.verify@gmail.com" } = {}) {
  const secret = randomBytes(32).toString("hex"),
    properties = new Map([
      ["DRIVE_BACKUP_RELAY_SECRET", secret],
      ["STORAGE_ALERT_RELAY_SECRET", secret],
      ["ROOT_FOLDER_ID", "root"],
      ["VOTEPROOF_ORIGIN", "https://fixture.invalid"],
    ]);
  const files = new Map(),
    state = {
      sends: 0,
      archiveCalls: 0,
      quota: 100,
      shared: false,
      mediaFailure: false,
      calls: [],
      about: { storageQuota: { limit: "15000000000", usage: "10000000000" } },
    };
  let locked = false;
  const context = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => properties.get(k),
          getProperties:()=>Object.fromEntries(properties),deleteProperty:k=>properties.delete(k),
        setProperty: (k, v) => properties.set(k, v),
      }),
    },
    Utilities: {
      getUuid: randomUUID,
      Charset: { UTF_8: "utf8" },
      DigestAlgorithm: { SHA_256: "sha256" },
      computeDigest: (_algorithm, text) => [...createHash("sha256").update(typeof text==="string"?text:Buffer.from(text)).digest()],
      computeHmacSha256Signature: (text, key) => [
        ...createHmac("sha256", key).update(text).digest(),
      ],
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString("base64url"),
      base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (value) => ({
        value,
        setMimeType() {
          return this;
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (locked) return false;
          locked = true;
          return true;
        },
        releaseLock: () => {
          locked = false;
        },
      }),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => email }) },
    MailApp: {
      getRemainingDailyQuota: () => state.quota,
      sendEmail: () => {
        state.sends++;
      },
    },
    Drive: {
      Files: {
        get: (id) => {
          if (!files.has(id)) throw Error("404");
          return structuredClone(files.get(id));
        },
      },
      Permissions: {
        list: () => ({
          permissions: state.shared
            ? [{ type: "anyone", role: "reader" }]
            : [{ type: "user", role: "owner" }],
        }),
      },
      About: {
        get: (options) => {
          assert.equal(options.fields, "storageQuota");
          if (state.about instanceof Error) throw state.about;
          return state.about;
        },
      },
    },
    ScriptApp: { getOAuthToken: () => secret },
    UrlFetchApp: {
      fetch: (url, init) => {
        state.calls.push({ url, init });
        if (url.includes("googleapis.com/drive"))
          return {
            getResponseCode: () => (state.mediaFailure ? 503 : 200),
            getBlob: () => ({ getBytes: () => [1, 2, 3] }),
          };
        return {
          getResponseCode: () => 200,
          getContentText: () =>
            JSON.stringify({ ok: true, data: url.endsWith("/storage/archive") ? {cleanup:{state:state.archiveState??(++state.archiveCalls===1?"verification_ready":"cold")}} : { inventory: { complete: true }, state: "fixture" } }),
        };
      },
    },
  });
  vm.runInContext(source, context);
  return { context, secret, properties, state, files };
}
async function coldRequest(f) {
  const r = {
    version: 1,
    purpose: "cold_read",
    nonce: randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    file_id: "proof",
  };
  r.signature = await storageSignature(
    f.secret,
    JSON.stringify([
      "VoteProof/storage-read",
      r.version,
      r.purpose,
      r.nonce,
      r.timestamp,
      r.file_id,
    ]),
  );
  return r;
}
function coldFiles(f) {
  const folder = "application/vnd.google-apps.folder";
  for (const m of [
    { id: "root", mimeType: folder },
    {
      id: "campaign",
      mimeType: folder,
      parents: ["root"],
      appProperties: { source: "voteproof", folder_key: "campaign-hash" },
    },
    {
      id: "day",
      mimeType: folder,
      parents: ["campaign"],
      appProperties: { source: "voteproof", folder_key: "day-hash" },
    },
    {
      id: "proof",
      name: "VP-fixture.png",
      mimeType: "image/png",
      size: "3",
      parents: ["day"],
      appProperties: { source: "voteproof", storage_source: "r2" },
    },
  ])
    f.files.set(m.id, { ...m, trashed: false });
}
test("cold Apps Script authenticates before Google access and returns signed bytes only from private pinned root", async () => {
  const f = fixture(backupSource);
  coldFiles(f);
  const r = await coldRequest(f);
  const post = (v) =>
    JSON.parse(f.context.doPost({ postData: { contents: JSON.stringify(v) } }).value);
  assert.equal(post({ ...r, signature: "wrong" }).error, "COLD_UNAVAILABLE");
  assert.equal(f.state.calls.length, 0);
  const result = post(r);
  assert.equal(JSON.parse(result.payload).base64, "AQID");
  assert.equal(
    result.signature,
    await storageSignature(
      f.secret,
      JSON.stringify([
        "VoteProof/storage-read-result",
        result.nonce,
        result.timestamp,
        result.payload,
      ]),
    ),
  );
  f.state.shared = true;
  assert.equal(post(r).error, "COLD_UNAVAILABLE");
  f.state.shared = false;
  f.files.get("campaign").parents = ["another-root"];
  assert.equal(post(r).error, "COLD_UNAVAILABLE");
});
test("Drive media failure never fabricates proof bytes", async () => {
  const f = fixture(backupSource);
  coldFiles(f);
  f.state.mediaFailure = true;
  assert.equal(
    JSON.parse(
      f.context.doPost({ postData: { contents: JSON.stringify(await coldRequest(f)) } }).value,
    ).error,
    "COLD_UNAVAILABLE",
  );
});
test("quota uses about.get storageQuota, supports unknown/unlimited/error and never installs a trigger", () => {
  for (const about of [
    { storageQuota: { limit: "15000000000", usage: "10000000000" } },
    { storageQuota: { usage: "123" } },
    { storageQuota: {} },
    new Error("offline"),
  ]) {
    const f = fixture(backupSource);
    f.state.about = about;
    f.context.runStorageMaintenance();
    const quota = JSON.parse(f.state.calls[0].init.payload);
    assert.equal(
      quota.total_bytes,
      about instanceof Error || !about.storageQuota.limit ? null : 15000000000,
    );
    assert.equal(
      quota.state,
      about instanceof Error
        ? "error"
        : about.storageQuota.limit
          ? "known"
          : about.storageQuota.usage
            ? "unlimited"
            : "unknown",
    );
    assert.ok(f.state.calls.every((c) => !c.url.includes("token")));
  }
});
async function alertRequest(f, id = randomUUID()) {
  const b = {
    version: 1,
    purpose: "storage_alert",
    timestamp: Math.floor(Date.now() / 1000),
    send_id: id,
    from: "idle.voteproof.verify@gmail.com",
    to: "fixture@example.invalid",
    kind: "95",
  };
  b.signature = await storageSignature(
    f.secret,
    JSON.stringify([
      "VoteProof/storage-alert",
      b.version,
      b.purpose,
      b.timestamp,
      b.send_id,
      b.from,
      b.to,
      b.kind,
    ]),
  );
  return b;
}
test("dedicated alert MailApp has fixed account, signed purpose, durable cross-restart dedup and quota", async () => {
  const f = fixture(alertSource),
    b = await alertRequest(f),
    post = (v) => JSON.parse(f.context.doPost({ postData: { contents: JSON.stringify(v) } }).value);
  assert.equal(post({ ...b, signature: "bad" }).outcome, "rejected");
  assert.equal(f.state.sends, 0);
  assert.equal(post(b).outcome, "sent");
  assert.equal(post(b).outcome, "sent");
  assert.equal(f.state.sends, 1);
  f.state.quota = 0;
  assert.equal(post(await alertRequest(f)).outcome, "rejected");
  assert.equal(f.state.sends, 1);
  const other = fixture(alertSource, { email: "wrong@example.invalid" });
  assert.equal(
    JSON.parse(
      other.context.doPost({ postData: { contents: JSON.stringify(await alertRequest(other)) } })
        .value,
    ).outcome,
    "rejected",
  );
  assert.equal(other.state.sends, 0);
});
test("cold transport checks maximum-size bytes through bounded signed result, not only metadata", async (t) => {
  const bytes = new Uint8Array(5242880);
  bytes.fill(37);
  const sha = await shaBytes(bytes),
    secret = randomBytes(32).toString("hex"),
    row = {
      file_id: "fixture",
      object_key: "fixture",
      size: bytes.length,
      content_type: "image/png",
      etag: "etag",
      backup_status: "confirmed",
      drive_file_id: "file",
      drive_folder_id: "day",
      root_folder_id: "root",
      campaign_folder_id: "campaign",
      date_key: "date:fixture",
      campaign_key: "campaign:fixture",
      source_object_key: "fixture",
      source_size: bytes.length,
      source_mime: "image/png",
      source_etag: "etag",
      case_id: "VP-fixture",
    };
  const started = performance.now(),
    cpu = process.cpuUsage();
  const actual = await readColdProof(
    {
      DRIVE_BACKUP_RELAY_SECRET: secret,
      DRIVE_COLD_RELAY_URL: "https://"+"script.google.com"+"/macros/s/fixture/exec",
    },
    row,
    sha,
    {
      fetcher: async (_u, init) => {
        const request = JSON.parse(init.body),
          payload = JSON.stringify({
            metadata: {
              id: "file",
              trashed: false,
              name: "VP-fixture.png",
              size: bytes.length,
              mimeType: "image/png",
              parents: ["day"],
              appProperties: {
                source: "voteproof",
                storage_source: "r2",
                voteproof_case_id: "VP-fixture",
                voteproof_proof_id: "fixture",
              },
            },
            base64: Buffer.from(bytes).toString("base64"),
            root_folder_id: "root",
            campaign_folder_id: "campaign",
            date_folder_id: "day",
            campaign_key_hash: await shaBytes(new TextEncoder().encode(row.campaign_key)),
            date_key_hash: await shaBytes(new TextEncoder().encode(row.date_key)),
          }),
          result = { nonce: request.nonce, timestamp: Math.floor(Date.now() / 1000), payload };
        result.signature = await storageSignature(
          secret,
          JSON.stringify([
            "VoteProof/storage-read-result",
            result.nonce,
            result.timestamp,
            payload,
          ]),
        );
        return Response.json(result);
      },
    },
  );
  assert.equal(actual.length, 5242880);
  assert.equal(await shaBytes(actual), sha);
  assert.ok(performance.now() > started);
  const used = process.cpuUsage(cpu);
  t.diagnostic(
    JSON.stringify({
      local_only: true,
      bytes: bytes.length,
      wall_ms: Math.round(performance.now() - started),
      process_cpu_ms: (used.user + used.system) / 1000,
      cloud_worker_cpu: "UNKNOWN",
      includes_mock_response_encoding: true,
    }),
  );
});

test('Apps Script archive_verify returns a bounded signed SHA receipt, never raw or base64 image bytes', async () => {
  const f=fixture(backupSource);
  coldFiles(f);
  f.files.get('proof').appProperties={
    source:'voteproof',storage_source:'r2',
    voteproof_case_id:'VP-fixture',voteproof_proof_id:'proof-id'
  };
  const sha=createHash('sha256').update(Buffer.from([1,2,3])).digest('hex');
  const request={version:1,purpose:'archive_verify',nonce:randomUUID(),
    timestamp:Math.floor(Date.now()/1000),file_id:'proof',expected_sha256:sha,expected_size:3};
  request.signature=await storageSignature(f.secret,JSON.stringify([
    'VoteProof/archive-verify',request.version,request.purpose,request.nonce,
    request.timestamp,request.file_id,sha,3
  ]));
  const post=v=>JSON.parse(f.context.doPost({postData:{contents:JSON.stringify(v)}}).value);
  assert.equal(post({...request,signature:'invalid'}).error,'COLD_UNAVAILABLE');
  assert.equal(f.state.calls.length,0);
  const reply=post(request),payload=JSON.parse(reply.payload);
  assert.equal(payload.sha256,sha);
  assert.equal(payload.file_id,'proof');
  assert.equal(payload.root_folder_id,'root');
  assert.equal(payload.case_id,'VP-fixture');
  assert.equal(JSON.stringify(reply).includes('base64'),false);
  assert.ok(JSON.stringify(reply).length<2048);
  assert.equal(reply.signature,await storageSignature(f.secret,JSON.stringify([
    'VoteProof/archive-verified-result',reply.nonce,reply.timestamp,reply.payload
  ])));
  f.state.shared=true;
  assert.equal(post(request).error,'COLD_UNAVAILABLE');
  f.state.shared=false;
  f.files.get('campaign').parents=['wrong-root'];
  assert.equal(post(request).error,'COLD_UNAVAILABLE');
  f.files.get('campaign').parents=['root'];
  assert.equal(post({...request,expected_sha256:'0'.repeat(64)}).error,'COLD_UNAVAILABLE');
  // Re-sign a wrong expected digest so the assertion reaches the media SHA
  // comparison rather than merely rejecting a stale request HMAC.
  const signed=async changes=>{
    const v={...request,...changes};v.signature=await storageSignature(f.secret,JSON.stringify([
      'VoteProof/archive-verify',v.version,v.purpose,v.nonce,v.timestamp,v.file_id,v.expected_sha256,v.expected_size
    ]));return v;
  };
  const calls=f.state.calls.length;
  assert.equal(post(await signed({expected_sha256:'0'.repeat(64)})).error,'COLD_UNAVAILABLE');
  assert.equal(f.state.calls.length,calls+1);
  const before=f.state.calls.length;
  assert.equal(post(await signed({timestamp:request.timestamp-121})).error,'COLD_UNAVAILABLE');
  assert.equal(post(await signed({nonce:'invalid'})).error,'COLD_UNAVAILABLE');
  assert.equal(f.state.calls.length,before);
});

test('maintenance sends inventory, verification and deletion as separate authenticated requests',()=>{
  const f=fixture(backupSource);const result=f.context.runStorageMaintenance();
  assert.equal(result.cleanup.state,'cold');
  assert.deepEqual(f.state.calls.map(x=>new URL(x.url).pathname),[
    '/api/internal/drive-backup/storage/quota','/api/internal/drive-backup/storage/tick',
    '/api/internal/drive-backup/storage/archive','/api/internal/drive-backup/storage/archive']);
  const stopped=fixture(backupSource);stopped.state.archiveState='no_eligible_proofs';stopped.context.runStorageMaintenance();
  assert.equal(stopped.state.calls.filter(x=>x.url.endsWith('/storage/archive')).length,1);
});
