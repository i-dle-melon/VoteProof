import test from 'node:test';import assert from 'node:assert/strict';
import {legacyProofMetadata,proofStorageState} from '../src/lib/proof-storage-metadata.js';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {exportFilters,exportScope,countExport,snapshotExport} from '../src/lib/image-export.js';
test('only wholly pre-cold schemas can omit optional metadata',async()=>{
 let probes=0,legacy=0;const db={prepare:sql=>{assert.match(sql,/^SELECT name FROM sqlite_master/);return{first:async()=>{probes++;return null;}};}};
 assert.equal(await legacyProofMetadata(db,async()=>{throw Error('D1_ERROR: no such table: cold_proofs: SQLITE_ERROR');},()=>{legacy++;return 'old';}),'old');assert.equal(probes,1);assert.equal(legacy,1);
 assert.equal(await legacyProofMetadata(db,async()=>({state:'cold'}),()=>{throw Error('no fallback');}).then(r=>r.state),'cold');assert.equal(probes,1);
});
test('damaged current schema and uncertain D1 reads fail closed, without R2 access',async()=>{
 for(const name of['storage_capacity','storage_reservations','storage_audit','prelaunch_reset_control','manual_cleanup_cold_owner']){
  const error=Error('no such table: cold_proofs'),db={prepare:()=>({first:async()=>({name})})};
  await assert.rejects(legacyProofMetadata(db,async()=>{throw error;},()=>{throw Error('unsafe fallback');}),e=>e===error);
 }
 const error=Error('D1 read ACK unknown');await assert.rejects(legacyProofMetadata({prepare:()=>{throw Error('must not probe');}},async()=>{throw error;},()=>null),e=>e===error);
});
test('private proof state never suppresses a current-schema missing table',async()=>{
 const error=Error('no such table: cold_proofs');let query=0;
 const db={prepare:sql=>({bind:()=>({first:async()=>{query++;throw error;}}),first:async()=>({name:'storage_capacity'})})};
 await assert.rejects(proofStorageState(db,'synthetic-key'),e=>e===error);assert.equal(query,1);
});
test('legacy export remains usable but concurrent cold-schema installation aborts the complete snapshot',async t=>{
 const h=await localAdminRuntime({migrationThrough:'0019_solo_target_registry.sql'});t.after(()=>h.local.runtime.dispose());const db=h.local.db,owner=await h.identity({role:'super_admin'});
 await h.makeCase({member:owner,metadata:{campaign_id:'LEGACY-RACE'}});
 const scope=await exportScope(db,exportFilters({campaign_id:'LEGACY-RACE',entire_campaign:true,statuses:['pending'],vote_types:['Solo'],sources:['member']}));
 assert.equal((await countExport(db,scope)).image_count,1);
 const actor={member:{member_id:owner.memberId,tokenHash:owner.hash},role:'super_admin'};let batches=0;
 const raced={prepare:sql=>db.prepare(sql),batch:async statements=>{batches++;await db.prepare('CREATE TABLE storage_audit(synthetic_marker TEXT)').run();return db.batch(statements);}};
 await assert.rejects(snapshotExport(raced,actor,crypto.randomUUID(),scope),/CHECK constraint failed/);
 for(const table of['export_jobs','export_job_items','auth_atomic_guards'])assert.equal((await db.prepare('SELECT COUNT(*) n FROM '+table).first()).n,0);
 assert.equal(batches,1);assert.equal((await db.prepare('SELECT COUNT(*) n FROM cases').first()).n,1);
});
