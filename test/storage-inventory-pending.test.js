import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import{randomUUID,createHash}from'node:crypto';
import worker from '../src/index.js';
import{embeddedCaseRuntime,origin,image}from'./helpers/embedded-case-runtime.mjs';
import{installResetExtensionLocal}from'../scripts/lib/prelaunch-selective-reset.mjs';
import{csrfToken,memberSession}from'../src/lib/auth-session.js';
const tick='/api/internal/drive-backup/storage/tick',finish='/api/internal/drive-backup/storage/inventory/finalize';
const BASE=200861922,R=980929,now=()=>Math.floor(Date.now()/1000);
const latch=()=>{let enter,release;return{entered:new Promise(r=>enter=r),wait:new Promise(r=>release=r),enter:()=>enter(),release:()=>release()}};
async function fixture(t,{seed=true,base=BASE,extraPins=0,mode='open'}={}){
 const rt=await embeddedCaseRuntime();t.after(()=>rt.close());
 t.mock.method(globalThis,'fetch',async url=>{assert.equal(String(url),'https://challenges.cloudflare.com/turnstile/v0/siteverify');return Response.json({success:true})});
 const admin=await rt.identity('super_admin');
 const stamp=new Date().toISOString();
 rt.sqlite.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at) VALUES('PENDING-LOCAL','Synthetic','團體','2000-01-01','2100-01-01','Asia/Taipei','2000-01-01','2099-12-31',10,'active',?,?)").run(stamp,stamp);
 rt.sqlite.exec('UPDATE submission_settings SET submissions_enabled=1');
 rt.sqlite.prepare('UPDATE storage_capacity SET used_bytes=?,observed_at=1 WHERE id=1').run(base);
 const seedIntent=(n,size)=>{
  const session=randomUUID(),proof=randomUUID(),key=`proofs/final/g1/${session}/${proof}.png`,pin=randomUUID();
  rt.sqlite.prepare(`INSERT INTO proof_upload_intents(session_id,proof_id,object_key,campaign_id,guest_capability_hash,content_type,size,expected_sha256,created_at,expires_at,grant_expires,completion_mode,write_token)
   VALUES(?,?,?,'PENDING-LOCAL',?,'image/png',?,?,?,?,?,'direct',?)`).run(session,proof,key,'a'.repeat(64),size,'b'.repeat(64),stamp,new Date(Date.now()+86400000).toISOString(),now()-1,pin);
  return{session,proof,key,pin,id:'R'+n,size};
 };
 const r01=seed?seedIntent('01',R):null;
 if(seed)rt.sqlite.prepare("INSERT INTO storage_reservations VALUES(?,?,?,'reserved',?,NULL,NULL)").run(r01.id,r01.key,R,now());
 for(let n=0;n<extraPins;n++)seedIntent('extra'+n,3);
 installResetExtensionLocal(rt.sqlite,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));
 rt.sqlite.prepare('UPDATE prelaunch_reset_control SET epoch=1,mode=?,version=4,run_id=?').run(mode,mode==='maintenance'?randomUUID():null);
 for(let n=0;n<extraPins;n++)rt.sqlite.prepare("INSERT INTO prelaunch_reset_operations(id,epoch,state,started_at) VALUES(?,1,'unknown',?)").run('prior-'+n,stamp);
 rt.env.PRELAUNCH_RESET_FENCE_ENABLED='true';rt.env.R2_EXCLUSIVE_WRITER_CONFIRMED='true';
 const member=await memberSession(new Request(origin,{headers:admin.headers}),rt.env);
 admin.headers['X-CSRF-Token']=await csrfToken(member,{...rt.env,PRELAUNCH_RESET_CONTEXT:{epoch:1}});
 const objects=new Map([['synthetic/base',{key:'synthetic/base',size:base}]]),calls=[];
 let beforeList=async()=>{},beforePut=async()=>{},afterPut=async()=>{};
 const original=rt.bucket;
 rt.env.PROOFS_BUCKET={
  async list(options){calls.push(options);const list=[...objects.values()].sort((a,b)=>a.key.localeCompare(b.key));const start=Number(options.cursor??0),part=list.slice(start,start+options.limit),more=start+options.limit<list.length;await beforeList();return{objects:part,truncated:more,...(more?{cursor:String(start+options.limit)}:{})}},
  async put(...args){await beforePut(args);const result=await original.put(...args);if(result)objects.set(args[0],result);await afterPut(result);return result},
  head:(...a)=>original.head(...a),get:(...a)=>original.get(...a),delete:()=>assert.fail('No DELETE'),
 };
 const cap=()=>({...rt.sqlite.prepare('SELECT * FROM storage_capacity').get()});
 const pending=()=>rt.sqlite.prepare('SELECT * FROM proof_upload_intents WHERE write_token IS NOT NULL ORDER BY session_id').all();
 const protectedRows=()=>JSON.stringify({pending:pending(),reservation:rt.sqlite.prepare('SELECT * FROM storage_reservations ORDER BY id').all(),prior:rt.sqlite.prepare("SELECT * FROM prelaunch_reset_operations WHERE id LIKE 'prior-%' ORDER BY id").all()});
 // Explicit fixture injection through the installed normal permit, never a
 // dropped Trigger or an invented legacy attestation.
 function normal(fn){const id=randomUUID();rt.sqlite.exec('BEGIN');try{
  rt.sqlite.prepare("INSERT INTO prelaunch_reset_operations(id,epoch,state,started_at) VALUES(?,1,'active',?)").run(id,stamp);
  rt.sqlite.prepare("INSERT INTO prelaunch_reset_permit(id,epoch,operation_id,purpose,scope_json) VALUES(1,1,?,'normal','{}')").run(id);
  const r=fn();rt.sqlite.prepare('DELETE FROM prelaunch_reset_permit WHERE id=1 AND operation_id=?').run(id);
  rt.sqlite.prepare("UPDATE prelaunch_reset_operations SET state='completed' WHERE id=?").run(id);rt.sqlite.exec('COMMIT');return r;
 }catch(e){rt.sqlite.exec('ROLLBACK');throw e}}
 const send=async(path=tick,body={inventory_only:true},extra={})=>{const r=await rt.fetch(path,'POST',body,{Authorization:'Bearer '+rt.env.DRIVE_BACKUP_RELAY_SECRET,'X-VoteProof-Reset-Epoch':'1',...extra});return{status:r.status,...await r.json()}};
 const ready=async()=>{let r;for(let n=0;n<10;n++){r=await send();assert.equal(r.status,200,JSON.stringify(r));if(r.data.inventory.phase==='finalize')return{inventory_id:r.data.inventory.inventory_id,inventory_version:r.data.inventory.inventory_version}}assert.fail('bounded scan')};
 return{...rt,admin,r01,objects,calls,cap,pending,normal,protectedRows,send,ready,setBeforeList:f=>beforeList=f,setBeforePut:f=>beforePut=f,setAfterPut:f=>afterPut=f};
}
test('actual Worker/Relay/Fence: pending snapshot is durable, no pins settle, receipt replay is immutable',async t=>{
 const f=await fixture(t,{extraPins:150}),protectedBefore=f.protectedRows(),schema=f.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
 const body=await f.ready();assert.equal(f.cap().trusted_until,0);assert.equal(f.cap().reserved_bytes,R);
 const snapshot=f.sqlite.prepare("SELECT * FROM storage_audit WHERE action='inventory_pending_snapshot'").get();
 assert(snapshot);assert(!snapshot.detail.includes(f.r01.key));assert(!snapshot.detail.includes(f.r01.pin));
 const r=await f.send(finish,body);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.inventory.conservative,true);assert.equal(r.data.inventory.pending_bytes,R);assert.equal(r.data.inventory.admission_bytes,BASE+R);assert.equal(r.data.inventory.pending_terminal,'UNKNOWN');
 assert.equal(f.cap().reserved_bytes,R);assert.equal(f.cap().used_bytes,BASE);assert.equal(f.cap().anomaly,null);
 const before=f.cap();const replay=await f.send(finish,body);assert.equal(replay.status,200);assert.equal(replay.data.inventory.replayed,true);assert.deepEqual(f.cap(),before);
 assert.equal(f.protectedRows(),protectedBefore);assert.equal(f.sqlite.prepare('SELECT reserved_bytes FROM storage_history').get().reserved_bytes,R);
 assert.deepEqual(f.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all(),schema);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM prelaunch_reset_permit').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='inventory'").get().n,1);
 assert.throws(()=>f.sqlite.prepare("DELETE FROM storage_audit WHERE action='inventory_pending_snapshot'").run(),/immutable|FENCED/);
});
test('multiple requests resume a persistent snapshot and retain the reservation',async t=>{
 const f=await fixture(t);for(let n=0;n<101;n++)f.objects.set('synthetic/s'+n,{key:'synthetic/s'+n,size:0});
 const body=await f.ready();assert.equal(f.calls.length,3);assert.deepEqual(f.calls.map(c=>c.limit),[50,50,50]);assert.equal((await f.send(finish,body)).status,200);assert.equal(f.cap().reserved_bytes,R);
});
test('late synthetic R2 completion after scan is covered even with no receipt',async t=>{
 const f=await fixture(t),body=await f.ready();f.objects.set(f.r01.key,{key:f.r01.key,size:R});const r=await f.send(finish,body);assert.equal(r.status,200,JSON.stringify(r));assert(f.cap().used_bytes+f.cap().reserved_bytes>=[...f.objects.values()].reduce((n,o)=>n+o.size,0));assert.equal(f.cap().reserved_bytes,R);
});
test('positive receipt during LIST causes atomic page refusal, not lost accounting',async t=>{
 const f=await fixture(t),p=latch();f.setBeforeList(async()=>{p.enter();await p.wait});const request=f.send();await p.entered;
 f.normal(()=>f.sqlite.prepare("UPDATE storage_reservations SET state='committed',etag='synthetic' WHERE id=?").run(f.r01.id));p.release();const r=await request;assert.equal(r.status,409);assert.equal(f.cap().trusted_until,0);assert.equal(f.cap().used_bytes,BASE+R);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM storage_history').get().n,0);
});
test('receipt changes before Finalize refuse publication',async t=>{
 const f=await fixture(t),body=await f.ready();f.normal(()=>f.sqlite.prepare("UPDATE storage_reservations SET state='committed' WHERE id=?").run(f.r01.id));const r=await f.send(finish,body);assert.equal(r.status,409);assert.equal(r.error.code,'STORAGE_PENDING_SOURCE_CHANGED');assert.equal(f.cap().trusted_until,0);
});
test('control version changes before Finalize reject the old source snapshot',async t=>{
 const f=await fixture(t),body=await f.ready();f.sqlite.exec('UPDATE prelaunch_reset_control SET version=version+1');const r=await f.send(finish,body);assert.equal(r.status,409);assert.equal(r.error.code,'STORAGE_PENDING_SOURCE_CHANGED');assert.equal(f.cap().trusted_until,0);
});
test('original admission Trigger still rejects parallel uploads while Inventory is pinned',async t=>{
 const f=await fixture(t);await f.ready();assert.throws(()=>f.normal(()=>f.sqlite.prepare("INSERT INTO storage_reservations VALUES('new','synthetic/new',1,'reserved',1,NULL,NULL)").run()),/R2_STORAGE_CAPACITY_EXCEEDED/);assert.equal(f.cap().reserved_bytes,R);
});
test('known anomaly and unaccounted growth remain blocked, never excused as R01',async t=>{
 const f=await fixture(t);f.normal(()=>f.sqlite.prepare("UPDATE storage_capacity SET anomaly='WRITE_SIZE_MISMATCH',blocked=1").run());assert.equal((await f.send()).status,409);assert.equal(f.calls.length,0);assert.equal(f.cap().anomaly,'WRITE_SIZE_MISMATCH');
});
test('observing a late R01 object preserves the growth alarm and double-counts conservatively',async t=>{
 const f=await fixture(t);f.objects.set(f.r01.key,{key:f.r01.key,size:R});const body=await f.ready(),r=await f.send(finish,body);assert.equal(r.status,200);assert.equal(r.data.inventory.anomaly,'UNACCOUNTED_GROWTH');assert.equal(f.cap().blocked,1);assert.equal(f.cap().reserved_bytes,R);assert.equal(r.data.inventory.admission_bytes,BASE+2*R);
});
test('pending-key size beyond its reservation refuses trust publication',async t=>{
 const f=await fixture(t);f.objects.set(f.r01.key,{key:f.r01.key,size:R+1});const before=f.protectedRows(),r=await f.send();assert.equal(r.status,409);assert.equal(r.error.code,'STORAGE_PENDING_SIZE_MISMATCH');assert.equal(f.cap().trusted_until,0);assert.equal(f.protectedRows(),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM storage_history').get().n,0);
});
test('9.5GB decision includes retained reservations',async t=>{
 const f=await fixture(t),bytes=9500000000-R;f.objects.set('synthetic/base',{key:'synthetic/base',size:bytes});f.normal(()=>f.sqlite.prepare('UPDATE storage_capacity SET used_bytes=?').run(bytes));const body=await f.ready(),r=await f.send(finish,body);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.inventory.admission_bytes,9500000000);assert.equal(f.cap().blocked,1);assert.equal(f.cap().reserved_bytes,R);assert.equal(f.cap().anomaly,null);
});
test('Maintenance active/unknown busy protection still refuses before LIST or mutation',async t=>{
 const f=await fixture(t,{mode:'maintenance',extraPins:1}),before=f.protectedRows();const r=await f.send();assert.equal(r.status,409);assert.equal(f.calls.length,0);assert.equal(f.protectedRows(),before);assert.equal(f.cap().inventory_id,null);
});
test('Relay authorization and epoch checks still reject untrusted callers',async t=>{
 const f=await fixture(t);for(const extra of [{Authorization:'Bearer invalid'},{'X-VoteProof-Reset-Epoch':'0'},{Origin:origin}])assert.notEqual((await f.send(tick,{inventory_only:true},extra)).status,200);assert.equal(f.cap().inventory_id,null);assert.equal(f.calls.length,0);
});
test('Finalize commit ACK loss reads the durable receipt without resending the transaction',async t=>{
 const f=await fixture(t),body=await f.ready(),raw=f.env.DB;let commits=0;
 f.env.DB={...raw,async batch(statements){const result=await raw.batch(statements);if(statements.some(s=>s.sql.startsWith('INSERT INTO storage_history'))){commits++;throw Error('synthetic committed ACK lost')}return result}};
 const r=await f.send(finish,body);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.inventory.replayed,true);assert.equal(commits,1);assert.equal(f.cap().reserved_bytes,R);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='inventory'").get().n,1);assert.equal(f.pending().length,1);
});
test('Finalize failure rolls back History, Receipt and trust atomically',async t=>{
 const f=await fixture(t),body=await f.ready(),raw=f.env.DB,before=f.cap();let attempts=0;
 f.env.DB={...raw,async batch(statements){if(statements.some(s=>s.sql.startsWith('INSERT INTO storage_history'))){attempts++;return raw.batch([...statements,raw.prepare('SELECT * FROM synthetic_missing_table')])}return raw.batch(statements)}};
 const r=await f.send(finish,body);assert.equal(r.status,409);assert.equal(attempts,1);assert.deepEqual(f.cap(),before);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='inventory'").get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM storage_history').get().n,0);
});
test('Claim ACK loss creates one durable snapshot and never retries the unknown batch',async t=>{
 const f=await fixture(t),raw=f.env.DB;let claims=0;
 f.env.DB={...raw,async batch(statements){const result=await raw.batch(statements);if(statements.some(s=>s.sql.includes("'inventory_pending_snapshot'"))){claims++;throw Error('synthetic claim ACK lost')}return result}};
 const r=await f.send();assert.equal(r.status,409);assert.equal(r.error.code,'STORAGE_PENDING_CLAIM_UNKNOWN');assert.equal(claims,1);assert.equal(f.calls.length,0);assert(f.cap().inventory_id);assert.equal(f.cap().trusted_until,0);assert.equal(f.cap().reserved_bytes,R);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='inventory_pending_snapshot'").get().n,1);
});
test('a second reservation is never silently adopted into the single-pending mode',async t=>{
 const f=await fixture(t);f.normal(()=>f.sqlite.prepare("INSERT INTO storage_reservations VALUES('second','synthetic/second',1,'reserved',1,NULL,NULL)").run());const r=await f.send();assert.equal(r.status,409);assert.equal(r.error.code,'STORAGE_PENDING_SCOPE');assert.equal(f.calls.length,0);assert.equal(f.cap().reserved_bytes,R+1);
});
test('Legacy, V2 and Direct uploads still succeed after conservative Finalize without touching R01',async t=>{
 const f=await fixture(t),body=await f.ready(),before=f.pending();assert.equal((await f.send(finish,body)).status,200);
 for(const options of [{direct:false,storageVersion:1},{direct:false,storageVersion:2},{direct:true,storageVersion:2}]){
  const uploaded=await f.upload('PENDING-LOCAL',f.admin,options);assert(uploaded.p.uploads.length);assert.equal(f.cap().reserved_bytes,R);
 }
 assert.deepEqual(f.pending(),before);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM storage_reservations WHERE state='committed'").get().n,3);
});
async function startRealPut(f,t){
 const p=latch();f.setBeforePut(async()=>{p.enter();await p.wait});
 const prepare=await f.fetch('/api/uploads/prepare','POST',{storage_version:2,completion_mode:'direct',campaign_id:'PENDING-LOCAL',turnstile_token:'synthetic',files:[{name:'synthetic.png',type:'image/png',size:3,algorithm:'sha256',sha256:createHash('sha256').update(image).digest('hex')}]},{Origin:origin,...f.admin.headers});
 assert.equal(prepare.status,200);const data=(await prepare.json()).data,u=data.uploads[0];
 const put=worker.fetch(new Request(u.upload_url,{method:'PUT',headers:{Origin:origin,...f.admin.headers,...u.headers,'Content-Length':'3'},body:image}),f.env);
 await Promise.race([p.entered,put.then(r=>{throw Error('PUT ended before latch: '+r.status)})]);
 const clock=Date.now;t.mock.method(Date,'now',()=>clock()+301000);
 return{put,p,data};
}
test('real Direct Handler PUT can finish after conservative Finalize without losing bytes',async t=>{
 const f=await fixture(t,{seed:false}),{put,p}=await startRealPut(f,t);assert.equal(f.cap().reserved_bytes,3);
 const body=await f.ready(),r=await f.send(finish,body);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.inventory.pending_bytes,3);const before=f.cap().used_bytes+f.cap().reserved_bytes;p.release();const result=await put;assert.equal(result.status,200);assert.equal(f.cap().used_bytes+f.cap().reserved_bytes,before);assert.equal(f.cap().used_bytes,BASE+3);assert.equal(f.cap().reserved_bytes,0);
});
test('real Direct PUT lost native ACK retains Pin/UNKNOWN and is covered after the last scan',async t=>{
 const f=await fixture(t,{seed:false}),{put,p}=await startRealPut(f,t);const body=await f.ready();f.setAfterPut(async()=>{throw Error('synthetic native ACK lost')});p.release();const result=await put;assert.equal(result.status,502);assert.equal(f.cap().reserved_bytes,3);assert.equal(f.pending().length,1);
 const r=await f.send(finish,body);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.inventory.admission_bytes,BASE+3);assert.equal(f.cap().reserved_bytes,3);assert.equal(f.pending().length,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown' AND pending_r2=1").get().n,1);
});
