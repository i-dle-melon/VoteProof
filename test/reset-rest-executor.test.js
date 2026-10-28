import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{randomUUID}from'node:crypto';import{spawnSync}from'node:child_process';
import{fixture}from'./helpers/prelaunch-reset-0028-fixture.mjs';import{digest}from'../scripts/lib/prelaunch-reset-snapshot.mjs';import{snapshotReset,planSelectiveReset,installResetExtensionLocal}from'../scripts/lib/prelaunch-selective-reset.mjs';import{prepareAtomicReset}from'../scripts/lib/prelaunch-reset-production.mjs';
import{executeRestReset,reconcileRestJournal,createD1RestTransport}from'../scripts/lib/prelaunch-reset-rest.mjs';
const proof='test/fixtures/reset-rest-atomic-proof.json';
async function setup(t,{lostAck=false,badReceipt=false,ddlFail=false}={}){
 const f=await fixture();t.after(()=>f.close());installResetExtensionLocal(f.db,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));f.db.prepare('UPDATE prelaunch_reset_control SET run_id=?').run(randomUUID());const before=snapshotReset(f.db),manifest=planSelectiveReset(before,undefined,{legacy_io:'LOCAL_SYNTHETIC_ALL_INVOCATIONS_ENDED',image_bypass_closed:true});
 const artifact=f.root+'/backup.private.json';fs.writeFileSync(artifact,JSON.stringify(before));const p=prepareAtomicReset(before,manifest,{approvedManifestHash:manifest.sha256,recovery:{platform:'native-synthetic',artifact_path:artifact,artifact_sha256:digest(fs.readFileSync(artifact)),source_hash:before.hash,restored_source_hash:before.hash,account:'synthetic',source_database:'synthetic',created_utc:new Date().toISOString(),restore_receipt_sha256:digest('synthetic-only')}});
 let writes=0,reads=0;const file=f.root+'/journal.jsonl';
 const transport={kind:'local-synthetic-rest',async query(ss){
  if(ss.length===48){writes++;assert.equal(JSON.parse(fs.readFileSync(file,'utf8').trim().split('\n')[0]).status,'DISPATCHED');assert.deepEqual(ss,p.statements);f.db.exec('BEGIN IMMEDIATE');try{const result=ss.map((s,i)=>{if(ddlFail&&i===34)throw Error('SYNTHETIC_DDL_FAILURE');return{success:true,results:f.db.prepare(s.sql).all(...s.params)};});f.db.exec('COMMIT');if(lostAck)throw Error('SYNTHETIC_ACK_LOST');return result;}catch(e){try{f.db.exec('ROLLBACK');}catch{}throw e;}}
  reads++;const r=ss.map(s=>({success:true,results:f.db.prepare(s.sql).all(...s.params)}));if(badReceipt)r[3].results=[];return r;
 }};
 const options={approvedPreparedHash:p.sha256,approvedManifestHash:p.manifest_sha256,proofFile:proof,mode:'local-transport-test',transport,journalFile:file};
 return{f,p,before,manifest,file,options,get writes(){return writes;},get reads(){return reads;}};
}
test('REST executor defaults offline; exact proof/hash and new explicit Production authority are mandatory',async t=>{
 const x=await setup(t);assert.equal((await executeRestReset(x.p,{...x.options,mode:'dry-run'})).status,'DRY_RUN');assert.equal(x.writes,0);
 await assert.rejects(executeRestReset(x.p,{...x.options,approvedPreparedHash:'0'.repeat(64)}),/EXACT_PREPARED/);
 await assert.rejects(executeRestReset(x.p,{...x.options,proofFile:undefined}),/EXACT_REST_ATOMIC_PROOF/);
 await assert.rejects(executeRestReset(x.p,{...x.options,mode:'execute',authority:{scope:'isolated-only'}}),/PRODUCTION_RESET_AUTHORITY/);assert.equal(fs.existsSync(x.file),false);
 const sha='a'.repeat(40),authority={scope:'production-selective-reset-once',operation:'keep-members-no-r2-delete',prepared_sha256:x.p.sha256,manifest_sha256:x.p.manifest_sha256,account:x.p.account,database:x.p.database,operator_approval_reference:'synthetic-local-validation-only',expires_utc:new Date(Date.now()+60000).toISOString(),approved_release_sha:sha,ci_sha:sha,deployed_worker_sha:sha,reset_schema_sha256:'19054e1e954a03456b7e93052cc3f051f79817380828f35f607ebb5231e04cbe'};
 await assert.rejects(executeRestReset(x.p,{...x.options,mode:'execute',authority,manifest:x.manifest,transport:{...x.options.transport,kind:'cloudflare-rest',account:x.p.account,database:x.p.database}}),/FROZEN_REVIEWED_NON_SYNTHETIC_MANIFEST/);assert.equal(fs.existsSync(x.file),false);assert.equal(x.writes,0);
});
test('one REST batch plus readonly complete receipt preserves members; append-only Journal forbids repetition',async t=>{
 const x=await setup(t),r=await executeRestReset(x.p,x.options);assert.equal(r.status,'COMMIT_VERIFIED');assert.equal(x.writes,1);assert.equal(x.reads,1);const after=snapshotReset(x.f.db);assert.deepEqual(after.tables.members,x.before.tables.members);assert.deepEqual(after.tables.auth_identities,x.before.tables.auth_identities);assert.deepEqual(after.schema,x.before.schema);assert.equal(after.tables.cases.length,0);assert.equal(after.tables.point_transactions.length,0);
 const events=fs.readFileSync(x.file,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(events.map(x=>x.status),['DISPATCHED','COMMITTED']);await assert.rejects(executeRestReset(x.p,x.options),/EXISTING_JOURNAL/);assert.equal(x.writes,1);
});
test('lost ACK remains UNKNOWN, no automatic request; separate readonly reconciliation preserves original Journal',async t=>{
 const x=await setup(t,{lostAck:true});await assert.rejects(executeRestReset(x.p,x.options),/RESET_ACK_UNKNOWN/);assert.equal(x.writes,1);assert.equal(x.reads,0);const original=fs.readFileSync(x.file);await assert.rejects(executeRestReset(x.p,x.options),/EXISTING_JOURNAL/);assert.equal(x.writes,1);assert.equal((await reconcileRestJournal(x.p,x.options)).status,'COMMIT_VERIFIED');assert.deepEqual(fs.readFileSync(x.file),original);assert.equal(x.writes,1);
});
test('HTTP success without actual immutable receipt never becomes committed',async t=>{
 const x=await setup(t,{badReceipt:true});await assert.rejects(executeRestReset(x.p,x.options),/RESET_ACK_UNKNOWN/);assert.equal(x.writes,1);assert.equal(JSON.parse(fs.readFileSync(x.file,'utf8').trim().split('\n').at(-1)).status,'UNKNOWN');
});
test('local DDL fault rolls back and keeps Journal UNKNOWN without deleting original Guard',async t=>{
 const x=await setup(t,{ddlFail:true});await assert.rejects(executeRestReset(x.p,x.options),/RESET_ACK_UNKNOWN/);assert.equal(snapshotReset(x.f.db).hash,x.before.hash);assert.equal(x.writes,1);await assert.rejects(executeRestReset(x.p,x.options),/EXISTING_JOURNAL/);assert.equal(x.writes,1);
});
test('raw REST transport sends exactly one bound batch and does not retry HTTP/API/redirect failures',async()=>{
 let calls=0;const transport=createD1RestTransport({account:'a'.repeat(32),database:'11111111-1111-1111-1111-111111111111',credential:'synthetic-not-a-real-token',send:async(url,options)=>{calls++;assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{batch:[{sql:'SELECT ?',params:['合成']} ]});return Response.json({success:false,errors:[{code:7500}]},{status:400});}});
 await assert.rejects(transport.query([{sql:'SELECT ?',params:['合成']}]),/REST_RESPONSE_UNKNOWN/);assert.equal(calls,1);
});
test('one-command CLI dry-run needs no credential, cannot convert isolated approval to Production execution',async t=>{
 const x=await setup(t),prepared=x.f.root+'/plan.private.json',pack=x.f.root+'/package.private.json';fs.writeFileSync(prepared,JSON.stringify(x.p));fs.writeFileSync(pack,JSON.stringify({prepared_file:prepared,approved_prepared_sha256:x.p.sha256,approved_manifest_sha256:x.p.manifest_sha256,rest_atomic_proof_file:proof}));const r=spawnSync(process.execPath,['scripts/prelaunch-reset-rest.mjs','--package',pack],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'DRY_RUN');assert.equal(x.writes,0);
 const authority=x.f.root+'/isolated-approval.json';fs.writeFileSync(authority,JSON.stringify({scope:'isolated-only'}));const value=JSON.parse(fs.readFileSync(pack));value.authorization_file=authority;fs.writeFileSync(pack,JSON.stringify(value));const bad=spawnSync(process.execPath,['scripts/prelaunch-reset-rest.mjs','--package',pack,'--execute'],{encoding:'utf8'});assert.notEqual(bad.status,0);assert.match(bad.stderr,/NEW_EXPLICIT_OPERATOR_AUTHORIZATION/);assert.equal(x.writes,0);
});
