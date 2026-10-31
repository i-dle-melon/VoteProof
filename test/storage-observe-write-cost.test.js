import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID,createHash} from 'node:crypto';
import {embeddedCaseRuntime,origin,image} from './helpers/embedded-case-runtime.mjs';
import {installResetExtensionLocal} from '../scripts/lib/prelaunch-selective-reset.mjs';
import {memberSession,csrfToken} from '../src/lib/auth-session.js';
import worker from '../src/index.js';
import {fencedRequest} from '../src/lib/prelaunch-reset-fence.js';
import {BatchSubmission} from '../public/js/submission.js';
import {PublicError} from '../public/js/api.js';

let verifications=0;
globalThis.fetch=async url=>{assert.equal(String(url),'https://challenges.cloudflare.com/turnstile/v0/siteverify');verifications++;return Response.json({success:true});};
globalThis.location={origin};
const policy=fs.readFileSync('migrations-storage-policy/0001_observe_capacity.sql','utf8');
const reset=fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8');
const sha=createHash('sha256').update(image).digest('hex');
const latch=()=>{let arrived,release;return{arrived:new Promise(r=>arrived=r),held:new Promise(r=>release=r),arrive:()=>arrived(),release:()=>release()};};
async function setup(t,{observe=true,schema=true}={}){
 const f=await embeddedCaseRuntime();t.after(()=>f.close());const actor=await f.identity('admin');
 f.sqlite.exec('UPDATE submission_settings SET submissions_enabled=1');
 const stamp=new Date().toISOString();f.sqlite.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at) VALUES('OBSERVE','Synthetic','團體','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','Asia/Taipei','2000-01-01','2099-12-31',3,'active',?,?)").run(stamp,stamp);
 if(schema){f.sqlite.exec('BEGIN;'+policy+'COMMIT;');if(observe)f.sqlite.exec("UPDATE storage_capacity SET upload_policy='observe',trusted_until=0,blocked=1");}
 installResetExtensionLocal(f.sqlite,reset);f.sqlite.exec("UPDATE prelaunch_reset_control SET epoch=1,mode='open'");
 Object.assign(f.env,{PRELAUNCH_RESET_FENCE_ENABLED:'true',R2_EXCLUSIVE_WRITER_CONFIRMED:'true',...(observe?{STORAGE_CAPACITY_ENFORCEMENT:'disabled'}:{})});
 const member=await memberSession(new Request(origin,{headers:actor.headers}),f.env);actor.headers['X-CSRF-Token']=await csrfToken(member,{...f.env,PRELAUNCH_RESET_CONTEXT:{epoch:1}});
 let puts=0;const original=f.bucket.put;f.bucket.put=async(...args)=>{puts++;return original(...args);};f.bucket.list=async()=>({objects:[],truncated:false});
 const read=sql=>({...f.sqlite.prepare(sql).get()});
 const relay=(path,body)=>f.fetch('/api/internal/drive-backup/'+path,'POST',body,{Authorization:'Bearer '+f.env.DRIVE_BACKUP_RELAY_SECRET,'X-VoteProof-Reset-Epoch':'1'});
 async function prepare(mode='direct',member=false){const r=await f.fetch('/api/uploads/prepare','POST',{turnstile_token:'synthetic',...(mode==='legacy'?{}:{storage_version:2,campaign_id:'OBSERVE',...(mode==='direct'?{completion_mode:'direct'}:{})}),files:Array.from({length:mode==='legacy'?2:1},(_,i)=>({name:i+'.png',type:'image/png',size:image.length,algorithm:'sha256',sha256:sha}))},member?actor.headers:{Origin:origin});assert.equal(r.status,200,await r.clone().text());return{...(await r.json()).data,headers:member?actor.headers:{Origin:origin}};}
 const put=(p,i=0)=>worker.fetch(new Request(p.uploads[i].upload_url,{method:'PUT',headers:{...p.uploads[i].headers,...p.headers,'Content-Length':String(image.length)},body:image}),f.env);
 const finish=()=>relay('storage/inventory/finalize',read('SELECT inventory_id,inventory_version FROM storage_capacity'));
 const edit=sql=>fencedRequest(f.env,new Request(origin+'/api/local-synthetic-fixture',{method:'POST'}),async env=>{await env.DB.prepare(sql).run();return Response.json({ok:true});});
 return{...f,actor,read,relay,prepare,put,finish,edit,puts:()=>puts};
}

