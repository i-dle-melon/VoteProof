import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {randomUUID,createHash}from'node:crypto';
import {spawnSync}from'node:child_process';
import worker from '../src/index.js';
import {fencedRequest,resetControlRoute}from'../src/lib/prelaunch-reset-fence.js';
import {csrfToken,memberSession}from'../src/lib/auth-session.js';
import {embeddedCaseRuntime,origin,image}from'./helpers/embedded-case-runtime.mjs';
import {fixture}from'./helpers/prelaunch-reset-0028-fixture.mjs';
import {installResetExtensionLocal,snapshotReset,planSelectiveReset,candidateScope,executeSelectiveResetLocal}from'../scripts/lib/prelaunch-selective-reset.mjs';
import {resolveMemberTier}from'../src/lib/member-tier.js';
import {rankingCacheKey}from'../src/lib/public-ranking-cache.js';
const sql=fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8');
const synthetic={legacy_io:'LOCAL_SYNTHETIC_ALL_INVOCATIONS_ENDED',image_bypass_closed:true};
globalThis.fetch=async url=>{if(String(url)!=='https://challenges.cloudflare.com/turnstile/v0/siteverify')throw Error('NETWORK_FORBIDDEN');return Response.json({success:true});};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function protocol(t,{oldUpload=false}={}){
 const rt=await embeddedCaseRuntime();t.after(()=>rt.close());
 rt.sqlite.exec('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1');
 rt.sqlite.prepare(`INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at)
 VALUES('RESET-TEST','Synthetic','團體','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','Asia/Taipei','2000-01-01','2099-12-31',10,'active',?,?)`).run(new Date().toISOString(),new Date().toISOString());
 const admin=await rt.identity('super_admin');let old;if(oldUpload)old=await rt.upload('RESET-TEST',null,{direct:false,storageVersion:1});
 // Exercise an actual Windows-style checkout; the compiled SQL fingerprint
 // must agree with the LF Git source, without weakening the schema check.
 installResetExtensionLocal(rt.sqlite,sql.replace(/\r?\n/g,'\r\n'));rt.sqlite.exec("UPDATE prelaunch_reset_control SET mode='open'");rt.env.PRELAUNCH_RESET_FENCE_ENABLED='true';
 return{...rt,admin,old};
}
async function resetFixture(t){const f=await fixture();t.after(()=>f.close());installResetExtensionLocal(f.db,sql);f.db.prepare('UPDATE prelaunch_reset_control SET run_id=?').run(randomUUID());return f;}
const execute=(f,plan,more={})=>executeSelectiveResetLocal(f.db,plan,{authority:'LOCAL_SYNTHETIC_ONLY',expectedManifestHash:plan.sha256,...more});
async function clearProtocol(rt){
 await fencedRequest(rt.env,new Request(origin+'/api/synthetic-close',{method:'POST'}),async env=>{await env.DB.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();return Response.json({ok:true});});
 const pause=await rt.fetch('/api/admin/prelaunch-reset/pause','POST',{epoch:0,version:0},rt.admin.headers);assert.equal(pause.status,200);
 const snapshot=snapshotReset(rt.sqlite),plan=planSelectiveReset(snapshot,undefined,synthetic);assert.deepEqual(plan.blockers,[]);
 executeSelectiveResetLocal(rt.sqlite,plan,{authority:'LOCAL_SYNTHETIC_ONLY',expectedManifestHash:plan.sha256});
 // Explicit local-only controller resume. Production never auto-resumes.
 rt.sqlite.exec("UPDATE prelaunch_reset_control SET mode='open'");
 await fencedRequest(rt.env,new Request(origin+'/api/synthetic-reopen',{method:'POST'}),async env=>{await env.DB.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();return Response.json({ok:true});});
}
async function uploadMany(rt,n=2){
 const p=await rt.fetch('/api/uploads/prepare','POST',{turnstile_token:'synthetic',files:Array.from({length:n},(_,i)=>({name:i+'.png',size:image.length,type:'image/png',algorithm:'sha256',sha256:sha(image)}))});assert.equal(p.status,200);const data=(await p.json()).data;
 for(const u of data.uploads){const r=await worker.fetch(new Request(u.upload_url,{method:'PUT',headers:{...u.headers,Origin:origin,'Content-Length':String(image.length)},body:image}),rt.env);assert.equal(r.status,200,await r.text());}
 const ref={session_id:data.session_id,keys:data.uploads.map(u=>u.key)};return{ref,response:await rt.fetch('/api/uploads/complete','POST',ref)};
}
const submit=(rt,upload,direct=false)=>rt.fetch(direct?'/api/cases/direct':'/api/cases','POST',{campaign_id:'RESET-TEST',vote_date:new Date().toISOString().slice(0,10),upload_session:upload.ref},{Origin:origin,'Idempotency-Key':randomUUID()});

