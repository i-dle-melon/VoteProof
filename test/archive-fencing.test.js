import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {archiveCanaryRuntime} from './helpers/archive-canary-runtime.mjs';
import {localWriterEvidence,interceptBatch} from './helpers/archive-fence-fixture.mjs';
import {archiveControlStatus,changeArchiveControl} from '../src/lib/archive-fencing.js';
import {cleanupArchive,reconcileArchiveDispatch} from '../src/lib/storage-archive.js';
import {capacityPut,inventoryPage} from '../src/lib/storage-capacity.js';
import {randomUUID} from 'node:crypto';
let h;
beforeEach(async()=>{h=await archiveCanaryRuntime();});afterEach(async()=>{await h?.close();});
const env=(changes={})=>({...h.bindings,DB:h.db,PROOFS_BUCKET:h.bucket,...changes});
const result=r=>r.body.data.cleanup;
const pause=async()=>changeArchiveControl(h.db,{action:'pause',expected_epoch:(await archiveControlStatus(h.db)).epoch,confirmed:true});
const settle=async()=>changeArchiveControl(h.db,{action:'settle',expected_epoch:(await archiveControlStatus(h.db)).epoch,confirmed:true});
test('default migration is paused; missing schema and unknown writer evidence fail closed',async()=>{
  assert.equal((await archiveControlStatus(h.db)).drained,true);
  assert.equal(result(await h.post({canary:true})).state,'paused');
  const c=await archiveControlStatus(h.db);
  for(const writer_evidence of [undefined,{...localWriterEvidence(),checks:{}},{...localWriterEvidence(),verified_until:0}])await assert.rejects(changeArchiveControl(h.db,{action:'resume',expected_epoch:c.epoch,confirmed:true,writer_evidence}));
  const noSchema={prepare:()=>({first:()=>Promise.reject(Error('no such table'))})};let deletes=0;
  assert.equal((await cleanupArchive(env({DB:noSchema,PROOFS_BUCKET:{delete:()=>{deletes++;}}}),{verifyOnly:true})).deleted,0);assert.equal(deletes,0);
});
test('pause fences A/B and legacy endpoint; stale epoch cannot resume',async()=>{
  const f=await h.seed('pause'),a=result(await h.post({canary:true})),old=await archiveControlStatus(h.db);
  const c=await pause();assert.equal(c.drained,true);assert.equal(result(await h.post({canary:true,handoff:a.handoff})).state,'paused');assert.equal(result(await h.post({})).state,'legacy_disabled');
  await assert.rejects(changeArchiveControl(h.db,{action:'resume',expected_epoch:old.epoch,confirmed:true,writer_evidence:localWriterEvidence()}));assert.ok(await h.bucket.head(f.key));
  await changeArchiveControl(h.db,{action:'resume',expected_epoch:c.epoch,confirmed:true,writer_evidence:localWriterEvidence()});
  assert.equal(result(await h.post({canary:true,handoff:a.handoff})).deleted,0);assert.ok(await h.bucket.head(f.key));
  const fresh=result(await h.post({canary:true}));assert.notEqual(fresh.handoff,a.handoff);assert.equal(result(await h.post({canary:true,handoff:fresh.handoff})).state,'cold');
});
test('pause during Drive A prevents a ready handoff from being committed',async()=>{
  const f=await h.seed('pause-a');
  const a=await cleanupArchive(env(),{verifyOnly:true,read:async(_env,row,sha)=>{await pause();return{sha256:sha,verified_at:Math.floor(Date.now()/1000)};}});
  assert.equal(a.state,'blocked');assert.ok(await h.bucket.head(f.key));assert.equal(a.handoff,undefined);assert.equal((await archiveControlStatus(h.db)).drained,true);
});
test('pause after final HEAD but before dispatch CAS prevents native DELETE',async()=>{
  const f=await h.seed('pause-gap'),a=result(await h.post());let heads=0,deletes=0;
  const bucket={head:async key=>{const obj=await h.bucket.head(key);if(++heads===2)await pause();return obj;},delete:async()=>{deletes++;}};
  const b=await cleanupArchive(env({PROOFS_BUCKET:bucket}),{handoff:a.handoff});assert.equal(b.state,'blocked');assert.equal(deletes,0);assert.ok(await h.bucket.head(f.key));
  assert.equal((await archiveControlStatus(h.db)).dispatches,0);assert.equal((await settle()).drained,true);
});
test('pause after dispatch is DRAINING until admitted DELETE and terminal commit finish',async()=>{
  const f=await h.seed('inflight'),a=result(await h.post());let enter,release;
  const entered=new Promise(r=>{enter=r;}),wait=new Promise(r=>{release=r;});
  const task=cleanupArchive(env({PROOFS_BUCKET:{head:key=>h.bucket.head(key),delete:async key=>{enter();await wait;return h.bucket.delete(key);}}}),{handoff:a.handoff});
  try{
    await entered;const c=await pause();assert.equal(c.mode,'draining');assert.equal(c.drained,false);assert.equal(c.dispatches,1);
    await assert.rejects(settle());assert.equal(result(await h.post()).state,'paused');
  }finally{release();}
  assert.equal((await task).state,'cold');assert.equal((await settle()).drained,true);assert.equal(await h.bucket.head(f.key),null);
});
for(const fault of ['dispatch-ack-lost','delete-before','delete-ack-lost','terminal-before','terminal-ack-lost'])test('durable failure handling: '+fault,async()=>{
  const f=await h.seed(fault),a=result(await h.post());let deletes=0;
  const db=fault==='dispatch-ack-lost'?interceptBatch(h.db,'INSERT INTO storage_archive_dispatches',{after:true}):fault.startsWith('terminal-')?interceptBatch(h.db,"UPDATE cold_proofs SET state='cold'",{after:fault==='terminal-ack-lost'}):h.db;
  const bucket={head:key=>h.bucket.head(key),delete:async key=>{if(fault==='delete-before')throw Error('before');deletes++;await h.bucket.delete(key);if(fault==='delete-ack-lost')throw Error('ack lost');}};
  const b=await cleanupArchive(env({DB:db,PROOFS_BUCKET:bucket}),{handoff:a.handoff});assert.equal(b.state,'delete_ambiguous');assert.equal(deletes,['dispatch-ack-lost','delete-before'].includes(fault)?0:1);
  const c=await archiveControlStatus(h.db);assert.notEqual(c.mode,'running');
  if(fault==='terminal-ack-lost'){assert.equal(c.drained,true);assert.equal(await h.db.prepare('SELECT state FROM cold_proofs WHERE file_id=?').bind(f.file).first('state'),'cold');}
  else{
    assert.equal(c.drained,false);assert.equal(c.dispatches,1);
    await h.db.prepare('UPDATE cold_proofs SET lease_until=0,verified_at=0 WHERE file_id=?').bind(f.file).run();
    assert.equal(result(await h.post()).deleted,0);assert.equal(result(await h.post({canary:true,handoff:a.handoff})).deleted,0);assert.equal(result(await h.post({})).deleted,0);
    await assert.rejects(settle());await assert.rejects(changeArchiveControl(h.db,{action:'resume',expected_epoch:c.epoch,confirmed:true,writer_evidence:localWriterEvidence()}));
  }
  const audit=await h.db.prepare("SELECT count(*) n FROM storage_audit WHERE target=? AND action='archive_r2_deleted'").bind(f.file).first('n');assert.equal(audit,fault==='terminal-ack-lost'?1:0);
});
test('a durable outstanding dispatch blocks all cleanup even if automatic pause write fails',async()=>{
  const f=await h.seed('pause-write-failure'),a=result(await h.post());
  const db=interceptBatch(h.db,"UPDATE storage_archive_control SET mode=CASE");
  const b=await cleanupArchive(env({DB:db,PROOFS_BUCKET:{head:k=>h.bucket.head(k),delete:async()=>{throw Error('uncertain');}}}),{handoff:a.handoff});
  assert.equal(b.state,'delete_ambiguous');assert.equal((await archiveControlStatus(h.db)).dispatches,1);assert.equal(result(await h.post()).state,'paused');
});
test('all capacity PUT options are forced create-only; historical cold key cannot be recreated',async()=>{
  const f=await h.seed('no-overwrite'),original=await h.bucket.head(f.key);
  await h.db.prepare('UPDATE storage_capacity SET used_bytes=100,cleanup_requested=0 WHERE id=1').run();
  const put=await capacityPut(env(),f.key,new Uint8Array([2,3,4]),{onlyIf:{etagMatches:original.etag},httpMetadata:{contentType:'image/png'}},3);
  assert.equal(put,null);assert.equal((await h.bucket.head(f.key)).version,original.version);
  assert.equal(await h.db.prepare('SELECT reserved_bytes FROM storage_capacity').first('reserved_bytes'),0);
  await h.db.prepare('UPDATE storage_capacity SET used_bytes=9000000000,cleanup_requested=1 WHERE id=1').run();
  const a=result(await h.post()),b=result(await h.post({canary:true,handoff:a.handoff}));assert.equal(b.state,'cold');
  await assert.rejects(capacityPut(env(),f.key,new Uint8Array([1]),{},1),e=>e.code==='R2_STORAGE_CAPACITY_EXCEEDED'&&e.noWrite===true);assert.equal(await h.bucket.head(f.key),null);
});
test('cooperating PUT in HEAD/DELETE gap cannot replace bytes; unknown external writer prevents admission',async()=>{
  const f=await h.seed('protected-gap'),a=result(await h.post());let blocked=0;
  const b=await cleanupArchive(env({PROOFS_BUCKET:{head:k=>h.bucket.head(k),delete:async key=>{await assert.rejects(capacityPut(env(),key,new Uint8Array([8]),{},1));blocked++;return h.bucket.delete(key);}}}),{handoff:a.handoff});
  assert.equal(b.state,'cold');assert.equal(blocked,1);
  await pause();const c=await archiveControlStatus(h.db),e=localWriterEvidence();e.checks.s3_credentials=false;
  await assert.rejects(changeArchiveControl(h.db,{action:'resume',expected_epoch:c.epoch,confirmed:true,writer_evidence:e}));
});
test('pause does not stop pure inventory or Drive quota snapshots; audit remains immutable',async()=>{
  await h.seed('inventory');await pause();const inv=await inventoryPage(env());assert.equal(inv.complete,true);
  const path='/api/internal/drive-backup/storage/quota';
  const r=await h.runtime.dispatchFetch(h.origin+path,{method:'POST',headers:{Authorization:'Bearer '+h.secret,'Content-Type':'application/json'},body:JSON.stringify({id:randomUUID(),observed_at:Math.floor(Date.now()/1000),state:'known',total_bytes:100,used_bytes:1})});assert.equal(r.status,200);
  await assert.rejects(h.db.prepare("UPDATE storage_audit SET action='tamper'").run());await assert.rejects(h.db.prepare('DELETE FROM storage_archive_control').run());
});
for(const present of [true,false])test('explicit operator reconciliation revalidates Drive and preserves evidence: R2 present='+present,async()=>{
  const f=await h.seed('reconcile'),a=result(await h.post());
  const b=await cleanupArchive(env({PROOFS_BUCKET:{head:k=>h.bucket.head(k),delete:async key=>{if(!present)await h.bucket.delete(key);throw Error('unknown');}}}),{handoff:a.handoff});assert.equal(b.state,'delete_ambiguous');
  const c=await archiveControlStatus(h.db),token=await h.db.prepare('SELECT token FROM storage_archive_dispatches WHERE file_id=?').bind(f.file).first('token');
  const input={token,expected_epoch:c.epoch,confirmed:true,invocation_finished:true,invocation_evidence_hash:'b'.repeat(64),writer_evidence:localWriterEvidence()};
  const read=async(_e,row,sha)=>({sha256:sha,verified_at:Math.floor(Date.now()/1000)});
  await assert.rejects(reconcileArchiveDispatch(env(),{...input,invocation_finished:false},{read}));
  await assert.rejects(reconcileArchiveDispatch(env(),input,{read:async()=>({sha256:'0'.repeat(64),verified_at:Math.floor(Date.now()/1000)})}));
  assert.equal((await archiveControlStatus(h.db)).drained,false);
  const fixed=await reconcileArchiveDispatch(env(),input,{read});assert.equal(fixed.state,present?'dispatch_abandoned':'cold_reconciled');assert.equal(fixed.deleted,0);
  assert.equal((await settle()).drained,true);
  assert.equal(await h.db.prepare("SELECT count(*) n FROM storage_audit WHERE action='archive_r2_deleted' AND target=?").bind(f.file).first('n'),present?0:1);
  assert.equal((await h.db.prepare('SELECT state FROM storage_archive_dispatches WHERE token=?').bind(token).first()).state,'completed');
});
test('expired writer evidence and unresolved legacy deleting pins prevent admission',async()=>{
  const f=await h.seed('expired-evidence'),real=Date.now;
  try{Date.now=()=>real()+601000;assert.equal((await cleanupArchive(env(),{verifyOnly:true})).state,'paused');}
  finally{Date.now=real;}
  assert.ok(await h.bucket.head(f.key));
  const a=result(await h.post());await h.db.prepare("UPDATE cold_proofs SET state='deleting',lease_until=0 WHERE file_id=?").bind(f.file).run();
  assert.equal(result(await h.post({canary:true,handoff:a.handoff})).state,'paused');assert.equal((await pause()).drained,false);await assert.rejects(settle());
});
test('pending-dispatch queries use partial indexes without walking completed history',async()=>{
  const plan=(await h.db.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM storage_archive_dispatches WHERE state!='completed'").all()).results;
  assert.ok(plan.some(r=>/archive_dispatch_pending/.test(r.detail)));console.log(JSON.stringify({pending_query_plan:plan.map(p=>p.detail),historical_dispatches_scanned:0,scope:'SQL partial-index plan, not cloud measurements'}));
});