for(const mode of ['legacy','v2','direct'])for(const member of [false,true])test(mode+' '+(member?'member':'guest')+': no inventory/fresh snapshot needed; case replay stays idempotent',async t=>{
 const f=await setup(t),p=await f.prepare(mode,member);for(let i=0;i<p.uploads.length;i++)assert.equal((await f.put(p,i)).status,200);
 const reference={session_id:p.session_id,keys:p.uploads.map(u=>u.key),...(p.capability?{capability:p.capability}:{})};
 if(mode!=='direct')assert.equal((await f.fetch('/api/uploads/complete','POST',reference,p.headers)).status,200);
 const body={campaign_id:'OBSERVE',vote_date:new Date().toISOString().slice(0,10),upload_session:reference},headers={...p.headers,'Idempotency-Key':randomUUID()},route=mode==='direct'?'/api/cases/direct':'/api/cases';
 const created=await f.fetch(route,'POST',body,headers);assert.equal(created.status,201,await created.clone().text());const first=(await created.json()).data;
 const replay=await f.fetch(route,'POST',body,headers);assert.equal(replay.status,201);assert.deepEqual((await replay.json()).data,first);
 assert.equal(f.read('SELECT COUNT(*) n FROM cases').n,1);assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,0);
 assert.equal(f.read('SELECT reserved_bytes FROM storage_capacity').reserved_bytes,0);
});

