import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{randomUUID,createHash}from'node:crypto';
import worker from'../src/index.js';import{fencedRequest}from'../src/lib/prelaunch-reset-fence.js';
import{memberSession,csrfToken}from'../src/lib/auth-session.js';
import{embeddedCaseRuntime,origin,image}from'./helpers/embedded-case-runtime.mjs';
import{installResetExtensionLocal}from'../scripts/lib/prelaunch-selective-reset.mjs';
import{BatchSubmission}from'../public/js/submission.js';import{PublicError}from'../public/js/api.js';
let siteverifyCalls=0;
globalThis.fetch=async url=>{if(String(url)!=='https://challenges.cloudflare.com/turnstile/v0/siteverify')throw Error('OFFLINE_ONLY');siteverifyCalls++;return Response.json({success:true});};
const kind={legacy:{storageVersion:1,direct:false,files:2},v2:{storageVersion:2,direct:false,files:1},direct:{storageVersion:2,direct:true,files:1}};
const latch=()=>{let arrive,release;return{arrived:new Promise(r=>arrive=r),held:new Promise(r=>release=r),arrive:()=>arrive(),release:()=>release()};};
async function setup(t){
 const rt=await embeddedCaseRuntime();t.after(()=>rt.close());const actor=await rt.identity('admin');
 rt.sqlite.exec('UPDATE submission_settings SET submissions_enabled=1');
 rt.sqlite.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at) VALUES('ADMIT-LOCAL','Synthetic','團體','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','Asia/Taipei','2000-01-01','2099-12-31',10,'active',?,?)").run(new Date().toISOString(),new Date().toISOString());
 installResetExtensionLocal(rt.sqlite,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));
 rt.sqlite.exec("UPDATE prelaunch_reset_control SET epoch=1,mode='open'");rt.env.PRELAUNCH_RESET_FENCE_ENABLED='true';rt.env.R2_EXCLUSIVE_WRITER_CONFIRMED='true';
 const member=await memberSession(new Request(origin,{headers:actor.headers}),rt.env);
 actor.headers['X-CSRF-Token']=await csrfToken(member,{...rt.env,PRELAUNCH_RESET_CONTEXT:{epoch:1}});
 let puts=0,deletes=0;const rawPut=rt.bucket.put,rawDelete=rt.bucket.delete;
 rt.bucket.put=async(...args)=>{puts++;return rawPut(...args);};rt.bucket.delete=async(...args)=>{deletes++;return rawDelete(...args);};rt.bucket.list=async()=>({objects:[],truncated:false});
 const read=sql=>({...rt.sqlite.prepare(sql).get()});
 const state=()=>({pins:read('SELECT COUNT(*) n FROM proof_upload_intents WHERE write_token IS NOT NULL').n,reserved:read("SELECT COUNT(*) n FROM storage_reservations WHERE state='reserved'").n,unknown:read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").n,active:read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='active'").n,permit:read('SELECT COUNT(*) n FROM prelaunch_reset_permit').n});
 async function prepare(mode,{member=false}={}){const k=kind[mode],headers=member?actor.headers:{Origin:origin};const r=await rt.fetch('/api/uploads/prepare','POST',{...(k.storageVersion===2?{storage_version:2,campaign_id:'ADMIT-LOCAL'}:{}),...(k.direct?{completion_mode:'direct'}:{}),turnstile_token:'synthetic',files:Array.from({length:k.files},(_,i)=>({name:i+'.png',type:'image/png',size:image.length,algorithm:'sha256',sha256:createHash('sha256').update(image).digest('hex')}))},headers);assert.equal(r.status,200,await r.clone().text());return{data:(await r.json()).data,headers,mode};}
 const put=(p,i=0)=>{const u=p.data.uploads[i];return worker.fetch(new Request(u.upload_url,{method:'PUT',headers:{...u.headers,...p.headers,'Content-Length':String(image.length)},body:image}),rt.env);};
 async function scan(){return rt.fetch('/api/internal/drive-backup/storage/tick','POST',{inventory_only:true},{Authorization:'Bearer '+rt.env.DRIVE_BACKUP_RELAY_SECRET,'X-VoteProof-Reset-Epoch':'1'});}
 async function finish(){const s=read('SELECT inventory_id,inventory_version FROM storage_capacity');return rt.fetch('/api/internal/drive-backup/storage/inventory/finalize','POST',s,{Authorization:'Bearer '+rt.env.DRIVE_BACKUP_RELAY_SECRET,'X-VoteProof-Reset-Epoch':'1'});}
 return{...rt,actor,read,state,prepare,put,scan,finish,counts:()=>({puts,deletes}),rawPut};
}
for(const mode of Object.keys(kind))test(mode+': actual prepare, PUT, complete and case linkage retain the normal contract',async t=>{
 const f=await setup(t),p=await f.prepare(mode,{member:mode==='direct'});
 for(let i=0;i<p.data.uploads.length;i++)assert.equal((await f.put(p,i)).status,200);
 const ref={session_id:p.data.session_id,keys:p.data.uploads.map(u=>u.key),...(p.data.capability?{capability:p.data.capability}:{})};
 if(mode!=='direct'){const r=await f.fetch('/api/uploads/complete','POST',ref,p.headers);assert.equal(r.status,200,await r.clone().text());}
 const r=await f.fetch(mode==='direct'?'/api/cases/direct':'/api/cases','POST',{campaign_id:'ADMIT-LOCAL',vote_date:new Date().toISOString().slice(0,10),upload_session:ref},{...p.headers,'Idempotency-Key':randomUUID()});
 assert.equal(r.status,201,await r.clone().text());assert.equal(f.read('SELECT COUNT(*) n FROM case_files').n,kind[mode].files);
 assert.deepEqual(f.state(),{pins:0,reserved:0,unknown:0,active:0,permit:0});
});
for(const member of [false,true])for(const mode of Object.keys(kind))test((member?'member ':'guest ')+mode+': inventory first rejects PUT without native IO, leaked pin, reservation or UNKNOWN; finalize permits same-grant retry',async t=>{
 const f=await setup(t),p=await f.prepare(mode,{member});assert.equal((await f.scan()).status,200);
 const before=f.counts().puts,r=await f.put(p);assert.equal(r.status,503,await r.clone().text());assert.equal((await r.json()).error.code,'R2_STORAGE_INVENTORY_BUSY');
 assert.equal(f.counts().puts,before);assert.deepEqual(f.state(),{pins:0,reserved:0,unknown:0,active:0,permit:0});
 assert.equal((await f.finish()).status,200);assert.equal((await f.put(p)).status,200);
});
for(const mode of Object.keys(kind))test(mode+': atomic pin/reservation wins before inventory; native IO latch keeps scan out',async t=>{
 const f=await setup(t),p=await f.prepare(mode),hold=latch(),original=f.bucket.put;
 f.bucket.put=async(...args)=>{hold.arrive();await hold.held;return original(...args);};const pending=f.put(p);await hold.arrived;
 assert.equal(f.state().pins,mode==='legacy'?0:1);assert.equal(f.state().reserved,1);assert.equal((await f.scan()).status,409);
 hold.release();assert.equal((await pending).status,200);assert.equal(f.state().pins,0);assert.equal(f.state().reserved,0);assert.equal(f.state().unknown,0);
});
test('inventory wins immediately before the atomic admission batch: deterministic denial, no partial pin',async t=>{
 const f=await setup(t),p=await f.prepare('direct'),raw=f.env.DB,hold=latch();let held=false;
 f.env.DB={...raw,batch:async xs=>{if(!held&&xs.some(s=>s.sql.startsWith('UPDATE proof_upload_intents SET write_token='))){held=true;hold.arrive();await hold.held;}return raw.batch(xs);}};
 const pending=f.put(p);await hold.arrived;assert.equal((await f.scan()).status,200);hold.release();assert.equal((await pending).status,503);
 assert.deepEqual(f.state(),{pins:0,reserved:0,unknown:0,active:0,permit:0});assert.equal(f.counts().puts,0);
});
for(const mode of ['v2','direct'])test(mode+': two legitimate requests for the same Grant cannot acquire a second pin or PUT',async t=>{
 const f=await setup(t),p=await f.prepare(mode),hold=latch(),original=f.bucket.put;
 f.bucket.put=async(...args)=>{hold.arrive();await hold.held;return original(...args);};const first=f.put(p);await hold.arrived;
 const second=await f.put(p);assert.equal(second.status,409);assert.equal(f.state().pins,1);assert.equal(f.state().reserved,1);assert.equal(f.state().unknown,0);
 hold.release();assert.equal((await first).status,200);assert.equal(f.counts().puts,1);assert.equal(f.state().pins,0);
});
test('Legacy same-key replay retains its SHA-bound contract and conservatively counts both admitted writes',async t=>{
 const f=await setup(t),p=await f.prepare('legacy'),hold=latch(),original=f.bucket.put;let calls=0;
 f.bucket.put=async(...args)=>{if(++calls===1){hold.arrive();await hold.held;}return original(...args);};
 const first=f.put(p);await hold.arrived;assert.equal((await f.put(p)).status,200);assert.equal(f.state().reserved,1);assert.equal((await f.scan()).status,409);
 hold.release();assert.equal((await first).status,200);assert.equal(f.counts().puts,2);
 const obj=await f.bucket.head(p.data.uploads[0].key);assert.equal(obj.etag,createHash('sha256').update(image).digest('hex'));
 assert.equal(f.read('SELECT used_bytes FROM storage_capacity').used_bytes,image.length*2);
 assert.deepEqual(f.state(),{pins:0,reserved:0,unknown:0,active:0,permit:0});
});
for(const mode of ['legacy','direct'])for(const stage of ['before_commit','after_commit'])test(mode+': D1 admission ACK unknown '+stage+' stays UNKNOWN, does not send native PUT or retry',async t=>{
 const f=await setup(t),p=await f.prepare(mode),raw=f.env.DB;let batches=0;
 f.env.DB={...raw,batch:async xs=>{if(xs.some(s=>s.sql.startsWith('INSERT INTO storage_reservations('))){batches++;if(stage==='after_commit')await raw.batch(xs);throw Error('synthetic unknown ACK');}return raw.batch(xs);}};
 assert.equal((await f.put(p)).status,502);assert.equal(batches,1);assert.equal(f.counts().puts,0);assert.equal(f.state().unknown,1);
 assert.equal(f.state().pins,stage==='after_commit'&&mode!=='legacy'?1:0);assert.equal(f.state().reserved,stage==='after_commit'?1:0);
});
test('reservation Trigger abort rolls back the pin, keeps UNKNOWN evidence and is never retried',async t=>{
 const f=await setup(t),p=await f.prepare('direct');f.sqlite.exec("CREATE TRIGGER local_admission_fault BEFORE INSERT ON storage_reservations BEGIN SELECT RAISE(ABORT,'synthetic admission fault');END");
 assert.equal((await f.put(p)).status,502);assert.equal(f.state().pins,0);assert.equal(f.state().reserved,0);assert.equal(f.state().unknown,1);assert.equal(f.counts().puts,0);
});
test('native R2 committed then ACK lost keeps Pin/Reservation/UNKNOWN; another caller cannot unlock it',async t=>{
 const f=await setup(t),p=await f.prepare('direct'),original=f.bucket.put;
 f.bucket.put=async(...args)=>{await original(...args);throw Error('synthetic R2 ACK lost');};
 assert.equal((await f.put(p)).status,502);assert.equal(f.state().pins,1);assert.equal(f.state().reserved,1);assert.equal(f.state().unknown,1);
 const old=f.state(),n=f.counts().puts;assert.equal((await f.put(p)).status,409);assert.deepEqual(f.state(),old);assert.equal(f.counts().puts,n);assert.equal(f.counts().deletes,0);
});
test('D1 reservation receipt lost after native success retains Pin and UNKNOWN without duplicating R2 IO',async t=>{
 const f=await setup(t),p=await f.prepare('direct'),raw=f.env.DB;let lost=false;
 f.env.DB={...raw,batch:async xs=>{const r=await raw.batch(xs);if(!lost&&xs.some(s=>s.sql.includes("UPDATE storage_reservations SET state='committed'"))){lost=true;throw Error('synthetic reservation receipt lost');}return r;}};
 assert.equal((await f.put(p)).status,503);assert.equal(lost,true);assert.equal(f.state().pins,1);assert.equal(f.state().unknown,1);assert.equal(f.counts().puts,1);assert.equal(f.counts().deletes,0);
 assert.equal(f.read("SELECT COUNT(*) n FROM storage_reservations WHERE state='committed'").n,1);
});
test('capacity threshold and expiry checks remain authoritative; rejection leaves no new pin',async t=>{
 const f=await setup(t),p=await f.prepare('direct');
 await fencedRequest(f.env,new Request(origin+'/api/local-fixture',{method:'POST'}),async env=>{await env.DB.prepare('UPDATE storage_capacity SET used_bytes=9499999999').run();return Response.json({ok:true});});
 assert.equal((await f.put(p)).status,503);assert.equal(f.state().pins,0);assert.equal(f.state().reserved,0);assert.equal(f.state().unknown,0);assert.equal(f.counts().puts,0);
});
test('expired capacity snapshot is a known no-op, not a failed write or permission to clear an old pin',async t=>{
 const f=await setup(t),p=await f.prepare('direct');
 await fencedRequest(f.env,new Request(origin+'/api/local-fixture',{method:'POST'}),async env=>{await env.DB.prepare('UPDATE storage_capacity SET trusted_until=0').run();return Response.json({ok:true});});
 assert.equal((await f.put(p)).status,503);assert.deepEqual(f.state(),{pins:0,reserved:0,unknown:0,active:0,permit:0});assert.equal(f.counts().puts,0);
});
for(const change of ["mode='maintenance'",'epoch=2'])test('control '+change+' before admission cannot authorize late native IO',async t=>{
 const f=await setup(t),p=await f.prepare('direct'),raw=f.env.DB,hold=latch();let held=false;
 f.env.DB={...raw,batch:async xs=>{if(!held&&xs.some(s=>s.sql.startsWith('UPDATE proof_upload_intents SET write_token='))){held=true;hold.arrive();await hold.held;}return raw.batch(xs);}};
 const pending=f.put(p);await hold.arrived;f.sqlite.exec('UPDATE prelaunch_reset_control SET '+change);hold.release();
 // Maintenance can abort at the existing per-table Trigger (sanitized 502),
 // whereas an epoch change returns the outer 409. Neither is an ACK to retry.
 assert.equal((await pending).status,change.startsWith('mode')?502:409);assert.equal(f.counts().puts,0);assert.equal(f.state().pins,0);assert.equal(f.state().reserved,0);assert.equal(f.state().unknown,1);
});
test('missing zero-row D1 metadata cannot be used as an acknowledged no-write receipt',async t=>{
 const f=await setup(t),p=await f.prepare('direct');assert.equal((await f.scan()).status,200);const raw=f.env.DB;
 f.env.DB={...raw,batch:async xs=>{const r=await raw.batch(xs);if(xs.some(s=>s.sql.startsWith('UPDATE proof_upload_intents SET write_token=')))delete r[1].meta;return r;}};
 assert.equal((await f.put(p)).status,503);assert.equal(f.state().unknown,1);assert.equal(f.counts().puts,0);assert.equal(f.state().pins,0);
});
test('changed admission result after a real commit is UNKNOWN and cannot clear Pin/Reservation',async t=>{
 const f=await setup(t),p=await f.prepare('direct'),raw=f.env.DB;
 f.env.DB={...raw,batch:async xs=>{const r=await raw.batch(xs);if(xs.some(s=>s.sql.startsWith('UPDATE proof_upload_intents SET write_token=')))r[2].results[0].id=randomUUID();return r;}};
 const r=await f.put(p);assert.equal(r.status,503);const text=await r.text();assert.equal(text.includes('proofs/'),false);
 assert.equal(f.state().unknown,1);assert.equal(f.state().pins,1);assert.equal(f.state().reserved,1);assert.equal(f.counts().puts,0);
});

