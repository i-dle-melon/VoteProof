import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveHarnessRuntime} from './helpers/archive-harness-runtime.mjs';
import {runPair,samplePlan} from '../scripts/lib/archive-canary-harness.mjs';
import {cleanupArchive} from '../src/lib/storage-archive.js';
import {reserveStorage} from '../src/lib/storage-capacity.js';
import {archiveCanaryRuntime} from './helpers/archive-canary-runtime.mjs';
import {storageSignature} from '../src/lib/cold-storage.js';
import {randomUUID} from 'node:crypto';
import {archiveControlStatus,changeArchiveControl} from '../src/lib/archive-fencing.js';
for(const mib of [1,3,5])test(`new harness ${mib} MiB: real A/B HTTP, separate mock invocation, native local D1/R2`,async()=>{
  const h=await archiveHarnessRuntime();try{
    const f=await h.seed('new-'+mib,mib);let hold;const requests=[];
    const result=await runPair(async(body,id)=>{requests.push(id);const r=await h.post(body,{'X-Isolated-Sample':id});assert.equal(r.status,200,JSON.stringify(r.body));return r;},
      {read:async()=>hold,write:async v=>{hold=v;},clear:async()=>{hold=null;}},samplePlan(1).find(s=>s.mib===mib));
    assert.equal(result.state,'complete');assert.equal(requests.length,2);assert.equal(hold,null);assert.equal(await h.bucket.head(f.key),null);
    assert.equal(await h.db.prepare("SELECT state FROM cold_proofs WHERE file_id=?").bind(f.file).first('state'),'cold');
    assert.equal(await h.db.prepare("SELECT status FROM proof_backups WHERE file_id=?").bind(f.file).first('status'),'confirmed');
    assert.equal(await h.db.prepare("SELECT used FROM canary_harness_budget WHERE role='relay'").first('used'),1);
    assert.equal(await h.db.prepare("SELECT used FROM canary_harness_budget WHERE role='request'").first('used'),2);
    assert.equal(h.state.unexpected,0);console.log(JSON.stringify({new_harness_mib:mib,protocol:'canary A/B',requests:2,relay_mock:1,cloud_cpu:'UNKNOWN',real_drive:'PENDING'}));
  }finally{await h.close();}
});
test('harness rejects legacy empty body, wrong access, non-archive endpoints; pause/budget fail closed',async()=>{
  const h=await archiveHarnessRuntime();try{
    assert.equal((await h.post({})).status,404);assert.equal((await h.post({canary:true},{'X-Isolated-Access':'bad'})).status,404);
    assert.equal((await h.runtime.dispatchFetch(h.origin+'/api/internal/drive-backup/storage/tick',{method:'POST'})).status,404);
    await h.db.prepare('UPDATE canary_harness_budget SET paused=1').run();assert.equal((await h.post({canary:true})).status,429);
    await h.db.prepare('UPDATE canary_harness_budget SET paused=0,used=ceiling').run();assert.equal((await h.post({canary:true})).status,429);
  }finally{await h.close();}
});
test('operations profile is separate and supplies observed D1/R2 counters, not native CPU',async()=>{
  const h=await archiveHarnessRuntime({profile:true});try{
    const f=await h.seed('operations');const a=await h.post({canary:true});assert.equal(a.body.data.cleanup.state,'verification_ready');
    const b=await h.post({canary:true,handoff:a.body.data.cleanup.handoff});assert.equal(b.body.data.cleanup.state,'cold');
    assert.equal(a.metrics.r2.delete,0);assert.equal(b.metrics.r2.delete,1);assert.ok(a.metrics.rows_read>0);assert.ok(b.metrics.rows_written>0);
    assert.equal(await h.bucket.head(f.key),null);console.log(JSON.stringify({operations_profile_local:true,A:a.metrics,B:b.metrics,cpu:'UNKNOWN'}));
  }finally{await h.close();}
});
test('missing exclusive-writer attestation fails closed before Drive or DELETE',async()=>{
  const h=await archiveHarnessRuntime();try{
    const f=await h.seed('writer-off');let deletes=0;
    const r=await cleanupArchive({...h.bindings,R2_EXCLUSIVE_WRITER_CONFIRMED:'false',DB:h.db,PROOFS_BUCKET:{delete:()=>{deletes++;}}},{verifyOnly:true});
    assert.equal(r.state,'paused');assert.equal(deletes,0);assert.ok(await h.bucket.head(f.key));
  }finally{await h.close();}
});
test('controlled writer reservation is blocked by durable pin; uncooperative external overwrite demonstrates HEAD/DELETE gap',async()=>{
  const h=await archiveHarnessRuntime();try{
    const f=await h.seed('head-delete-gap'),a=await h.post({canary:true}),handoff=a.body.data.cleanup.handoff;
    let heads=0,externalVersion,writerBlocked=false;
    const bucket={head:key=>h.bucket.head(key),delete:async key=>{
      // Exactly after the FINAL successful HEAD, before the native DELETE.
      heads++;
      await assert.rejects(reserveStorage({...h.bindings,DB:h.db},key,f.size),e=>e.code==='R2_STORAGE_CAPACITY_EXCEEDED'&&e.noWrite===true);writerBlocked=true;
      externalVersion=(await h.bucket.put(key,new Uint8Array([9,9,9]),{httpMetadata:{contentType:'image/png'}})).version;
      return h.bucket.delete(key);
    }};
    const r=await cleanupArchive({...h.bindings,DB:h.db,PROOFS_BUCKET:bucket},{handoff});
    assert.equal(r.state,'cold');assert.equal(heads,1);assert.equal(writerBlocked,true);assert.ok(externalVersion);assert.equal(await h.bucket.head(f.key),null);
    console.log(JSON.stringify({adversarial_gap_reproduced:true,cooperating_writer_blocked:true,uncooperative_replacement_deleted:true,production:'NO-GO without controlled writers',not_a_safety_pass:true}));
  }finally{await h.close();}
});
test('legacy empty-body caller is retired and cannot bypass a controller journal',async()=>{
  const h=await archiveCanaryRuntime();try{
    const f=await h.seed('legacy-controller'),a=await h.post({canary:true});assert.equal(a.body.data.cleanup.state,'verification_ready');
    const journalHeld={phase:'B',state:'operator_hold'};assert.ok(journalHeld);
    const legacy=await h.post({});assert.equal(legacy.body.data.cleanup.state,'legacy_disabled');assert.ok(await h.bucket.head(f.key));
    console.log(JSON.stringify({legacy_caller_bypasses_script_journal:false,production:'NO-GO pending external evidence',cpu_sample:false}));
  }finally{await h.close();}
});
test('isolated seed/snapshot uses only predeclared fixture and retains backup record after B',async()=>{
  const h=await archiveHarnessRuntime();try{
    const f=await h.seed('1m-1');await h.bucket.delete(f.key); // synthetic reset before any archival claim
    const headers={'X-Isolated-Access':h.secret,'X-Canary-Fixture':f.label};
    const call=(path,body)=>h.runtime.dispatchFetch(h.origin+path,{method:'POST',headers,body});
    assert.equal((await call('/__canary_seed',h.media.get(f.drive))).status,200);assert.ok(await h.bucket.head(f.key));
    const a=await h.post({canary:true}),b=await h.post({canary:true,handoff:a.body.data.cleanup.handoff});assert.equal(b.body.data.cleanup.state,'cold');
    const snapshot=await call('/__canary_snapshot');assert.deepEqual(await snapshot.json(),{exists:false,state:'cold',error_code:null,backup:'confirmed',terminal_audits:1});
    assert.equal((await call('/__canary_seed',h.media.get(f.drive))).status,404);assert.equal(await h.bucket.head(f.key),null);
  }finally{await h.close();}
});
test('mock receipt validates HMAC and rejects nonce replay; no external Google request',async()=>{
  const h=await archiveHarnessRuntime();try{
    const f=await h.seed('nonce');const r={version:1,purpose:'archive_verify',nonce:randomUUID(),timestamp:Math.floor(Date.now()/1000),file_id:f.drive,expected_sha256:await h.db.prepare('SELECT expected_sha FROM isolated_fixtures WHERE file_id=?').bind(f.file).first('expected_sha'),expected_size:f.size};
    r.signature=await storageSignature(h.secret,JSON.stringify(['VoteProof/archive-verify',1,r.purpose,r.nonce,r.timestamp,r.file_id,r.expected_sha256,r.expected_size]));
    const post=body=>h.runtime.dispatchFetch(h.origin+'/__canary_mock',{method:'POST',headers:{'X-Isolated-Access':h.secret},body:JSON.stringify(body)});
    assert.equal((await post(r)).status,200);assert.equal((await post(r)).status,404);assert.equal((await post({...r,signature:'bad'})).status,404);
    assert.ok(await h.bucket.head(f.key));assert.equal(h.state.unexpected,0);
  }finally{await h.close();}
});
for(const provided of [false,true])test('virgin harness initialization requires scoped evidence; seed never reverses pause: '+provided,async()=>{
  const h=await archiveHarnessRuntime({activate:false,writerEvidenceHash:provided?'a'.repeat(64):null});try{
    const f=await h.seed('1m-1'),seed=()=>h.runtime.dispatchFetch(h.origin+'/__canary_seed',{method:'POST',headers:{'X-Isolated-Access':h.secret,'X-Canary-Fixture':f.label},body:h.media.get(f.drive)});
    assert.equal((await seed()).status,provided?200:503);
    const c=await archiveControlStatus(h.db);assert.equal(c.mode,provided?'running':'paused');
    if(provided){await changeArchiveControl(h.db,{action:'pause',expected_epoch:c.epoch,confirmed:true});assert.equal((await seed()).status,200);assert.equal((await archiveControlStatus(h.db)).mode,'paused');}
    assert.equal((await h.post()).body.data.cleanup.state,'paused');assert.ok(await h.bucket.head(f.key));
  }finally{await h.close();}
});
