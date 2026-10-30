import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash,randomBytes,randomUUID}from'node:crypto';
import worker from '../src/index.js';import {embeddedCaseRuntime,origin,image}from'./helpers/embedded-case-runtime.mjs';
import {installResetExtensionLocal}from'../scripts/lib/prelaunch-selective-reset.mjs';
import {uploadGrantConfig,issueUploadGrant,readUploadGrant}from'../src/lib/upload-grant.js';
import {api,putImage,PublicError}from'../public/js/api.js';import {BatchSubmission,Submission}from'../public/js/submission.js';
globalThis.location={origin};
const hash=s=>createHash('sha256').update(s).digest('hex');
const latch=()=>{let enter,release;return{started:new Promise(r=>enter=r),held:new Promise(r=>release=r),enter:()=>enter(),release:()=>release()};};
async function fixture(t,{mode='normal',direct=true}={}){
 const rt=await embeddedCaseRuntime(),requests=[],keyForURL=new Map(),holds=new Map(),pending=[],attempted=new WeakSet(),lostCases=new Set();
 rt.sqlite.exec('UPDATE submission_settings SET submissions_enabled=1');
 rt.sqlite.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at) VALUES('UPLOAD-LOCAL','Synthetic','團體','2000-01-01','2100-01-01','Asia/Taipei','2000-01-01','2099-12-31',10,'active',?,?)").run(new Date().toISOString(),new Date().toISOString());
 installResetExtensionLocal(rt.sqlite,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));rt.sqlite.exec("UPDATE prelaunch_reset_control SET epoch=1,mode='open'");rt.env.PRELAUNCH_RESET_FENCE_ENABLED='true';
 let nativePuts=0,httpPuts=0,clock=Date.now();const native=rt.bucket.put;
 rt.bucket.put=async(...a)=>{nativePuts++;const hold=holds.get(a[0]);if(hold){hold.enter();await hold.held;}const value=await native(...a);if(mode==='native_ack_lost')throw Error('synthetic private provider error');return value;};
 const oldXHR=globalThis.XMLHttpRequest;
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(String(url)==='https://challenges.cloudflare.com/turnstile/v0/siteverify')return Response.json({success:true});
  assert.ok(String(url).startsWith('/api/'));requests.push({path:String(url),bodyHash:options.body?hash(options.body):null,idempotencyHash:options.headers?.['Idempotency-Key']?hash(options.headers['Idempotency-Key']):null});
  const r=await worker.fetch(new Request(origin+url,{...options,headers:{Origin:origin,...options.headers}}),rt.env);
  if(String(url).endsWith('/prepare')&&r.ok){const p=(await r.clone().json()).data;for(const u of p.uploads)keyForURL.set(u.upload_url,u.key);}
  if(mode==='case_ack_lost'&&String(url).endsWith('/cases/direct')&&r.ok&&!lostCases.has(options.headers['Idempotency-Key'])){lostCases.add(options.headers['Idempotency-Key']);throw Error('synthetic case ACK lost');}
  return r;
 });
 globalThis.XMLHttpRequest=class{
  constructor(){this.upload={};this.headers={};this.responseHeaders=new Headers();}
  open(method,url){assert.equal(method,'PUT');this.url=url;}
  setRequestHeader(k,v){this.headers[k]=v;}
  getResponseHeader(k){return this.responseHeaders.get(k);}
  send(file){httpPuts++;const req=new Request(this.url,{method:'PUT',headers:{Origin:origin,...this.headers,'Content-Length':String(file.size)},body:file});
   const run=async()=>{
    if(mode==='pending_native'){
     const hold=latch();holds.set(keyForURL.get(this.url),hold);const response=worker.fetch(req,rt.env);pending.push(response);await hold.started;this.ontimeout();await response;return;
    }
    const expire=(mode==='expired_each'||mode==='expired_partial'&&file.name==='proof-1.png')&&!attempted.has(file);attempted.add(file);
    const now=Date.now;let response;
    try{if(expire)Date.now=()=>now()+301000;response=await worker.fetch(req,rt.env);}finally{Date.now=now;}
    this.status=response.status;this.responseHeaders=response.headers;this.responseText=await response.text();this.onload();
   };run().catch(()=>this.onerror());
  }
 };
 t.after(async()=>{for(const h of holds.values())h.release();await Promise.allSettled(pending);globalThis.XMLHttpRequest=oldXHR;rt.close();});
 // Expiry fault injection temporarily changes process Date.now: keep this legacy fixture serial.
 const batch=new BatchSubmission({concurrency:1,api,put:putImage,token:async()=>randomUUID(),now:()=>clock,directIntent:direct});
 const start=n=>batch.start({campaign_id:'UPLOAD-LOCAL',vote_date:new Date().toISOString().slice(0,10)},Array.from({length:n},(_,i)=>new File([image],'proof-'+i+'.png',{type:'image/png'})));
 const count=sql=>rt.sqlite.prepare(sql).get().n;
 return{...rt,batch,start,requests,keyForURL,nativePuts:()=>nativePuts,httpPuts:()=>httpPuts,count,advance:ms=>clock+=ms,finish:async()=>{for(const h of holds.values())h.release();await Promise.all(pending);}};
}
for(const n of [1,3,10,20]){
 test(n+' images: real expired Grant 403 cannot reach Direct Case; retry issues fresh Grants once',async t=>{
  const f=await fixture(t,{mode:'expired_each'});f.start(n);const first=await f.batch.attempt();
  assert.equal(first.failed,n);assert.ok(first.items.every(i=>i.error==='UPLOAD_GRANT_INVALID'));assert.equal(f.nativePuts(),0);assert.equal(f.requests.filter(r=>r.path==='/api/cases/direct').length,0);
  assert.equal(f.count('SELECT COUNT(*) n FROM proof_upload_intents WHERE write_token IS NOT NULL'),0);assert.equal(f.count("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'"),0);
  assert.equal((await f.batch.attempt()).succeeded,n);assert.equal(f.nativePuts(),n);assert.equal(f.requests.filter(r=>r.path.endsWith('/prepare')).length,n*2);assert.equal(f.count('SELECT COUNT(*) n FROM cases'),n);
  const calls=f.requests.length;await f.batch.attempt();assert.equal(f.requests.length,calls);
 });
 test(n+' images: genuine native ACK loss verifies same intent; successful cases are never resent',async t=>{
  const f=await fixture(t,{mode:'native_ack_lost'});f.start(n);assert.equal((await f.batch.attempt()).succeeded,n);
  assert.equal(f.nativePuts(),n);assert.equal(f.count('SELECT COUNT(*) n FROM cases'),n);assert.equal(f.count('SELECT COUNT(*) n FROM proof_upload_intents WHERE write_token IS NOT NULL'),n);assert.equal(f.count("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'"),n);
  await f.batch.attempt();assert.equal(f.nativePuts(),n);assert.equal(f.count('SELECT COUNT(*) n FROM cases'),n);
 });
 test(n+' images: late native PUT + missing HEAD never replays PUT; later Case uses identical key/body',async t=>{
  const f=await fixture(t,{mode:'pending_native'});f.start(n);assert.equal((await f.batch.attempt()).unknown,n);assert.equal(f.nativePuts(),n);
  const cases1=f.requests.filter(r=>r.path==='/api/cases/direct');assert.equal(cases1.length,n);f.advance(301000);
  assert.equal((await f.batch.attempt()).unknown,n);assert.equal(f.nativePuts(),n);assert.equal(f.requests.filter(r=>r.path.endsWith('/prepare')).length,n);
  assert.equal(f.count('SELECT COUNT(*) n FROM proof_upload_intents WHERE write_token IS NOT NULL'),n);
  await f.finish();assert.equal((await f.batch.attempt()).succeeded,n);assert.equal(f.nativePuts(),n);assert.equal(f.count('SELECT COUNT(*) n FROM cases'),n);
  const cases=f.requests.filter(r=>r.path==='/api/cases/direct');for(let i=0;i<n;i++){assert.equal(cases[i].bodyHash===cases[i+n].bodyHash&&cases[i].bodyHash===cases[i+2*n].bodyHash,true);assert.equal(cases[i].idempotencyHash===cases[i+2*n].idempotencyHash,true);}
 });
 test(n+' images: lost Case ACK retains exact payload/key after expiry, with no duplicate successful Case',async t=>{
  const f=await fixture(t,{mode:'case_ack_lost'});f.start(n);assert.equal((await f.batch.attempt()).unknown,n);assert.equal(f.count('SELECT COUNT(*) n FROM cases'),n);
  f.advance(86400000);assert.equal((await f.batch.attempt()).succeeded,n);assert.equal(f.nativePuts(),n);assert.equal(f.count('SELECT COUNT(*) n FROM cases'),n);
  const cs=f.requests.filter(r=>r.path==='/api/cases/direct');for(let i=0;i<n;i++){assert.equal(cs[i].bodyHash===cs[i+n].bodyHash,true);assert.equal(cs[i].idempotencyHash===cs[i+n].idempotencyHash,true);}
 });
}
test('partial 3-image batch renews only rejected item, keeping two successful receipts',async t=>{
 const f=await fixture(t,{mode:'expired_partial'});f.start(3);assert.equal((await f.batch.attempt()).succeeded,2);assert.equal((await f.batch.attempt()).succeeded,3);
 assert.equal(f.httpPuts(),4);assert.equal(f.nativePuts(),3);assert.equal(f.requests.filter(r=>r.path.endsWith('/prepare')).length,4);assert.equal(f.count('SELECT COUNT(*) n FROM cases'),3);
});
for(const status of [403,502])test('old frontend adapter PUT_FAILED HTTP'+status+' cannot be promoted to unknown-native success',async t=>{
 const f=await fixture(t);let puts=0;f.batch.dependencies.put=async()=>{puts++;throw new PublicError('PUT_FAILED',status);};f.start(1);
 assert.equal((await f.batch.attempt()).unknown,1);assert.equal((await f.batch.attempt()).unknown,1);assert.equal(f.batch.summary.items[0].recovery,'hold');assert.equal(puts,1);assert.equal(f.requests.filter(r=>r.path==='/api/cases/direct').length,0);assert.equal(f.nativePuts(),0);
});
test('Legacy unknown PUT is verified with Complete, never resent after missing HEAD or expired Grant',async t=>{
 const f=await fixture(t,{mode:'pending_native',direct:false});f.start(1);assert.equal((await f.batch.attempt()).unknown,1);
 f.advance(301000);assert.equal((await f.batch.attempt()).unknown,1);assert.equal(f.nativePuts(),1);assert.equal(f.requests.filter(r=>r.path.endsWith('/prepare')).length,1);
 await f.finish();assert.equal((await f.batch.attempt()).succeeded,1);assert.equal(f.nativePuts(),1);assert.equal(f.count('SELECT COUNT(*) n FROM cases'),1);
});
test('true Legacy v1 partial Grant expiry retains known writes and holds rather than duplicating them',async t=>{
 const f=await fixture(t,{mode:'expired_partial',direct:false}),flow=new Submission({api,put:putImage,token:async()=>randomUUID()});
 flow.start({campaign_id:'UPLOAD-LOCAL',vote_date:new Date().toISOString().slice(0,10)},Array.from({length:3},(_,i)=>new File([image],'proof-'+i+'.png',{type:'image/png'})));
 await assert.rejects(flow.attempt(),{code:'UPLOAD_GRANT_INVALID',status:403});assert.equal(f.count('SELECT COUNT(*) n FROM cases'),0);
 await assert.rejects(flow.attempt(),{code:'PUT_RESULT_UNCONFIRMED'});assert.equal(flow.recovery,'hold');assert.equal(f.nativePuts(),1);assert.equal(f.count('SELECT COUNT(*) n FROM cases'),0);assert.equal(f.count('SELECT COUNT(*) n FROM proof_upload_intents'),0);
 assert.equal(f.requests.filter(r=>r.path.endsWith('/prepare')).length,1);assert.equal(f.count("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'"),0);
});
for(const version of [1,2])test('Grant v'+version+': 300-second boundary, path, reuse and cipher mismatch are distinct from native ACK',async t=>{
 const env={AUTH_ORIGIN:origin,UPLOAD_GRANT_SECRET:randomBytes(32).toString('hex'),PROOFS_BUCKET:{put(){assert.fail('Grant validation must not call native PUT');}}},config=await uploadGrantConfig(env),s=randomUUID(),p=randomUUID(),pathname='/api/uploads/put/'+s+'/'+p,expires=Math.floor(Date.now()/1000)+300;
 const u=await issueUploadGrant(config,pathname,'proofs/local', {size:3,type:'image/png',sha256:'a'.repeat(64)},version===2?{sessionId:s,proofId:p,expires}:undefined),req=new Request(u.upload_url,{headers:u.headers});
 assert.equal((await readUploadGrant(env,req,pathname)).v,version);assert.equal((await readUploadGrant(env,req,pathname)).v,version);
 await assert.rejects(readUploadGrant(env,req,pathname+'-changed'),e=>e.code==='UPLOAD_GRANT_INVALID'&&e.uploadGrantReason==='path');
 await assert.rejects(readUploadGrant({...env,UPLOAD_GRANT_SECRET:randomBytes(32).toString('hex')},req,pathname),e=>e.uploadGrantReason==='invalid');
 const now=Date.now;t.mock.method(Date,'now',()=>expires*1000-1);assert.equal((await readUploadGrant(env,req,pathname)).v,version);Date.now=()=>expires*1000;
 await assert.rejects(readUploadGrant(env,req,pathname),e=>e.uploadGrantReason==='expired');Date.now=now;
});
const faults={reset_issuance:/^SELECT epoch,keys_json FROM prelaunch_reset_issuance/,submission_gate:/^SELECT .*submissions_enabled.*FROM submission_settings/i,intent_read:/^SELECT \* FROM proof_upload_intents/,capacity_admission:/^UPDATE proof_upload_intents SET write_token=/,r2_fence:/^SELECT object_key FROM prelaunch_reset_retired_keys/,r2_dispatch:/^UPDATE prelaunch_reset_operations SET pending_r2=pending_r2\+1/,r2_receipt:/^UPDATE prelaunch_reset_operations SET pending_r2=pending_r2-1/,reservation_receipt:/^UPDATE storage_reservations SET state='committed'/,intent_receipt:/^UPDATE proof_upload_intents SET write_token=NULL/};
function faultDB(raw,pattern){
 const wrap=s=>new Proxy(s,{get(target,k){if(k==='bind')return(...a)=>wrap(target.bind(...a));if(['all','first','run'].includes(k))return(...a)=>{if(pattern.test(target.sql))throw Error('private Cookie Grant Secret object_key must not escape');return target[k](...a);};const v=target[k];return typeof v==='function'?v.bind(target):v;}});
 return{prepare:sql=>wrap(raw.prepare(sql)),batch:ss=>{if(ss.some(s=>pattern.test(s.sql)))throw Error('private Cookie Grant Secret object_key must not escape');return raw.batch(ss);}};
}
for(const [stage,pattern]of Object.entries(faults))test('fixed diagnostic stage '+stage+' locates failure without sensitive output or blind retry',async t=>{
 const f=await fixture(t);let prepared;
 f.env.DB=f.db;
 const r=await f.fetch('/api/uploads/prepare','POST',{campaign_id:'UPLOAD-LOCAL',storage_version:2,completion_mode:'direct',turnstile_token:'synthetic',files:[{name:'fixture.png',type:'image/png',size:image.length,algorithm:'sha256',sha256:hash(image)}]},{Origin:origin});assert.equal(r.status,200);prepared=(await r.json()).data;
 f.env.DB=faultDB(f.db,pattern);const u=prepared.uploads[0],response=await worker.fetch(new Request(u.upload_url,{method:'PUT',headers:{Origin:origin,...u.headers,'Content-Length':String(image.length)},body:image}),f.env);
 assert.ok(response.status>=500);assert.equal(response.headers.get('X-VoteProof-Upload-Stage'),stage);const body=await response.text();assert.equal(/private|Cookie|Secret|object_key/.test(body),false);
 assert.equal(f.nativePuts(),['r2_receipt','reservation_receipt','intent_receipt'].includes(stage)?1:0);
 if(['capacity_admission','r2_fence','r2_dispatch','r2_receipt','reservation_receipt','intent_receipt'].includes(stage))assert.equal(f.count("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'"),1);
});
for(const stage of ['r2_head','r2_head_fence'])test('completed intent read failure distinguishes '+stage+' without a native PUT or duplicate Case',async t=>{
 const f=await fixture(t),r=await f.fetch('/api/uploads/prepare','POST',{campaign_id:'UPLOAD-LOCAL',storage_version:2,completion_mode:'direct',turnstile_token:'synthetic',files:[{name:'fixture.png',type:'image/png',size:image.length,algorithm:'sha256',sha256:hash(image)}]},{Origin:origin});assert.equal(r.status,200);const p=(await r.json()).data,u=p.uploads[0];
 const put=()=>worker.fetch(new Request(u.upload_url,{method:'PUT',headers:{Origin:origin,...u.headers,'Content-Length':String(image.length)},body:image}),f.env);
 assert.equal((await put()).status,200);assert.equal((await f.fetch('/api/cases/direct','POST',{campaign_id:'UPLOAD-LOCAL',vote_date:new Date().toISOString().slice(0,10),upload_session:{session_id:p.session_id,keys:[u.key],capability:p.capability}},{Origin:origin,'Idempotency-Key':randomUUID()})).status,201);
 if(stage==='r2_head')f.bucket.head=async()=>{throw Error('private provider message');};else f.env.DB=faultDB(f.db,/^SELECT object_key FROM prelaunch_reset_retired_keys/);
 const response=await put();assert.equal(response.status,502);assert.equal(response.headers.get('X-VoteProof-Upload-Stage'),stage);assert.equal(response.headers.get('X-VoteProof-Put-State'),'not_started');assert.equal((await response.json()).error.code,'R2_UPLOAD_ERROR');assert.equal(f.nativePuts(),1);assert.equal(f.count('SELECT COUNT(*) n FROM cases'),1);
});
test('D1 unknown admission does not trigger speculative Direct Case or resend, while its Pin/UNKNOWN remain',async t=>{
 const f=await fixture(t),raw=f.env.DB;let lost=false;
 f.env.DB={...raw,batch:async ss=>{const r=await raw.batch(ss);if(!lost&&ss.some(s=>s.sql.startsWith('UPDATE proof_upload_intents SET write_token='))){lost=true;throw Error('synthetic D1 admission ACK lost');}return r;}};
 f.start(1);assert.equal((await f.batch.attempt()).unknown,1);assert.equal(f.batch.error.code,'R2_UPLOAD_ERROR');assert.equal(f.batch.error.uploadStage,'capacity_admission');assert.equal(f.batch.error.putState,'not_started');
 assert.equal(f.requests.filter(r=>r.path==='/api/cases/direct').length,0);assert.equal(f.nativePuts(),0);assert.equal(f.count('SELECT COUNT(*) n FROM proof_upload_intents WHERE write_token IS NOT NULL'),1);
 assert.equal((await f.batch.attempt()).unknown,1);assert.equal(f.httpPuts(),1);assert.equal(f.count("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'"),1);
});
test('unconfirmed D1 result pauses the remaining batch instead of multiplying unknown operations',async t=>{
 const f=await fixture(t),raw=f.env.DB;
 f.env.DB={...raw,batch:async ss=>{if(ss.some(s=>s.sql.startsWith('UPDATE proof_upload_intents SET write_token=')))throw Error('synthetic unknown admission');return raw.batch(ss);}};
 f.start(3);const r=await f.batch.attempt();assert.equal(r.unknown,1);assert.equal(r.queued,2);assert.equal(f.httpPuts(),1);assert.equal(f.requests.filter(x=>x.path.endsWith('/prepare')).length,1);assert.equal(f.nativePuts(),0);
 const retry=await f.batch.attempt();assert.equal(retry.queued,2);assert.equal(f.httpPuts(),1);assert.equal(f.count("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'"),1);
});
