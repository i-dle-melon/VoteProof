import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{DatabaseSync}from'node:sqlite';import{randomUUID}from'node:crypto';import{spawnSync}from'node:child_process';import{createRequire}from'node:module';
import{fixture}from'./helpers/prelaunch-reset-0028-fixture.mjs';
import{snapshotReset,installResetExtensionLocal,planSelectiveReset}from'../scripts/lib/prelaunch-selective-reset.mjs';
import{digest,stable}from'../scripts/lib/prelaunch-reset-snapshot.mjs';
import{prepareSimpleReset,executeSimpleReset,reconcileSimpleReset,simpleCLIIdentity}from'../scripts/lib/prelaunch-reset-simple.mjs';
const rehash=x=>{const{sha256,status,...b}=x;return{...b,sha256:digest(b),...(status?{status}:{})};};
test('frozen cloud proof binds the exact CLI and existing atomic transport without a Worker deployment',()=>{
 const proof=JSON.parse(fs.readFileSync('test/fixtures/reset-simple-sql-cloud-proof.json'));assert.equal(proof.cli_sha256,simpleCLIIdentity());assert.equal(proof.transport_proof_sha256,digest(JSON.parse(fs.readFileSync('test/fixtures/reset-rest-atomic-proof.json'))));for(const k of ['status','rollback','lost_ack','cleanup'])assert.equal(proof[k],'PASS');assert.equal(proof.resource_deleted,true);assert.equal(proof.operations.production_operations,0);assert.equal(proof.operations.worker_invocations,0);assert.equal(proof.automatic_resend,false);assert.equal(proof.original_unknown_journal_retained,true);assert.equal(proof.synthetic_members,20);assert.equal(proof.synthetic_cases,177);assert.ok(proof.reset_body_bytes<=2000000);assert.equal(proof.database_name.startsWith('voteproof-test-simple-reset-'),true);assert.ok(Object.values(proof.evidence_sha256.http).every(h=>/^[a-f0-9]{64}$/.test(h)));
});
async function setup(t,{large=false}={}){
 const f=await fixture();t.after(()=>f.close());f.insert('storage_audit',{id:'synthetic-history-first',created_at:1,action:'inventory',target:'synthetic',detail:'PRESERVED_HISTORY_NOT_IN_RESET_BODY'});
 if(large){f.db.exec('BEGIN; UPDATE submission_settings SET submissions_enabled=1 WHERE id=1');
  const m=f.db.prepare('SELECT * FROM members LIMIT 1').get();for(let i=2;i<20;i++)f.insert('members',{...m,id:'member-'+i,member_id:'SYN-'+i,login_name:'syn-login-'+i,nickname:'合成 '+i,player_id:'FAN-SYN-'+i});
  const c=f.db.prepare('SELECT * FROM cases LIMIT 1').get(),cf=f.db.prepare('SELECT * FROM case_files WHERE case_id=?').get(c.id),cu=f.db.prepare('SELECT * FROM completed_uploads LIMIT 1').get(),uf=f.db.prepare('SELECT * FROM completed_upload_files LIMIT 1').get();
  for(let i=2;i<177;i++){const sid='syn-session-'+i,k='proofs/staging/syn-'+i+'.png';f.insert('completed_uploads',{...cu,session_id:sid});f.insert('completed_upload_files',{...uf,session_id:sid,object_key:k});f.insert('cases',{...c,id:'syn-case-'+i,case_id:'SYN-CASE-'+i,upload_session_id:sid});f.insert('case_files',{...cf,id:'syn-file-'+i,case_id:'syn-case-'+i,object_key:'proofs/cases/syn-'+i+'.png',upload_object_key:k});}
  for(let i=0;i<5000;i++){f.insert('storage_history',{id:'history-'+i,created_at:i,bytes:i,reserved_bytes:0,object_count:216,staging_bytes:0,other_bytes:0,anomaly:null});f.insert('drive_quota_snapshots',{id:'quota-'+i,observed_at:i,received_at:i,total_bytes:15000000000,used_bytes:i,state:'known'});}
  f.db.exec('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1; COMMIT');}
 installResetExtensionLocal(f.db,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));f.db.prepare('UPDATE prelaunch_reset_control SET run_id=?').run(randomUUID());
 const s=snapshotReset(f.db),m=planSelectiveReset(s,undefined,{legacy_io:'LOCAL_SYNTHETIC_ALL_INVOCATIONS_ENDED',image_bypass_closed:true});assert.deepEqual(m.blockers,[]);
 const artifact=f.root+'/simple-recovery.sqlite';f.db.prepare('VACUUM INTO ?').run(artifact);const restored=new DatabaseSync(artifact,{readOnly:true});assert.equal(snapshotReset(restored).hash,s.hash);restored.close();
 const recovery={platform:'native-synthetic',artifact_path:artifact,artifact_sha256:digest(fs.readFileSync(artifact)),source_hash:s.hash,restored_source_hash:s.hash,account:'local-synthetic',source_database:'local-synthetic',created_utc:new Date().toISOString(),restore_receipt_sha256:digest('local-restored')};
 const p=prepareSimpleReset(s,m,{approvedManifestHash:m.sha256,recovery}),journal=f.root+'/simple-journal.jsonl';let writes=0,reads=0;
 const o={approvedPreparedHash:p.sha256,approvedManifestHash:p.manifest_sha256,mode:'local-synthetic',journalFile:journal};
 const transport=({lostACK=false,fault=()=>null,badReceipt=false,badProtected=false}={})=>({kind:'local-synthetic-rest',async query(ss){
  if(ss===p.statements){writes++;assert.equal(JSON.parse(fs.readFileSync(journal,'utf8').split('\n')[0]).status,'DISPATCHED');f.db.exec('BEGIN IMMEDIATE');let result;
   try{result=ss.map((raw,i)=>{const q=fault(raw,i,f.db)||raw;return{success:true,results:f.db.prepare(q.sql).all(...q.params)};});f.db.exec('COMMIT');}catch(e){f.db.exec('ROLLBACK');throw e;}if(lostACK)throw Error('SYNTHETIC_LOST_ACK');return result;
  }
  reads++;assert.ok(ss.every(x=>/^SELECT\b/i.test(x.sql)));const r=ss.map(q=>({success:true,results:f.db.prepare(q.sql).all(...q.params)}));if(badReceipt&&ss.length===2)r[1].results=[];
  if(badProtected&&writes&&ss.some(q=>q.sql==='SELECT * FROM "members"')){const i=ss.findIndex(q=>q.sql==='SELECT * FROM "members"');r[i].results[0]={...r[i].results[0],nickname:'SYNTHETIC_BAD_READ'};}return r;
 }});
 return{f,s,m,p,recovery,o,journal,transport,get writes(){return writes;},get reads(){return reads;}};
}
function normalMutation(f,sql){const c=f.db.prepare('SELECT * FROM prelaunch_reset_control').get(),id=randomUUID();f.db.exec('BEGIN IMMEDIATE');try{f.db.exec("UPDATE prelaunch_reset_control SET mode='open'");f.db.prepare("INSERT INTO prelaunch_reset_operations(id,epoch,state,started_at) VALUES(?,?,'active','synthetic')").run(id,c.epoch);f.db.prepare("INSERT INTO prelaunch_reset_permit VALUES(1,?,?,'normal','{}',NULL)").run(c.epoch,id);f.db.exec(sql);f.db.exec('DELETE FROM prelaunch_reset_permit');f.db.prepare("UPDATE prelaunch_reset_operations SET state='completed',ended_at='synthetic' WHERE id=?").run(id);f.db.exec("UPDATE prelaunch_reset_control SET mode='maintenance'; COMMIT");}catch(e){f.db.exec('ROLLBACK');throw e;}}
test('simple CLI defaults dry-run, uses one variable-size atomic batch and preserves all members/settings',async t=>{
 const x=await setup(t);assert.equal((await executeSimpleReset(x.p,{...x.o,mode:'dry-run'})).status,'DRY_RUN');assert.equal(x.writes,0);assert.equal(x.p.transaction_count,1);assert.equal(x.p.split_batches,false);assert.ok(x.p.statement_count<48);
 assert.equal((await executeSimpleReset(x.p,{...x.o,transport:x.transport()})).status,'COMMIT_VERIFIED');const after=snapshotReset(x.f.db);
 for(const n of Object.keys(x.p.protected_before))assert.deepEqual(after.tables[n],x.s.tables[n]);for(const n of ['cases','case_files','point_transactions','leaderboard_runs','leaderboard_results'])assert.equal(after.tables[n].length,0);
 assert.deepEqual(after.schema,x.s.schema);assert.deepEqual(after.tables.storage_history,x.s.tables.storage_history);assert.deepEqual(after.tables.drive_quota_snapshots,x.s.tables.drive_quota_snapshots);assert.equal(after.tables.prelaunch_reset_permit.length,0);assert.equal(after.tables.admin_audit_logs.length,1);assert.equal(after.tables.prelaunch_reset_retired_keys.length,x.m.keys.length);assert.equal(x.writes,1);
 assert.throws(()=>x.f.db.exec('DELETE FROM prelaunch_reset_audit'),/IMMUTABLE/);
});
for(const variant of ['cell','extra-row','schema','unknown-operation'])test(variant+' source change is refused inside the transaction',async t=>{
 const x=await setup(t);
 if(variant==='cell')normalMutation(x.f,"UPDATE cases SET nickname='changed' WHERE id='case-0'");
 if(variant==='extra-row')normalMutation(x.f,"INSERT INTO point_transactions(transaction_id,created_at,member_id,category,points,reason,created_by,idempotency_hash,request_hash) VALUES('extra','2026-01-01','M-local','manual_adjustment',1,'Synthetic','M-operator',printf('%064d',2),printf('%064d',3))");
 if(variant==='schema')x.f.db.exec('CREATE INDEX synthetic_late_index ON cases(id)');
 if(variant==='unknown-operation')x.f.db.exec("INSERT INTO prelaunch_reset_operations(id,epoch,state,started_at) VALUES('unknown-operation',0,'unknown','synthetic')");
 const before=snapshotReset(x.f.db).hash;await assert.rejects(executeSimpleReset(x.p,{...x.o,transport:x.transport()}),/UNKNOWN_STOP/);assert.equal(snapshotReset(x.f.db).hash,before);assert.equal(x.writes,1);
});
test('protected-data change stops BEFORE dispatch; forged Manifest cannot include members',async t=>{
 const x=await setup(t);normalMutation(x.f,"UPDATE members SET nickname='changed' WHERE member_id='M-local'");await assert.rejects(executeSimpleReset(x.p,{...x.o,transport:x.transport()}),/PROTECTED_IDENTITY_OR_SETTINGS_CHANGED/);assert.equal(x.writes,0);assert.equal(fs.existsSync(x.journal),false);
 const bad=rehash({...x.m,selected:{...x.m.selected,members:x.s.tables.members}});assert.throws(()=>prepareSimpleReset(x.s,bad,{approvedManifestHash:bad.sha256,recovery:x.recovery}),/SCOPE_OR_FK_CLOSURE_CHANGED/);
});
for(const kind of ['DDL','immutable','FK','out-of-scope','missing-delete'])test(kind+' failure rolls back cells, Guard DDL, Epoch and Receipt',async t=>{
 const x=await setup(t),tr=x.transport({fault:(q,i)=>{
  if(kind==='DDL'&&/^CREATE TRIGGER /.test(q.sql))return{sql:'CREATE TRIGGER bad AFTER DELETE ON missing_table BEGIN SELECT 1; END',params:[]};
  if(kind==='immutable'&&/^INSERT INTO storage_audit/.test(q.sql))return{sql:'DELETE FROM storage_audit',params:[]};
  if(kind==='FK'&&/^INSERT INTO prelaunch_reset_retired_keys/.test(q.sql)){const z=structuredClone(q);z.params[1]='missing-parent';return z;}
  if(kind==='out-of-scope'&&/^DELETE FROM "cases"/.test(q.sql))return{sql:"DELETE FROM members WHERE member_id='M-local'",params:[]};
  if(kind==='missing-delete'&&/^DELETE FROM "cases"/.test(q.sql))return{sql:'SELECT 1',params:[]};
 }});await assert.rejects(executeSimpleReset(x.p,{...x.o,transport:tr}),/UNKNOWN_STOP/);assert.equal(snapshotReset(x.f.db).hash,x.s.hash);await assert.rejects(executeSimpleReset(x.p,{...x.o,transport:tr}),/EXISTING_JOURNAL/);assert.equal(x.writes,1);
});
test('successful commit/lost ACK never resends; independent SELECT-only receipt reconciliation',async t=>{
 const x=await setup(t),tr=x.transport({lostACK:true});await assert.rejects(executeSimpleReset(x.p,{...x.o,transport:tr}),/UNKNOWN_STOP/);const original=fs.readFileSync(x.journal);await assert.rejects(executeSimpleReset(x.p,{...x.o,transport:tr}),/EXISTING_JOURNAL/);assert.equal((await reconcileSimpleReset(x.p,{...x.o,transport:tr})).status,'COMMIT_VERIFIED');assert.deepEqual(fs.readFileSync(x.journal),original);assert.equal(x.writes,1);
});
test('missing Receipt or failed post-member read remains UNKNOWN despite HTTP success',async t=>{
 for(const option of [{badReceipt:true},{badProtected:true}]){const x=await setup(t);await assert.rejects(executeSimpleReset(x.p,{...x.o,transport:x.transport(option)}),/UNKNOWN_STOP/);assert.equal(JSON.parse(fs.readFileSync(x.journal,'utf8').trim().split('\n').at(-1)).status,'UNKNOWN');assert.equal(x.writes,1);}
});
test('no Production execute without fresh exact approval/proof; one-command dry-run reads no credential',async t=>{
 const x=await setup(t);await assert.rejects(executeSimpleReset(x.p,{...x.o,mode:'execute',transport:{kind:'cloudflare-rest',query(){throw Error('MUST_NOT_SEND');}}}),/EXPLICIT_SIMPLE_PRODUCTION_AUTHORITY_REQUIRED/);assert.equal(fs.existsSync(x.journal),false);
 const plan=x.f.root+'/plan.private.json',pack=x.f.root+'/pack.private.json';fs.writeFileSync(plan,JSON.stringify(x.p));fs.writeFileSync(pack,JSON.stringify({prepared_file:plan,approved_prepared_sha256:x.p.sha256,approved_manifest_sha256:x.p.manifest_sha256}));const r=spawnSync(process.execPath,['scripts/prelaunch-reset-simple.mjs','--package',pack],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'DRY_RUN');assert.equal(x.writes,0);
});
test('large history stays out of payload; local D1 binding costs only the new simple execution',async t=>{
 const x=await setup(t,{large:true});assert.equal(x.s.tables.members.length,20);assert.equal(x.s.tables.cases.length,177);const body=JSON.stringify({batch:x.p.statements}),guardData=JSON.parse(x.p.statements[1].params[0]);assert.ok(!body.includes('PRESERVED_HISTORY_NOT_IN_RESET_BODY'));assert.equal(Object.hasOwn(guardData,'storage_history'),false);assert.equal(Object.hasOwn(guardData,'drive_quota_snapshots'),false);assert.equal(Object.hasOwn(guardData,'members'),false);assert.ok(x.p.body_bytes<2000000);
 const require=createRequire(import.meta.url),{Miniflare,convertV4MiniflareOptions}=require('miniflare'),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("local")}}',d1Databases:['LOCAL'],compatibilityDate:'2026-10-13'}));
 try{const db=await mf.getD1Database('LOCAL');const batch=ss=>db.batch(ss.map(q=>db.prepare(q.sql).bind(...q.params)));for(const type of ['table','index'])for(const z of x.s.schema.filter(s=>s.type===type))await db.prepare(z.sql).run();
  await batch([{sql:'PRAGMA defer_foreign_keys=ON',params:[]},...Object.entries(x.s.tables).filter(([,rs])=>rs.length).map(([n,rs])=>{const fields=Object.keys(rs[0]);return{sql:`INSERT INTO "${n}"(${fields.map(f=>'"'+f+'"').join(',')}) SELECT ${fields.map(f=>`json_extract(value,'$.${f}')`).join(',')} FROM json_each(?)`,params:[JSON.stringify(rs)]};})]);
  for(const z of x.s.schema.filter(s=>s.type==='trigger'))await db.prepare(z.sql).run();let reads=0,writes=0,queries=0;
  const tr={kind:'local-synthetic-rest',async query(ss){queries++;const r=await batch(ss.map(q=>({...q,sql:q.sql.replaceAll("name<>'_cf_KV'","name<>'_cf_KV' AND name<>'_cf_METADATA'")})));for(const v of r){reads+=v.meta.rows_read??0;writes+=v.meta.rows_written??0;}return r;}};
  assert.equal((await executeSimpleReset(x.p,{...x.o,transport:tr})).status,'COMMIT_VERIFIED');t.diagnostic(JSON.stringify({scope:'LOCAL_D1_COUNTERS_NOT_CLOUD_CPU',normalization:'Cost probe excludes local private _cf_METADATA; executable SQL is unchanged',members:20,cases:177,history_rows:5000,quota_rows:5000,body_bytes:x.p.body_bytes,statements:x.p.statement_count,request_trips:queries,rows_read:reads,rows_written:writes}));
 }finally{await mf.dispose();}
});