for(const change of ["blocked=1","anomaly='SYNTHETIC_ANOMALY'",'used_bytes=9500000000'])test(change+': active inventory never masks a real safety stop as Busy',async t=>{
 const f=await setup(t),p=await f.prepare('direct');assert.equal((await f.scan()).status,200);
 await fencedRequest(f.env,new Request(origin+'/api/local-fixture',{method:'POST'}),async env=>{await env.DB.prepare('UPDATE storage_capacity SET '+change).run();return Response.json({ok:true});});
 const r=await f.put(p);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'R2_STORAGE_CAPACITY_EXCEEDED');
 assert.equal(f.counts().puts,0);assert.equal(f.state().pins,0);assert.equal(f.state().reserved,0);assert.equal(f.state().unknown,0);
});

test('same-intent existing UNKNOWN pin/reservation cannot be labeled retryable stale capacity',async t=>{
 const f=await setup(t),p=await f.prepare('direct'),original=f.bucket.put;
 f.bucket.put=async(...args)=>{await original(...args);throw Error('synthetic lost native ACK');};
 assert.equal((await f.put(p)).status,502);const before=f.state();assert.equal(before.unknown,1);assert.equal(before.pins,1);assert.equal(before.reserved,1);
 await fencedRequest(f.env,new Request(origin+'/api/local-fixture',{method:'POST'}),async env=>{await env.DB.prepare('UPDATE storage_capacity SET trusted_until=0').run();return Response.json({ok:true});});
 const r=await f.put(p);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'R2_STORAGE_CAPACITY_EXCEEDED');
 assert.deepEqual(f.state(),before);assert.equal(f.counts().puts,1);assert.equal(f.counts().deletes,0);
});