test('new Legacy multi-image issuance persists and all PUTs/complete keep existing API shape',async t=>{
 const rt=await protocol(t),u=await uploadMany(rt);assert.equal(u.response.status,200,await u.response.text());
 const row=rt.sqlite.prepare('SELECT * FROM prelaunch_reset_issuance WHERE session_id=?').get(u.ref.session_id);assert.equal(JSON.parse(row.keys_json).length,2);assert.equal(row.kind,'legacy');
 assert.equal(rt.sqlite.prepare('SELECT COUNT(*) n FROM prelaunch_reset_permit').get().n,0);
});
test('old Legacy complete cannot recreate deleted Session even with R2 object retained',async t=>{
 const rt=await protocol(t,{oldUpload:true});
 // Untracked old B0 SQL itself is rejected by the installed database fence.
 assert.throws(()=>rt.sqlite.prepare("INSERT INTO completed_uploads(session_id,manifest_hash,completed_at,expires_at) VALUES(?,?,?,?)").run(randomUUID(),'a'.repeat(64),new Date().toISOString(),'2100-01-01'),/FENCED/);
 await clearProtocol(rt);assert.equal(rt.sqlite.prepare('SELECT COUNT(*) n FROM completed_uploads').get().n,0);
 const response=await rt.fetch('/api/uploads/complete','POST',rt.old.ref);assert.equal(response.status,409);
 assert.equal((await response.json()).error.code,'PRELAUNCH_UPLOAD_RETIRED');
 assert.ok(await rt.bucket.head(rt.old.ref.keys[0]));
 assert.equal(rt.sqlite.prepare('SELECT COUNT(*) n FROM completed_uploads').get().n,0);
});
test('same-schema V2 and Direct handlers remain usable with persisted issuance',async t=>{
 const rt=await protocol(t);
 for(const direct of [false,true]){const upload=await rt.upload('RESET-TEST',null,{storageVersion:2,direct});const result=await submit(rt,upload,direct);assert.equal(result.status,201,await result.text());}
 assert.equal(rt.sqlite.prepare('SELECT COUNT(*) n FROM cases').get().n,2);
});
test('maintenance API preserves MFA/RBAC/CSRF, closes admissions, retains read-only health',async t=>{
 const rt=await protocol(t);
 const path='/api/admin/prelaunch-reset/pause',body={epoch:0,version:0};
 assert.equal((await rt.fetch(path,'POST',body)).status,401);
 assert.equal((await rt.fetch(path,'POST',body,{...rt.admin.headers,'X-CSRF-Token':'0'.repeat(64)})).status,403);
 const response=await rt.fetch(path,'POST',body,rt.admin.headers);assert.equal(response.status,200);
 assert.equal((await rt.fetch('/api/uploads/prepare','POST',{})).status,503);
 assert.equal((await rt.fetch('/api/health')).status,200);
});
test('late point/submission/export writes all fail after epoch change and cannot resurrect data',async t=>{
 const rt=await protocol(t),queries=[
  "INSERT INTO completed_uploads(session_id,manifest_hash,completed_at,expires_at) VALUES('late-session','"+'a'.repeat(64)+"','now','2100-01-01')",
  "INSERT INTO point_transactions(transaction_id,created_at,member_id,category,points,reason,created_by,idempotency_hash,request_hash) VALUES('late-point','now','"+rt.admin.memberId+"','manual_adjustment',1,'synthetic','"+rt.admin.memberId+"','"+'c'.repeat(64)+"','"+'d'.repeat(64)+"')",
  "INSERT INTO export_jobs(id,owner_member_id,created_at,expires_at,filters_json,from_utc,to_utc) VALUES('late-job','"+rt.admin.memberId+"','now','later','{}','2026-01-01','2026-01-02')"
 ];
 for(const q of queries){let entered,release;const ready=new Promise(r=>entered=r),latch=new Promise(r=>release=r);
  const pending=fencedRequest(rt.env,new Request(origin+'/api/synthetic-write',{method:'POST'}),async env=>{entered();await latch;await env.DB.prepare(q).run();return Response.json({ok:true});});
  await ready;rt.sqlite.exec('UPDATE prelaunch_reset_control SET epoch=epoch+1');release();await assert.rejects(pending,/暫停|過期/);
 }
 for(const table of ['completed_uploads','point_transactions','export_jobs'])assert.equal(rt.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
});
test('unknown R2 ACK is persistent; maintenance resume and reset refuse to erase it',async t=>{
 const rt=await protocol(t);rt.env.PROOFS_BUCKET={...rt.bucket,async put(){throw Error('synthetic-lost-ack');}};
 await assert.rejects(fencedRequest(rt.env,new Request(origin+'/api/synthetic-put',{method:'POST'}),async env=>{await env.PROOFS_BUCKET.put('synthetic',image);return Response.json({ok:true});}));
 const op=rt.sqlite.prepare('SELECT state,pending_r2 FROM prelaunch_reset_operations').get();assert.equal(op.state,'unknown');assert.equal(op.pending_r2,1);
 await rt.fetch('/api/admin/prelaunch-reset/pause','POST',{epoch:0,version:0},rt.admin.headers);
 const r=await rt.fetch('/api/admin/prelaunch-reset/resume','POST',{epoch:0,version:1},rt.admin.headers);assert.equal(r.status,409);
});
test('parallel writes in a single request use one admission and leave no active or permit leak',async t=>{
 const rt=await protocol(t);
 const response=await fencedRequest(rt.env,new Request(origin+'/api/synthetic-parallel',{method:'POST'}),async env=>{
  await Promise.all([1,2].map(i=>env.DB.prepare('INSERT INTO storage_audit VALUES(?,?,?,?,?)').bind(randomUUID(),1,'synthetic_parallel',String(i),'{}').run()));return Response.json({ok:true});
 });assert.equal(response.status,200);assert.equal(rt.sqlite.prepare("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state!='completed'").get().n,0);assert.equal(rt.sqlite.prepare('SELECT COUNT(*) n FROM prelaunch_reset_permit').get().n,0);
});
test('D1 batch committed with a lost acknowledgement is retained UNKNOWN and not automatically retried',async t=>{
 const rt=await protocol(t),db=rt.env.DB;let batches=0;
 const env={...rt.env,DB:{...db,async batch(statements){batches++;await db.batch(statements);throw Error('synthetic-ack-lost-after-commit');}}};
 await assert.rejects(fencedRequest(env,new Request(origin+'/api/synthetic-lost-ack',{method:'POST'}),async scoped=>{await scoped.DB.prepare('INSERT INTO storage_audit VALUES(?,?,?,?,?)').bind(randomUUID(),1,'synthetic_lost_ack','test','{}').run();return Response.json({ok:true});}));
 assert.equal(batches,1);assert.equal(rt.sqlite.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='synthetic_lost_ack'").get().n,1);assert.equal(rt.sqlite.prepare("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").get().n,1);
});
test('retired proof keys are denied for all shared R2 server read wrappers while inventory still counts objects',async t=>{
 const rt=await protocol(t),key='proofs/synthetic-retired.png';await rt.bucket.put(key,image,{httpMetadata:{contentType:'image/png'}});
 const id=randomUUID();rt.sqlite.prepare('INSERT INTO prelaunch_reset_audit VALUES(?,?,?,?)').run(id,new Date().toISOString(),'synthetic_terminal','{}');rt.sqlite.prepare('INSERT INTO prelaunch_reset_retired_keys VALUES(?,0,?)').run(key,id);
 for(const method of ['get','head'])await assert.rejects(fencedRequest(rt.env,new Request(origin+'/api/synthetic-read'),async env=>{await env.PROOFS_BUCKET[method](key);return Response.json({ok:true});}),e=>e.code==='PRELAUNCH_PROOF_RETIRED');
 assert.ok(await rt.bucket.head(key));
});
test('late read response cannot expose pre-reset bytes after epoch changes',async t=>{
 const rt=await protocol(t);let entered,release;const ready=new Promise(r=>entered=r),latch=new Promise(r=>release=r);
 const pending=fencedRequest(rt.env,new Request(origin+'/api/synthetic-read'),async()=>{entered();await latch;return new Response(image);});await ready;rt.sqlite.exec('UPDATE prelaunch_reset_control SET epoch=epoch+1');release();await assert.rejects(pending,e=>e.code==='PRELAUNCH_EPOCH_CHANGED');
});
test('actual case/Admin/ZIP/Relay routes reject retired references after keyed reset, with no R2 read',async t=>{
 const rt=await protocol(t),upload=await rt.upload('RESET-TEST',null,{storageVersion:2,direct:true}),created=await submit(rt,upload,true);assert.equal(created.status,201);const data=(await created.json()).data;
 const file=rt.sqlite.prepare('SELECT f.id,c.case_id FROM case_files f JOIN cases c ON c.id=f.case_id').get(),backup=rt.sqlite.prepare('SELECT id FROM proof_backups').get();
 await clearProtocol(rt);
 let gets=0;rt.env.PROOFS_BUCKET={...rt.bucket,async get(...args){gets++;return rt.bucket.get(...args);}};
 const urls=['/api/cases/'+file.case_id+'?key='+data.query_key,'/api/admin/cases/'+file.case_id+'/files/'+file.id,'/api/admin/image-exports/jobs/'+randomUUID()+'/packages/1/attempts/'+randomUUID()+'/files/'+file.id];
 for(const path of urls){const r=await rt.fetch(path,'GET',undefined,rt.admin.headers);assert.ok(r.status>=400);}
 if(backup){const r=await rt.fetch('/api/internal/drive-backup/'+backup.id+'/content','GET',undefined,{Authorization:'Bearer '+rt.env.DRIVE_BACKUP_RELAY_SECRET,'X-VoteProof-Reset-Epoch':'1','X-VoteProof-Backup-Lease':randomUUID(),'X-VoteProof-Backup-Attempt':'1'});assert.ok(r.status>=400);}
 assert.equal(gets,0);assert.ok(await rt.bucket.head(upload.ref.keys[0]));
 const fresh=await rt.upload('RESET-TEST',null,{storageVersion:2,direct:true});const next=await submit(rt,fresh,true);assert.equal(next.status,201,await next.text());
});
test('dry-run is default/HOLD without explicit terminal evidence; mixed selected roots and leases HOLD',async t=>{
 const f=await resetFixture(t),snapshot=snapshotReset(f.db);assert.equal(planSelectiveReset(snapshot).status,'HOLD');
 const scope=candidateScope(snapshot);scope.case_ids=[];assert.ok(planSelectiveReset(snapshot,scope,synthetic).blockers.some(x=>/MIXED/.test(x)));
 f.db.prepare("INSERT INTO prelaunch_reset_operations VALUES('unknown',0,'unknown',1,1,'now',NULL)").run();assert.ok(planSelectiveReset(snapshotReset(f.db),undefined,synthetic).blockers.includes('UNRESOLVED_WORK_OR_UNKNOWN_ACK'));
});
test('confirmed backup token is a durable receipt, not an active lease',async t=>{
 const f=await fixture();t.after(()=>f.close());f.db.exec("UPDATE proof_backups SET lease_token='synthetic-confirmed-receipt-'||id,lease_until=NULL WHERE status='confirmed'");installResetExtensionLocal(f.db,sql);f.db.prepare('UPDATE prelaunch_reset_control SET run_id=?').run(randomUUID());
 const plan=planSelectiveReset(snapshotReset(f.db),undefined,synthetic);assert.ok(!plan.blockers.includes('UNRESOLVED_WORK_OR_UNKNOWN_ACK'));
});

test('rebuild history is selected only by exact run/board; definition and privilege audit stay intact',async t=>{
 const f=await fixture();t.after(()=>f.close());
 const audit=f.db.prepare('SELECT * FROM admin_audit_logs LIMIT 1').get();
 f.insert('admin_audit_logs',{...audit,id:'synthetic-rebuild-audit',action:'leaderboard_rebuild',target_type:'leaderboard',target_id:'LOCAL-BOARD',after_json:JSON.stringify({run_id:'LOCAL-RUN'})});
 f.insert('admin_audit_logs',{...audit,id:'synthetic-definition-audit',action:'leaderboard_update',target_type:'leaderboard',target_id:'LOCAL-BOARD',target_version:2});
 installResetExtensionLocal(f.db,sql);f.db.prepare('UPDATE prelaunch_reset_control SET run_id=?').run(randomUUID());
 const plan=planSelectiveReset(snapshotReset(f.db),undefined,synthetic);assert.deepEqual(plan.blockers,[]);
 assert.ok(plan.selected.admin_audit_logs.some(r=>r.id==='synthetic-rebuild-audit'));assert.ok(!plan.selected.admin_audit_logs.some(r=>r.id==='synthetic-definition-audit'));
 execute(f,plan);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE id='synthetic-rebuild-audit'").get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE id='synthetic-definition-audit'").get().n,1);
});

