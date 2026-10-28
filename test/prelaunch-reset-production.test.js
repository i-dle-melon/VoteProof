import test from 'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{DatabaseSync}from'node:sqlite';import{randomUUID}from'node:crypto';import{spawnSync}from'node:child_process';
import{proofKey}from'../src/lib/proof-generation.js';
import{fixture}from'./helpers/prelaunch-reset-0028-fixture.mjs';import{installResetExtensionLocal,snapshotReset,planSelectiveReset}from'../scripts/lib/prelaunch-selective-reset.mjs';
import{digest,stable}from'../scripts/lib/prelaunch-reset-snapshot.mjs';import{prepareAtomicReset,executePreparedReset}from'../scripts/lib/prelaunch-reset-production.mjs';
const sql=fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8');
async function setup(t){
 const f=await fixture();t.after(()=>f.close());installResetExtensionLocal(f.db,sql);f.db.prepare('UPDATE prelaunch_reset_control SET run_id=?').run(randomUUID());
 const snapshot=snapshotReset(f.db),manifest=planSelectiveReset(snapshot,undefined,{legacy_io:'LOCAL_SYNTHETIC_ALL_INVOCATIONS_ENDED',image_bypass_closed:true});assert.deepEqual(manifest.blockers,[]);
 const backup=f.root+'/recovery.sqlite.snapshot';f.db.prepare('VACUUM INTO ?').run(backup);const restored=new DatabaseSync(backup,{readOnly:true});const restoredHash=snapshotReset(restored).hash;restored.close();assert.equal(restoredHash,snapshot.hash);
 const recovery={platform:'native-synthetic',artifact_path:backup,artifact_sha256:digest(fs.readFileSync(backup)),source_hash:snapshot.hash,restored_source_hash:restoredHash,source_database:'local-synthetic-db',account:'local-synthetic-account',created_utc:new Date().toISOString(),restore_receipt_sha256:digest({native:true,restoredHash})};
 const prepare=()=>prepareAtomicReset(snapshot,manifest,{approvedManifestHash:manifest.sha256,recovery});return{...f,snapshot,manifest,recovery,prepare};
}
function nativeTransport(db,{lostACK=false,failAt=-1}={}){let calls=0;return{kind:'native-synthetic',get calls(){return calls;},async batch(statements){calls++;db.exec('BEGIN IMMEDIATE');let result;
 try{result=statements.map((s,i)=>{if(i===failAt)db.exec("SELECT json_extract('SYNTHETIC_TRIGGER_FAILURE','$')");return db.prepare(s.sql).all(...s.params);});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 if(lostACK)throw Error('SYNTHETIC_ACK_LOST_AFTER_COMMIT');return result;}};}
const run=(f,p,transport,journal='execution-journal.json')=>executePreparedReset(p,{mode:'execute-native-synthetic',authority:'LOCAL_SYNTHETIC_ONLY',transport,journalFile:f.root+'/'+journal});

test('prepared executor defaults dry-run; exact Manifest and real private restore bytes are required',async t=>{
 const f=await setup(t),prepared=f.prepare(),before=snapshotReset(f.db).hash;const dry=await executePreparedReset(prepared);
 assert.equal(dry.status,'DRY_RUN');assert.equal(prepared.transaction_count,1);assert.equal(prepared.split_batches,false);assert.equal(prepared.statement_count,48);assert.equal(snapshotReset(f.db).hash,before);
 assert.ok(prepared.holds.includes('CLOUD_D1_ATOMIC_DDL_ROLLBACK_NOT_PROVEN'));
 assert.throws(()=>prepareAtomicReset(f.snapshot,f.manifest,{approvedManifestHash:'0'.repeat(64),recovery:f.recovery}),/EXACT_APPROVED/);
 fs.appendFileSync(f.recovery.artifact_path,'synthetic-corruption');assert.throws(()=>f.prepare(),/RESTORE_POINT_HASH/);
});
test('one native atomic batch preserves full identity/config, restores all Guard SQL and retires old keys',async t=>{
 const f=await setup(t),p=f.prepare(),transport=nativeTransport(f.db),result=await run(f,p,transport);assert.equal(result.status,'NATIVE_COMMITTED');assert.equal(transport.calls,1);
 const after=snapshotReset(f.db);for(const n of ['members','auth_identities','member_credentials','admin_memberships','storage_capacity'])assert.deepEqual(after.tables[n],f.snapshot.tables[n]);
 for(const n of ['cases','case_files','point_transactions','leaderboard_runs','leaderboard_results'])assert.equal(after.tables[n].length,0);
 assert.deepEqual(after.schema,f.snapshot.schema);assert.equal(after.tables.prelaunch_reset_retired_keys.length,f.manifest.keys.length);assert.equal(after.tables.prelaunch_reset_control[0].epoch,1);
 assert.equal(after.tables.submission_settings[0].submissions_enabled,0);assert.equal(f.stores.r2.list().length,7);
});
test('failure after DDL Guard exceptions rolls back every original trigger and row; journal cannot resend',async t=>{
 const f=await setup(t),p=f.prepare(),transport=nativeTransport(f.db,{failAt:34});await assert.rejects(run(f,p,transport),/RESET_ACK_UNKNOWN/);
 assert.equal(snapshotReset(f.db).hash,f.snapshot.hash);assert.equal(JSON.parse(fs.readFileSync(f.root+'/execution-journal.json')).status,'UNKNOWN');
 await assert.rejects(run(f,p,transport),/EXISTING_JOURNAL/);assert.equal(transport.calls,1);
});
test('source changed after planning is rejected inside the same transaction before Guard removal',async t=>{
 const f=await setup(t),p=f.prepare();f.db.exec('UPDATE prelaunch_reset_control SET version=version+1');const before=snapshotReset(f.db).hash;
 await assert.rejects(run(f,p,nativeTransport(f.db)),/RESET_ACK_UNKNOWN/);assert.equal(snapshotReset(f.db).hash,before);
});
test('commit with lost ACK is retained UNKNOWN; no automatic rollback, retry or reopen',async t=>{
 const f=await setup(t),p=f.prepare(),transport=nativeTransport(f.db,{lostACK:true});await assert.rejects(run(f,p,transport),/RESET_ACK_UNKNOWN/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cases').get().n,0);assert.equal(f.db.prepare('SELECT mode FROM prelaunch_reset_control').get().mode,'maintenance');
 await assert.rejects(run(f,p,transport),/EXISTING_JOURNAL/);assert.equal(transport.calls,1);
});
test('Production execution stays HOLD, CLI cannot dispatch, and old unfenced D1 writes are rejected',async t=>{
 const f=await setup(t),p=f.prepare();await assert.rejects(executePreparedReset(p,{mode:'execute',authority:'PRODUCTION'}),/PRODUCTION_EXECUTION_HOLD/);
 const r=spawnSync(process.execPath,['scripts/prelaunch-reset-production.mjs','--execute'],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/PRODUCTION_EXECUTION_HOLD/);
 assert.throws(()=>f.db.prepare("INSERT INTO completed_uploads(session_id,manifest_hash,completed_at,expires_at) VALUES('late-old-session',?,'now','later')").run('a'.repeat(64)),/PRELAUNCH_WRITE_FENCED/);
 assert.equal(snapshotReset(f.db).hash,f.snapshot.hash);
});
test('current private-copy constructor uses the trusted generation instead of the old shared namespace',()=>{
 const current=fs.readFileSync('src/lib/case-files.js','utf8');
 assert.equal(proofKey({},'cases','same-id.png'),'proofs/cases/same-id.png');
 assert.equal(proofKey({PRELAUNCH_RESET_FENCE_ENABLED:'true',PRELAUNCH_RESET_CONTEXT:{epoch:1}},'cases','same-id.png'),'proofs/cases/g1/same-id.png');
 assert.match(current,/const key = proofKey\(env,'cases',/);
});