test('known denial adds one indexed diagnostic read; normal success and unknown admission ACK do not',async t=>{
 const f=await setup(t),p=await f.prepare('direct'),raw=f.env.DB;let diagnostics=0,diagnosticSQL;
 f.env.DB={...raw,prepare:sql=>{if(sql.includes(' AS object_reserved')){diagnostics++;diagnosticSQL=sql;}return raw.prepare(sql);}};
 assert.equal((await f.scan()).status,200);assert.equal((await f.put(p)).status,503);assert.equal(diagnostics,1);
 const plan=f.sqlite.prepare('EXPLAIN QUERY PLAN '+diagnosticSQL).all(p.data.uploads[0].key,p.data.uploads[0].key).map(x=>x.detail);
 assert.ok(plan.some(x=>/storage_reservations.*USING COVERING INDEX storage_object_writers/.test(x)),plan.join('\n'));
 assert.ok(plan.some(x=>/proof_upload_intents.*USING INDEX/.test(x)),plan.join('\n'));
 assert.equal((await f.finish()).status,200);assert.equal((await f.put(p)).status,200);assert.equal(diagnostics,1);
 const next=await f.prepare('direct');
 f.env.DB={...f.env.DB,batch:async xs=>{if(xs.some(s=>s.sql.startsWith('INSERT INTO storage_reservations(')))throw Error('synthetic unknown admission ACK');return raw.batch(xs);}};
 assert.equal((await f.put(next)).status,502);assert.equal(diagnostics,1);assert.equal(f.state().unknown,1);
});

