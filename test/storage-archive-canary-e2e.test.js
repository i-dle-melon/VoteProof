import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {archiveCanaryRuntime} from './helpers/archive-canary-runtime.mjs';
import {inventoryPage} from '../src/lib/storage-capacity.js';
import {storageRoute} from '../src/api/storage.js';
import {cleanupArchive} from '../src/lib/storage-archive.js';
let h;
beforeEach(async()=>{h=await archiveCanaryRuntime();});
afterEach(async()=>{await h?.close();});
const cleanup=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.ok,true);return r.body.data.cleanup;};
const now=()=>Math.floor(Date.now()/1000);
for(const mib of [1,3,5])test(`native local Canary ${mib} MiB: real Code.gs digest, A non-destructive, B bound delete and immutable audit`,async()=>{
  const f=await h.seed('size-'+mib,mib),beforeMedia=h.state.media;
  const a=cleanup(await h.post());assert.equal(a.state,'verification_ready');assert.equal(a.retention_days,7);assert.equal(a.phase,'verify');assert.equal(a.deleted,0);assert.equal(a.file_id,f.file);assert.ok(a.handoff);assert.ok(await h.bucket.head(f.key));assert.equal(h.state.media,beforeMedia+1);
  const durable=await h.db.prepare('SELECT * FROM cold_proofs WHERE file_id=?').bind(f.file).first();assert.equal(durable.lease_token,a.handoff.split('.')[1]);assert.equal(durable.lease_until,0);assert.ok(JSON.parse(durable.verification_context).receipt.signature);
  const b=cleanup(await h.post({canary:true,handoff:a.handoff}));assert.equal(b.state,'cold');assert.equal(b.file_id,f.file);assert.equal(b.deleted,1);assert.equal(b.phase,'delete');assert.equal(h.state.media,beforeMedia+1);assert.equal(await h.bucket.head(f.key),null);
  assert.equal(await h.db.prepare("SELECT status FROM proof_backups WHERE file_id=?").bind(f.file).first('status'),'confirmed');assert.equal(h.files.has(f.drive),true);
  assert.equal(await h.db.prepare("SELECT count(*) n FROM storage_audit WHERE target=? AND action='archive_r2_deleted'").bind(f.file).first('n'),1);
  const again=cleanup(await h.post({canary:true,handoff:a.handoff}));assert.equal(again.deleted,0);assert.equal(await h.db.prepare("SELECT count(*) n FROM storage_audit WHERE target=? AND action='archive_r2_deleted'").bind(f.file).first('n'),1);
  let inventory;for(let i=0;i<10;i++){inventory=await inventoryPage({...h.bindings,DB:h.db,PROOFS_BUCKET:h.bucket});if(inventory.complete)break;}assert.equal(inventory.complete,true);
  const cap=await h.db.prepare('SELECT * FROM storage_capacity').first();assert.equal(cap.used_bytes,0);assert.equal(cap.reserved_bytes,0);assert.equal(cap.anomaly,null);
  assert.equal(await h.db.prepare('SELECT submissions_enabled FROM submission_settings').first('submissions_enabled'),0);assert.equal(h.state.unexpected,0);
  await assert.rejects(h.db.prepare("UPDATE storage_audit SET action='tamper'").run());
  console.log(JSON.stringify({local_canary_mib:mib,sha_re_read:'VM Code.gs',A:a.phase,B:b.phase,deleted:b.deleted,google_real_e2e:'PENDING',cloudflare_cpu_ms:'UNKNOWN'}));
});
test('lost A ACK can only leave a verified object; a new A cannot delete it',async()=>{
  const f=await h.seed('lost-a');const a=cleanup(await h.post());assert.equal(a.state,'verification_ready');
  const repeatedA=cleanup(await h.post());assert.equal(repeatedA.state,'verification_ready');assert.notEqual(repeatedA.handoff,a.handoff);assert.ok(await h.bucket.head(f.key));
  const stale=cleanup(await h.post({canary:true,handoff:a.handoff}));assert.equal(stale.deleted,0);assert.ok(await h.bucket.head(f.key));
  assert.equal(cleanup(await h.post({canary:true,handoff:repeatedA.handoff})).state,'cold');
});
test('B replay or lost B ACK never chooses another eligible file',async()=>{
  const f=await h.seed('first');const a=cleanup(await h.post());const second=await h.seed('second');
  assert.equal(cleanup(await h.post({canary:true,handoff:a.handoff})).file_id,f.file);
  for(let i=0;i<2;i++)assert.equal(cleanup(await h.post({canary:true,handoff:a.handoff})).deleted,0);
  assert.ok(await h.bucket.head(second.key));assert.equal(await h.db.prepare('SELECT state FROM cold_proofs WHERE file_id=?').bind(second.file).first('state'),null);
});
test('concurrent B consumers have at most one delete and one terminal audit',async()=>{
  const f=await h.seed('concurrent');const a=cleanup(await h.post());
  const replies=await Promise.all([h.post({canary:true,handoff:a.handoff}),h.post({canary:true,handoff:a.handoff})]);
  assert.equal(replies.map(cleanup).reduce((n,r)=>n+r.deleted,0),1);assert.equal(await h.bucket.head(f.key),null);
  assert.equal(await h.db.prepare("SELECT count(*) n FROM storage_audit WHERE target=? AND action='archive_r2_deleted'").bind(f.file).first('n'),1);
});
for(const mode of ['sha-mismatch','shared','media-fail','relay-fail','signature-mismatch','nonce-mismatch'])test('Drive verification fails closed: '+mode,async()=>{
  const f=await h.seed(mode);h.state.mode=mode;const a=cleanup(await h.post());assert.equal(a.deleted,0);assert.notEqual(a.state,'verification_ready');assert.ok(await h.bucket.head(f.key));assert.equal(await h.db.prepare('SELECT state FROM cold_proofs WHERE file_id=?').bind(f.file).first('state'),'blocked');
});
test('expired A proof and reservations cannot authorize B',async()=>{
  const f=await h.seed('expired');const a=cleanup(await h.post());
  await h.db.prepare('UPDATE cold_proofs SET verified_at=? WHERE file_id=?').bind(now()-121,f.file).run();
  assert.equal(cleanup(await h.post({canary:true,handoff:a.handoff})).deleted,0);assert.ok(await h.bucket.head(f.key));
  const refreshed=cleanup(await h.post());assert.equal(refreshed.state,'verification_ready');
  await h.db.prepare('UPDATE storage_capacity SET reserved_bytes=1 WHERE id=1').run();
  assert.equal(cleanup(await h.post({canary:true,handoff:refreshed.handoff})).state,'unavailable');assert.ok(await h.bucket.head(f.key));
});
test('R2 version changes or an inventory pin after A cannot authorize B',async()=>{
  const f=await h.seed('changed-version'),a=cleanup(await h.post()),old=await h.bucket.get(f.key);
  await h.bucket.put(f.key,await old.arrayBuffer(),{sha256:old.checksums.sha256,httpMetadata:{contentType:'image/png'}});
  const b=cleanup(await h.post({canary:true,handoff:a.handoff}));assert.equal(b.deleted,0);assert.equal(b.state,'blocked');assert.ok(await h.bucket.head(f.key));
  await h.db.prepare('UPDATE storage_capacity SET inventory_id=? WHERE id=1').bind(randomUUID()).run();
  assert.equal(cleanup(await h.post()).state,'unavailable');assert.ok(await h.bucket.head(f.key));
});
test('isolated server opt-in is independent of relay authorization and rejects Production origins',async()=>{
  const env={...h.bindings,DB:h.db,PROOFS_BUCKET:h.bucket},path='/api/internal/drive-backup/storage/archive',handler=storageRoute(path).handler;
  for(const changes of [{STORAGE_ARCHIVE_CANARY_ENABLED:'false'},{STORAGE_ARCHIVE_CANARY_ENVIRONMENT:'production'},{STORAGE_ARCHIVE_CANARY_ORIGIN:'https://other.invalid'}]){
    const req=new Request(h.origin+path,{method:'POST',headers:{Authorization:'Bearer '+h.secret,'Content-Type':'application/json'},body:'{"canary":true}'});
    assert.equal((await handler({...env,...changes},new URL(req.url),req)).status,403);
  }
  const req=new Request('https://voteproof.i-dle-melon.workers.dev'+path,{method:'POST',headers:{Authorization:'Bearer '+h.secret,'Content-Type':'application/json'},body:'{"canary":true}'});
  assert.equal((await handler({...env,STORAGE_ARCHIVE_CANARY_ORIGIN:new URL(req.url).origin},new URL(req.url),req)).status,403);
});
test('handoff uses existing proof primary key and canary A does not reconcile an unresolved deletion',async()=>{
  const f=await h.seed('pending-delete'),a=cleanup(await h.post());
  const plan=(await h.db.prepare("EXPLAIN QUERY PLAN SELECT f.object_key FROM cold_proofs p JOIN case_files f ON f.id=p.file_id WHERE p.file_id=? AND p.lease_token=? AND p.state='verifying' AND p.lease_until=0 LIMIT 1").bind(f.file,a.handoff.split('.')[1]).all()).results;
  assert.ok(plan.some(p=>p.detail.includes('SEARCH p')&&p.detail.includes('file_id=?')));assert.ok(plan.every(p=>!p.detail.startsWith('SCAN ')));
  await h.db.prepare("UPDATE cold_proofs SET state='deleting',lease_until=0 WHERE file_id=?").bind(f.file).run();
  assert.equal(cleanup(await h.post()).state,'paused');assert.ok(await h.bucket.head(f.key));
  console.log(JSON.stringify({local_canary_handoff_plan:plan.map(p=>p.detail),new_indexes:0}));
});
test('capacity trust expiring before dispatch blocks DELETE without an unresolved dispatch',async()=>{
  const f=await h.seed('trust-expiry'),a=cleanup(await h.post()),realNow=Date.now;
  await h.db.prepare('UPDATE storage_capacity SET trusted_until=? WHERE id=1').bind(now()+1).run();
  let heads=0,deletes=0;
  const bucket={head:async key=>{const r=await h.bucket.head(key);if(++heads===2)Date.now=()=>realNow()+2000;return r;},delete:async key=>{deletes++;return h.bucket.delete(key);}};
  try{
    const result=await cleanupArchive({...h.bindings,DB:h.db,PROOFS_BUCKET:bucket},{handoff:a.handoff,read:()=>assert.fail('B must not call Drive')});
    assert.equal(result.deleted,0);assert.equal(result.state,'blocked');assert.equal(deletes,0);assert.ok(await h.bucket.head(f.key));
    assert.equal(await h.db.prepare('SELECT state FROM cold_proofs WHERE file_id=?').bind(f.file).first('state'),'blocked');assert.equal(await h.db.prepare('SELECT count(*) n FROM storage_archive_dispatches').first('n'),0);
  }finally{Date.now=realNow;}
});
test('server authenticates and validates canary inputs and retires legacy empty-body cleanup',async()=>{
  await h.seed('auth');assert.equal((await h.post({canary:true},{Authorization:'Bearer wrong'})).status,401);
  assert.equal((await h.post({canary:true,handoff:'bad'})).status,400);assert.equal((await h.post({canary:true,file_id:randomUUID()})).status,400);
  for(const handoff of [null,true,123,{},[randomUUID()+'.'+randomUUID()]])assert.equal((await h.post({canary:true,handoff})).status,400);
  const a=cleanup(await h.post());assert.equal(a.state,'verification_ready');
  // Legacy requests may no longer continue a destructive operation.
  const legacy=cleanup(await h.post({}));assert.equal(legacy.state,'legacy_disabled');assert.equal(legacy.deleted,0);assert.equal(cleanup(await h.post({canary:true,handoff:a.handoff})).state,'cold');
});
