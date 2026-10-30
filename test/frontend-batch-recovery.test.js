import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BatchSubmission,Submission} from '../public/js/submission.js';
import {PublicError} from '../public/js/api.js';
globalThis.location={origin:'https://voteproof.example'};
const metadata={campaign_id:'LOCAL-TEST',vote_date:'2026-10-30'};
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const busy=()=>Object.assign(new PublicError('R2_STORAGE_INVENTORY_BUSY',503),{putRejected:true,putState:'not_started',uploadStage:'capacity_admission'});
function fixture(n,{concurrency=2,gate=async()=>{},put,complete,create,now=Date.now,sleep}={}){
 const calls=[],puts=[],states=[],receipts=new Map();let tokens=0;
 const api=async(path,options={})=>{
  calls.push({path,...options});
  if(path.endsWith('/authorize'))return {tickets:options.body.files.map((_,i)=>String.fromCharCode(65+i).repeat(60)),expires_in:300};
  if(path.endsWith('/prepare')){
   const id=randomUUID();return {session_id:id,expires_in:300,uploads:[{key:id,method:'PUT',headers:{'Content-Type':'image/png','X-Upload-Grant':'G'.repeat(60)},upload_url:`https://voteproof.example/api/uploads/put/${id}/${randomUUID()}`}]};
  }
  if(path.endsWith('/complete')){await complete?.(options);return {};}
  if(path==='/api/cases'){
   const key=options.headers['Idempotency-Key'];
   if(!receipts.has(key))receipts.set(key,{case_id:'VP-20261030-'+'ABCDEFGHJKLMNPQRSTUVWXYZ'[receipts.size].repeat(16),query_key:'Q'.repeat(43)});
   await create?.(options);return receipts.get(key);
  }
  assert.fail(path);
 };
 const batch=new BatchSubmission({api,concurrency,now,sleep,gate,token:async()=>{tokens++;return 'synthetic';},
  put:async(u,f,p)=>{puts.push({u,f});await put?.(u,f,p);p(1);},
  changed:s=>{states.push(s);assert.equal(s.succeeded+s.failed+s.unknown+s.processing+s.queued,s.total);}});
 batch.start(metadata,Array.from({length:n},(_,i)=>({name:`image-${i}.png`,type:'image/png',size:3,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer})));
 return {batch,api,calls,puts,states,receipts,tokens:()=>tokens};
}
for(const n of [1,3,5,6,20])test(`${n} images: at most two active native uploads, one challenge, independent receipts`,async()=>{
 let active=0,max=0;const h=fixture(n,{put:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;}});
 assert.equal((await h.batch.attempt()).complete,true);assert.equal(max,Math.min(n,2));assert.equal(h.puts.length,n);assert.equal(h.tokens(),1);assert.equal(h.receipts.size,n);
 assert.equal(h.calls.filter(c=>c.path.endsWith('/authorize')).length,n>1?1:0);assert.equal(new Set(h.calls.filter(c=>c.path==='/api/cases').map(c=>c.headers['Idempotency-Key'])).size,n);
});
test('two blocked lanes share a timer and gate check; inventory restores exact original grants',async()=>{
 let clock=0,sleeps=0;const counts=new Map(),h=fixture(3,{now:()=>clock,sleep:async ms=>{sleeps++;clock+=ms;},put:async u=>{const n=counts.get(u.key)||0;counts.set(u.key,n+1);if(!n&&counts.size<=2)throw busy();}});
 assert.equal((await h.batch.attempt()).complete,true);assert.equal(sleeps,1);assert.equal(h.tokens(),1);assert.equal(h.calls.filter(c=>c.path.endsWith('/prepare')).length,3);
 for(const [key,n] of counts)assert.equal(h.puts.filter(p=>p.u.key===key).length,n);
});
test('one rejected lane cannot cancel or forget the other already-started PUT',async()=>{
 const started=latch(),release=latch();let settled=false;
 const h=fixture(3,{put:async(_u,f)=>{if(f.name==='image-0.png'){await started.promise;throw Object.assign(new PublicError('R2_STORAGE_CAPACITY_EXCEEDED',503),{putRejected:true,putState:'not_started'});}started.resolve();await release.promise;}});
 const p=h.batch.attempt().then(x=>{settled=true;return x;});await started.promise;await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(h.batch.busy,true);
 release.resolve();const s=await p;assert.equal(s.succeeded,1);assert.equal(s.failed,1);assert.equal(s.queued,1);assert.equal(h.puts.length,2);
});
for(const code of ['UPLOAD_INCOMPLETE','NETWORK_ERROR','UPLOAD_SESSION_EXPIRED'])test(`${code} after acknowledged PUT never causes re-PUT`,async()=>{
 let fail=true;const h=fixture(1,{complete:async()=>{if(fail){fail=false;throw new PublicError(code,code==='NETWORK_ERROR'?0:400);}}});
 assert.equal((await h.batch.attempt()).complete,false);assert.equal((await h.batch.attempt()).complete,true);assert.equal(h.puts.length,1);assert.equal(h.receipts.size,1);
 const requests=h.calls.filter(c=>c.path.endsWith('/complete'));assert.deepEqual(requests[0].body,requests[1].body);
});
test('unknown PUT remains distinct and retry can only confirm original bytes, not send another PUT',async()=>{
 let missing=true;const h=fixture(3,{put:async(_u,f)=>{if(f.name==='image-0.png')throw new PublicError('PUT_ACK_UNKNOWN');},complete:async o=>{if(o.body.session_id===h.puts[0]?.u.key&&missing)throw new PublicError('UPLOAD_INCOMPLETE',400);}});
 const first=await h.batch.attempt();assert.equal(first.unknown,1);assert.equal(first.succeeded,2);const receipt=first.items[1].result;
 await h.batch.attempt();assert.equal(h.puts.length,3);missing=false;const last=await h.batch.attempt();assert.equal(last.complete,true);assert.deepEqual(last.items[1].result,receipt);assert.equal(h.receipts.size,3);
});
test('lost Case ACK replays one immutable payload/key, other successful cases never repeated',async()=>{
 let lose=true;const h=fixture(20,{create:async()=>{if(lose){lose=false;throw new PublicError('NETWORK_ERROR');}}});
 const a=await h.batch.attempt();assert.equal(a.succeeded,19);assert.equal(a.unknown,1);assert.equal(h.receipts.size,20);
 assert.equal((await h.batch.attempt()).complete,true);assert.equal(h.puts.length,20);const cases=h.calls.filter(c=>c.path==='/api/cases');assert.equal(cases.length,21);assert.equal(cases[0].body,cases[20].body);assert.equal(cases[0].headers['Idempotency-Key'],cases[20].headers['Idempotency-Key']);
});
test('expired batch ticket renews only never-written items on one explicit retry',async()=>{
 let clock=0,reject=true;const h=fixture(3,{now:()=>clock,put:async(_u,f)=>{if(reject&&f.name==='image-0.png')throw new PublicError('UPLOAD_VALIDATION_FAILED',400);}});
 const a=await h.batch.attempt();assert.equal(a.succeeded,2);clock=301000;reject=false;
 const b=await h.batch.attempt();assert.equal(b.complete,true);assert.equal(h.tokens(),2);assert.deepEqual(h.calls.filter(c=>c.path.endsWith('/authorize')).map(c=>c.body.files.length),[3,1]);assert.equal(h.puts.length,4);
});
test('invalid grant before PUT renews the same fixed intent under its still-valid batch ticket',async()=>{
 let reject=true;const h=fixture(3,{put:async(_u,f)=>{if(reject&&f.name==='image-0.png')throw new PublicError('UPLOAD_GRANT_INVALID',403);}});
 assert.equal((await h.batch.attempt()).succeeded,2);reject=false;assert.equal((await h.batch.attempt()).complete,true);
 assert.deepEqual(h.calls.filter(c=>c.path.endsWith('/authorize')).map(c=>c.body.files.length),[3]);assert.equal(h.receipts.size,3);
});
test('same batch concurrent attempts cannot duplicate authorize, PUT or Case',async()=>{
 const h=fixture(20);const a=h.batch.attempt(),b=h.batch.attempt();assert.equal(a,b);await a;await h.batch.attempt();assert.equal(h.puts.length,20);assert.equal(h.tokens(),1);assert.equal(h.receipts.size,20);
});
test('unknown rejection with no safe diagnostic permanently holds the item rather than offering upload',async()=>{
 const h=fixture(1,{put:async()=>{throw new PublicError('UNRECOGNIZED',502);}});const a=await h.batch.attempt();assert.equal(a.unknown,1);assert.equal(a.retryable,0);assert.equal(a.items[0].recovery,'hold');await h.batch.attempt();assert.equal(h.puts.length,1);
});
test('legacy multi-image confirmed writes cannot be reset after later Grant rejection',async()=>{
 const h=fixture(1),flow=new Submission({api:async(path,o)=>{
  if(path.endsWith('/prepare')){const p=await h.api(path,o);p.uploads.push({...p.uploads[0]});return p;}return h.api(path,o);
 },token:async()=> 'synthetic',put:async()=>{if(++count===2)throw new PublicError('UPLOAD_GRANT_INVALID',403);}});
 let count=0;const f={name:'a.png',type:'image/png',size:3,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer};flow.start(metadata,[f,f]);
 await assert.rejects(flow.attempt(),{code:'UPLOAD_GRANT_INVALID'});assert.equal(flow.recovery,'hold');await assert.rejects(flow.attempt(),{code:'PUT_RESULT_UNCONFIRMED'});assert.equal(count,2);
});