for(const member of [false,true])for(const count of [1,3,20])test((member?'member':'guest')+' real '+count+'-image batch resumes after Inventory with one verification and independent cases',async t=>{
 const previous=globalThis.location;globalThis.location={origin};t.after(()=>{globalThis.location=previous;});
 const f=await setup(t),verifiedBefore=siteverifyCalls,headers=member?f.actor.headers:{Origin:origin};
 let clock=Date.now(),started=false,sleeps=0,tokens=0,denied=0;
 const api=async(path,options={})=>{const r=await f.fetch(path,options.method??'GET',typeof options.body==='string'?JSON.parse(options.body):options.body,headers);const b=await r.json();if(!r.ok||!b.ok)throw new PublicError(b.error?.code??'SERVICE_UNAVAILABLE',r.status);return b.data;};
 const flow=new BatchSubmission({api,now:()=>clock,token:async()=>{tokens++;return'synthetic';},sleep:async ms=>{sleeps++;clock+=ms;assert.equal((await f.finish()).status,200);},
  put:async upload=>{
   if(!started){started=true;assert.equal((await f.scan()).status,200);}
   const r=await worker.fetch(new Request(upload.upload_url,{method:'PUT',headers:{...upload.headers,...headers,'Content-Length':String(image.length)},body:image}),f.env);
   if(r.ok)return;
   denied++;const b=await r.json();assert.equal(b.error.code,'R2_STORAGE_INVENTORY_BUSY');assert.equal(f.counts().puts,0);
   throw Object.assign(new PublicError(b.error.code,r.status),{putRejected:r.headers.get('X-VoteProof-Upload-Rejected')==='1',putState:r.headers.get('X-VoteProof-Put-State'),uploadStage:r.headers.get('X-VoteProof-Upload-Stage')});
  }});
 flow.start({campaign_id:'ADMIT-LOCAL',vote_date:new Date().toISOString().slice(0,10)},Array.from({length:count},(_,i)=>({name:i+'.png',type:'image/png',size:image.length,arrayBuffer:async()=>image.slice().buffer})),{caseApi:api});
 const result=await flow.attempt();assert.equal(result.complete,true);assert.equal(result.succeeded,count);assert.equal(tokens,1);assert.equal(siteverifyCalls-verifiedBefore,1);
 // Both admitted client lanes can see the same scan; they share a single wait.
 assert.equal(sleeps,1);assert.equal(denied,Math.min(count,2));assert.equal(f.counts().puts,count);assert.equal(f.counts().deletes,0);assert.equal(f.read('SELECT COUNT(*) n FROM cases').n,count);
 assert.equal(new Set(result.items.map(i=>i.result.case_id)).size,count);assert.deepEqual(f.state(),{pins:0,reserved:0,unknown:0,active:0,permit:0});
 const writes=f.counts().puts;await flow.attempt();assert.equal(f.counts().puts,writes);assert.equal(f.read('SELECT COUNT(*) n FROM cases').n,count);
});