test('observe mode ignores site threshold/blocked; retains anomaly and integer integrity rejection',async t=>{
 const f=await setup(t);await f.edit('UPDATE storage_capacity SET used_bytes=9600000000');const p=await f.prepare();assert.equal((await f.put(p)).status,200);
 await f.edit("UPDATE storage_capacity SET anomaly='WRITE_SIZE_MISMATCH'");const next=await f.prepare();const n=f.puts();assert.equal((await f.put(next)).status,503);assert.equal(f.puts(),n);
 await f.edit('UPDATE storage_capacity SET anomaly=NULL,used_bytes=9007199254740991');assert.equal((await f.put(next)).status,503);assert.equal(f.puts(),n);
});
test('extension installation defaults to enforced; missing extension and mode mismatch fail closed',async t=>{
 for(const schema of [false,true]){const f=await setup(t,{observe:false,schema});if(schema)assert.equal(f.read('SELECT upload_policy FROM storage_capacity').upload_policy,'enforced');
  f.env.STORAGE_CAPACITY_ENFORCEMENT='disabled';const p=await f.prepare();assert.notEqual((await f.put(p)).status,200);assert.equal(f.puts(),0);
 }
});
test('manual clean inventory remains available and receipt replay remains idempotent',async t=>{
 const f=await setup(t);assert.equal((await f.relay('storage/tick',{inventory_only:true})).status,200);const input=f.read('SELECT inventory_id,inventory_version FROM storage_capacity');
 assert.equal((await f.relay('storage/inventory/finalize',input)).status,200);assert.equal((await f.relay('storage/inventory/finalize',input)).status,200);assert.equal(f.read('SELECT COUNT(*) n FROM storage_history').n,1);
});
test('upload during scan is admitted; invalidated scan cannot publish trusted capacity or clear its pin',async t=>{
 const f=await setup(t);assert.equal((await f.relay('storage/tick',{inventory_only:true})).status,200);const p=await f.prepare();assert.equal((await f.put(p)).status,200);
 const before=f.read('SELECT inventory_id,inventory_version,inventory_dirty,trusted_until FROM storage_capacity');assert.equal(before.inventory_dirty,1);assert.equal(before.trusted_until,0);
 assert.equal((await f.finish()).status,409);assert.equal((await f.relay('storage/tick',{inventory_only:true})).status,409);assert.deepEqual(f.read('SELECT inventory_id,inventory_version,inventory_dirty,trusted_until FROM storage_capacity'),before);
});
test('write entering between LIST and page CAS rejects progress; does not reject upload',async t=>{
 const f=await setup(t),p=await f.prepare(),hold=latch();f.bucket.list=async()=>{hold.arrive();await hold.held;return{objects:[],truncated:false};};
 const scan=f.relay('storage/tick',{inventory_only:true});await hold.arrived;assert.equal((await f.put(p)).status,200);hold.release();assert.equal((await scan).status,409);
 assert.equal(f.read('SELECT inventory_dirty FROM storage_capacity').inventory_dirty,1);assert.equal(f.read('SELECT COUNT(*) n FROM storage_history').n,0);
});
test('native PUT ACK unknown keeps its pin, reservation and pending evidence; repeated caller sends no PUT',async t=>{
 const f=await setup(t),p=await f.prepare(),raw=f.bucket.put;f.bucket.put=async(...args)=>{await raw(...args);throw Error('SYNTHETIC_ACK_LOST');};
 const db=f.env.DB;let unknowns=0;f.env.DB={...db,prepare(sql){const s=db.prepare(sql),wrap=x=>({...x,bind:(...v)=>wrap(x.bind(...v)),run:async()=>{if(sql.startsWith("UPDATE prelaunch_reset_operations SET state='unknown'"))unknowns++;return x.run();}});return wrap(s);}};
 assert.equal((await f.put(p)).status,502);assert.equal(unknowns,1);const snapshot=()=>f.read("SELECT (SELECT COUNT(*) FROM proof_upload_intents WHERE write_token IS NOT NULL) pins,(SELECT COUNT(*) FROM storage_reservations WHERE state='reserved') reserved,(SELECT COUNT(*) FROM prelaunch_reset_operations WHERE state='unknown' AND pending_r2=1) unknowns");
 assert.deepEqual(snapshot(),{pins:1,reserved:1,unknowns:1});assert.equal((await f.put(p)).status,409);assert.deepEqual(snapshot(),{pins:1,reserved:1,unknowns:1});assert.equal(f.puts(),1);
});
test('failed UNKNOWN persistence is not resent and never marks active/pending completed',async t=>{
 const f=await setup(t),p=await f.prepare();f.bucket.put=async()=>{throw Error('SYNTHETIC_UNKNOWN');};const db=f.env.DB;let attempts=0;
 f.env.DB={...db,prepare(sql){const s=db.prepare(sql),wrap=x=>({...x,bind:(...v)=>wrap(x.bind(...v)),run:async()=>{if(sql.startsWith("UPDATE prelaunch_reset_operations SET state='unknown'")){attempts++;throw Error('SYNTHETIC_D1_ACK_UNKNOWN');}return x.run();}});return wrap(s);}};
 assert.equal((await f.put(p)).status,502);assert.equal(attempts,1);assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='active' AND pending_r2=1").n,1);
});
test('new upload preserves a previous UNKNOWN pin/reservation byte-for-byte',async t=>{
 const f=await setup(t),old=await f.prepare(),original=f.bucket.put;f.bucket.put=async(...args)=>{await original(...args);throw Error('SYNTHETIC_OLD_ACK_UNKNOWN');};assert.equal((await f.put(old)).status,502);f.bucket.put=original;
 const snapshot=()=>JSON.stringify({intent:f.read(`SELECT * FROM proof_upload_intents WHERE session_id='${old.session_id}'`),reservation:f.read("SELECT * FROM storage_reservations WHERE state='reserved'"),operation:f.read("SELECT * FROM prelaunch_reset_operations WHERE state='unknown'")});
 const before=snapshot(),next=await f.prepare();assert.equal((await f.put(next)).status,200);assert.equal(snapshot(),before);assert.equal(f.read('SELECT reserved_bytes FROM storage_capacity').reserved_bytes,3);
});
test('Finalize race with a new reservation cannot publish or release its inventory pin',async t=>{
 const f=await setup(t);assert.equal((await f.relay('storage/tick',{inventory_only:true})).status,200);const p=await f.prepare(),db=f.env.DB,hold=latch();let hit=false;
 f.env.DB={...db,batch:async xs=>{if(!hit&&xs.some(s=>s.sql.startsWith('INSERT INTO storage_history'))){hit=true;hold.arrive();await hold.held;}return db.batch(xs);}};
 const final=f.finish();await hold.arrived;assert.equal((await f.put(p)).status,200);hold.release();assert.equal((await final).status,409);assert.equal(f.read('SELECT COUNT(*) n FROM storage_history').n,0);assert.ok(f.read('SELECT inventory_id FROM storage_capacity').inventory_id);
});
test('database guard rejects a legacy publisher that does not read inventory_dirty',async t=>{
 const f=await setup(t);assert.equal((await f.relay('storage/tick',{inventory_only:true})).status,200);const p=await f.prepare();assert.equal((await f.put(p)).status,200);
 await assert.rejects(()=>f.edit('UPDATE storage_capacity SET used_bytes=inventory_bytes,trusted_until=2147483647,inventory_id=NULL,inventory_phase=NULL WHERE id=1'),/STORAGE_INVENTORY_INVALIDATED/);
 assert.ok(f.read('SELECT inventory_id FROM storage_capacity').inventory_id);assert.equal(f.read('SELECT trusted_until FROM storage_capacity').trusted_until,0);
});
test('health summary reports disabled quota and stale snapshot separately, without control writes',async t=>{
 const f=await setup(t),n=f.read('SELECT COUNT(*) n FROM prelaunch_reset_operations').n;
 const response=await f.fetch('/api/admin/health-monitor/summary','GET',undefined,f.actor.headers);assert.equal(response.status,200);const data=(await response.json()).data;
 assert.equal(data.storage.upload_policy,'observe');assert.equal(data.storage.blocked,false);assert.equal(data.storage.snapshot_stale,true);assert.equal(data.pending_operations.count,null);assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_operations').n,n);
});
test('member case replay and repeated review cannot award points twice',async t=>{
 const f=await setup(t),p=await f.prepare('direct',true);assert.equal((await f.put(p)).status,200);
 const body={campaign_id:'OBSERVE',vote_date:new Date().toISOString().slice(0,10),upload_session:{session_id:p.session_id,keys:[p.uploads[0].key]}},headers={...p.headers,'Idempotency-Key':randomUUID()};
 const created=await f.fetch('/api/cases/direct','POST',body,headers);assert.equal(created.status,201);const data=(await created.json()).data;
 const review=()=>f.fetch('/api/admin/cases/'+data.case_id+'/review','POST',{action:'approve',expected_version:0},f.actor.headers);
 assert.equal((await review()).status,200);assert.notEqual((await review()).status,200);assert.equal((await f.fetch('/api/cases/direct','POST',body,headers)).status,201);
 assert.equal(f.read('SELECT COUNT(*) n FROM cases').n,1);assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,1);assert.equal(f.read('SELECT SUM(points) n FROM point_transactions').n,3);
});
for(const member of [false,true])test('observe '+(member?'member':'guest')+': 20-image batch uses one verification and no duplicate PUT/case',async t=>{
 const f=await setup(t),before=verifications,headers=member?f.actor.headers:{Origin:origin};
 const api=async(path,options={})=>{const r=await f.fetch(path,options.method??'GET',options.body,{...headers,...options.headers}),b=await r.json();if(!r.ok)throw new PublicError(b.error.code,r.status);return b.data;};
 const batch=new BatchSubmission({api,directIntent:true,token:async()=> 'synthetic',gate:async()=>{},put:async upload=>{const r=await f.put({uploads:[upload],headers});if(!r.ok)throw new PublicError((await r.json()).error.code,r.status);}});
 batch.start({campaign_id:'OBSERVE',vote_date:new Date().toISOString().slice(0,10)},Array.from({length:20},()=>new File([image],'synthetic.png',{type:'image/png'})));
 assert.equal((await batch.attempt()).complete,true);assert.equal(verifications-before,1);assert.equal(f.puts(),20);assert.equal(f.read('SELECT COUNT(*) n FROM cases').n,20);
 await batch.attempt();assert.equal(f.puts(),20);assert.equal(f.read('SELECT COUNT(*) n FROM cases').n,20);
});
test('old grants/maintenance/epoch checks remain authoritative with accounting-only admission',async t=>{
 const f=await setup(t),p=await f.prepare();f.sqlite.exec("UPDATE prelaunch_reset_control SET mode='maintenance'");const n=f.puts();assert.equal((await f.put(p)).status,503);assert.equal(f.puts(),n);
 f.sqlite.exec("UPDATE prelaunch_reset_control SET mode='open',epoch=2");assert.notEqual((await f.put(p)).status,200);assert.equal(f.puts(),n);
});
test('Prepare commit ACK loss is not retried inside the request; issuance/Intent remain paired',async t=>{
 const f=await setup(t),db=f.env.DB;let calls=0;
 f.env.DB={...db,batch:async xs=>{const r=await db.batch(xs);if(xs.some(s=>s.sql.startsWith('INSERT INTO proof_upload_intents'))){calls++;throw Error('SYNTHETIC_PREPARE_ACK_LOST');}return r;}};
 const response=await f.fetch('/api/uploads/prepare','POST',{storage_version:2,completion_mode:'direct',campaign_id:'OBSERVE',turnstile_token:'synthetic',files:[{name:'x.png',type:'image/png',size:3,algorithm:'sha256',sha256:sha}]},{Origin:origin});
 assert.equal(response.status,500);assert.equal(calls,1);assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_issuance').n,1);assert.equal(f.read('SELECT COUNT(*) n FROM proof_upload_intents').n,1);assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").n,1);assert.equal(f.puts(),0);
});
test('prepare Intent failure rolls back its issuance in the same transaction',async t=>{
 const f=await setup(t);f.sqlite.exec("CREATE TRIGGER local_intent_failure BEFORE INSERT ON proof_upload_intents BEGIN SELECT RAISE(ABORT,'synthetic');END");
 const r=await f.fetch('/api/uploads/prepare','POST',{storage_version:2,completion_mode:'direct',campaign_id:'OBSERVE',turnstile_token:'synthetic',files:[{name:'x.png',type:'image/png',size:3,algorithm:'sha256',sha256:sha}]},{Origin:origin});
 assert.equal(r.status,500);assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_issuance').n,0);assert.equal(f.read('SELECT COUNT(*) n FROM proof_upload_intents').n,0);
});
test('empty backup claim is genuinely read-only; queued work still takes original lease path',async t=>{
 const f=await setup(t),before=f.read('SELECT COUNT(*) n FROM prelaunch_reset_operations').n;
 const idle=await f.relay('claim',{request_id:randomUUID(),root_folder_id:'synthetic_root_0123456789'});assert.equal(idle.status,200);assert.equal((await idle.json()).data.state,'idle');assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_operations').n,before);
 const p=await f.prepare();assert.equal((await f.put(p)).status,200);const body={campaign_id:'OBSERVE',vote_date:new Date().toISOString().slice(0,10),upload_session:{session_id:p.session_id,keys:[p.uploads[0].key],capability:p.capability}};
 assert.equal((await f.fetch('/api/cases/direct','POST',body,{Origin:origin,'Idempotency-Key':randomUUID()})).status,201);
 const id=randomUUID(),job=await f.relay('claim',{request_id:id,root_folder_id:'synthetic_root_0123456789'});assert.equal(job.status,200);assert.equal((await job.json()).data.state,'claimed');
 const mismatch=await f.relay('claim',{request_id:id,root_folder_id:'different_root_0123456789'});assert.equal(mismatch.status,409);assert.equal((await mismatch.json()).error.code,'RELAY_ROOT_CONFLICT');
});
test('GAS soft pause preserves triggers, backup properties and code; resume is explicit',()=>{
 const properties=new Map([['VOTEPROOF_INVENTORY_PAUSED','true'],['CLAIM_REQUEST_ID','keep']]),triggers=[{handler:'runBackup'},{handler:'runStorageInventory'}];
 const context=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k),setProperty:(k,v)=>properties.set(k,v),deleteProperty:k=>properties.delete(k)})},ScriptApp:new Proxy({},{get(){assert.fail('No trigger operation allowed');}})});
 vm.runInContext(fs.readFileSync('apps-script/drive-backup/StorageInventory.gs','utf8'),context);assert.equal(context.runStorageInventory().state,'paused');assert.equal(context.pauseStorageInventory().state,'paused');assert.equal(triggers.length,2);assert.equal(properties.get('CLAIM_REQUEST_ID'),'keep');context.resumeStorageInventory();assert.equal(properties.has('VOTEPROOF_INVENTORY_PAUSED'),false);
});