test('CLI defaults to read-only dry-run and refuses remote execution; database snapshot unchanged',async t=>{
 const f=await resetFixture(t),before=snapshotReset(f.db).hash,out=f.root+'/review-only.json';
 const r=spawnSync(process.execPath,['scripts/prelaunch-selective-reset.mjs','--database',f.root+'/source.sqlite','--out',out],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'HOLD');assert.equal(snapshotReset(f.db).hash,before);assert.ok(fs.existsSync(out));
 const bad=spawnSync(process.execPath,['scripts/prelaunch-selective-reset.mjs','--remote','--database',f.root+'/source.sqlite'],{encoding:'utf8'});
 assert.notEqual(bad.status,0);assert.match(bad.stderr,/REMOTE_EXECUTION_NOT_IMPLEMENTED_OR_AUTHORIZED/);assert.equal(snapshotReset(f.db).hash,before);
});
test('successful local keyed reset preserves member/auth/config, real capacity and restored immutable guards',async t=>{
 const f=await resetFixture(t),before=snapshotReset(f.db),plan=planSelectiveReset(before,undefined,synthetic);assert.deepEqual(plan.blockers,[]);
 const oldKey=rankingCacheKey(new URL('https://local.invalid'),before.tables.leaderboards[0]),r=execute(f,plan);assert.equal(r.status,'LOCAL_RESET_COMMITTED');assert.equal(r.physical_r2_deleted,0);
 const after=snapshotReset(f.db);for(const table of ['members','auth_identities','member_credentials','admin_memberships','storage_capacity'])assert.deepEqual(after.tables[table],before.tables[table]);
 assert.equal(after.tables.point_transactions.length,0);assert.equal(resolveMemberTier(0,after.tables.member_tiers).tier_progress,0);
 assert.notEqual(rankingCacheKey(new URL('https://local.invalid'),after.tables.leaderboards[0]),oldKey);
 assert.equal(after.tables.leaderboards[0].current_run_id,null);assert.equal(f.stores.r2.list().length,7);
 assert.throws(()=>execute(f,plan),/SOURCE_CHANGED/);
 assert.throws(()=>f.db.exec('DELETE FROM storage_audit'),/immutable|FENCED/);
});
for(const fault of ['trigger','foreign-key'])test('native '+fault+' failure rolls back every row, epoch, retirement and original Guard',async t=>{
 const f=await resetFixture(t),before=snapshotReset(f.db),plan=planSelectiveReset(before,undefined,synthetic);
 assert.throws(()=>execute(f,plan,{fault}),/LOCAL_INJECTED_TRIGGER_FAILURE|FK_OR_QUICK_CHECK_FAILED|FOREIGN KEY/);
 assert.equal(snapshotReset(f.db).hash,before.hash);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM prelaunch_reset_permit').get().n,0);
});
test('post-reset current-epoch Legacy uploads and new case remain usable; old CSRF and Relay epoch rejected',async t=>{
 const rt=await protocol(t);rt.sqlite.exec('UPDATE prelaunch_reset_control SET epoch=1');
 const upload=await uploadMany(rt);assert.equal(upload.response.status,200,await upload.response.text());const created=await submit(rt,upload);assert.equal(created.status,201,await created.text());
 assert.equal((await rt.fetch('/api/admin/prelaunch-reset/pause','POST',{epoch:1,version:0},rt.admin.headers)).status,403);
 const relay=await rt.fetch('/api/internal/drive-backup/storage/tick','POST',{});assert.equal(relay.status,403);assert.equal((await relay.json()).error.code,'PRELAUNCH_RELAY_EPOCH_REQUIRED');
});
test('Apps Script common request retains backup/inventory behavior and adds only configured epoch header',()=>{
 let headers;
 const context={PropertiesService:{getScriptProperties:()=>({getProperty:()=> '2'})},UrlFetchApp:{fetch:(_u,o)=>{headers=o.headers;return{getResponseCode:()=>200,getContentText:()=>'{"ok":true,"data":{}}'};}},JSON,Number,Date,Object,Utilities:{}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('apps-script/drive-backup/Code.gs','utf8'),context);
 context.vpRequest_({origin:'https://example.invalid',secret:'a'.repeat(64)},'/api/internal/drive-backup/storage/tick','post',{});
 assert.equal(headers['X-VoteProof-Reset-Epoch'],'2');assert.equal(headers.Authorization,'Bearer '+'a'.repeat(64));
});
