import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {BatchSubmission,uploadDiagnosticText} from '../public/js/submission.js';
import {PublicError,putImage,safeUploadDiagnostic} from '../public/js/api.js';
globalThis.location={origin:'https://voteproof.example'};
const base='5f7cb3225685e782b41bfb2c2664be92d6800bea';
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
function harness(n,{Class=BatchSubmission,fault=null,direct=true,caseFault=false,slowReconcile=false,manualReconcile=false,
 otherPutWait,concurrency=2,owner='member'}={}){
 const calls=[],puts=[],sessions=new Map(),receipts=new Map(),states=[],both=latch(),reconcile=latch(),caseEntered=latch();
 let missing=!!fault,caseMissing=caseFault,clock=0,tokens=0,loseCase=false;
 const api=async(path,options={})=>{
  calls.push({path,...options});
  if(path==='/api/uploads/batch/authorize')return{tickets:options.body.files.map((_,i)=>String.fromCharCode(65+i%20).repeat(60)),expires_in:300};
  if(path==='/api/uploads/prepare'){
   const session_id=randomUUID(),index=sessions.size;sessions.set(session_id,index);
   return{session_id,expires_in:300,...(direct?{completion_mode:'direct'}:{}),
    ...(owner==='guest'?{capability:'PRIVATE-GUEST-CAPABILITY'}:{}),uploads:[{key:'PRIVATE-OBJECT-'+session_id,method:'PUT',
     headers:{'Content-Type':'image/png','X-Upload-Grant':'G'.repeat(60)},
     upload_url:'https://voteproof.example/api/uploads/put/'+session_id+'/'+randomUUID()}]};
  }
  const body=typeof options.body==='string'?JSON.parse(options.body):options.body;
  const index=sessions.get((body.upload_session??body).session_id);
  if((path==='/api/cases/direct'||path==='/api/uploads/complete')&&index===0){
   if(slowReconcile){caseEntered.resolve();await reconcile.promise;}
   if(missing||caseMissing)throw new PublicError('UPLOAD_INCOMPLETE',400);
  }
  if(path==='/api/uploads/complete')return{};
  if(path==='/api/cases'||path==='/api/cases/direct'){
   const key=options.headers['Idempotency-Key'];
   if(!receipts.has(key))receipts.set(key,{case_id:'VP-20261103-'+'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[index].repeat(16),query_key:'Q'.repeat(43)});
   if(caseFault==='lost-ack'&&index===0&&!loseCase){loseCase=true;throw new PublicError('NETWORK_ERROR');}
   return receipts.get(key);
  }
  assert.fail('Unexpected synthetic endpoint');
 };
 const b=new Class({api,concurrency,directIntent:direct,now:()=>clock,
  gate:async()=>{calls.push({path:'/api/submissions/status'});},
  token:async()=>{tokens++;return'PRIVATE-TURNSTILE-TOKEN';},
  changed:s=>{states.push(s);assert.equal(s.succeeded+s.failed+s.unknown+s.queued+s.processing,n);
   if(slowReconcile&&!manualReconcile&&s.succeeded===1)reconcile.resolve();},
  put:async(u,file,progress)=>{
   const index=sessions.get(u.key.replace('PRIVATE-OBJECT-',''));
   puts.push({u,index,name:file.name});if(puts.length===2)both.resolve();
   if(fault&&index===0){
    if(n>1&&concurrency===2)await both.promise;
    clock+=150;
    const error=fault==='500'?Object.assign(new PublicError('R2_UPLOAD_ERROR',500),{uploadStage:'r2_put',putState:'unknown'}):
     fault==='reject'?Object.assign(new PublicError('UPLOAD_VALIDATION_FAILED',400),{putRejected:true,uploadStage:'request_validation',putState:'not_started'}):
     Object.assign(new PublicError('PUT_ACK_UNKNOWN'),{transportEvent:fault==='timeout'?'timeout':'network',elapsedMs:120000});
    error.message='PRIVATE-TOKEN-COOKIE-GRANT';error.object_key=u.key;throw error;
   }
   if(otherPutWait&&index===1)await otherPutWait;
   progress(1);return{code:'HTTP_ACKNOWLEDGED',status:200,elapsedMs:12,transportEvent:'load'};
  }});
 b.start({campaign_id:'LOCAL-TEST',vote_date:'2026-11-03',note:'PRIVATE-MEMBER-NOTE'},
  Array.from({length:n},(_,i)=>({name:'PRIVATE-FILENAME-'+i+'.png',type:'image/png',size:3,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer})));
 return{batch:b,calls,puts,sessions,receipts,states,both,caseEntered,reconcile,
  recover(){missing=false;caseMissing=false;},advance(){clock+=301000;},tokens:()=>tokens};
}
for(const n of[16,20])for(const fault of['500','timeout','ack-loss'])
test(n+' Direct images, '+fault+': immediate pause, drain two lanes, retain never-started images',async()=>{
 const h=harness(n,{fault,slowReconcile:true}),first=await h.batch.attempt();
 assert.equal(h.puts.length,2);assert.equal(first.succeeded,1);assert.equal(first.unknown,1);
 assert.equal(first.failed,0);assert.equal(first.queued,n-2);assert.equal(first.processed,2);assert.equal(first.paused,true);
 assert.equal(first.items.slice(2).every(i=>i.status==='queued'&&i.error===null),true);
 const original=h.calls.find(c=>c.path==='/api/cases/direct'&&JSON.parse(c.body).upload_session.session_id===[...h.sessions.keys()][0]);
 const receipt=first.items.find(i=>i.result).result;
 const previousPuts=h.puts.length,previousPrepares=h.sessions.size;
 h.advance();await h.batch.attempt();
 assert.equal(h.puts.length,previousPuts);assert.equal(h.sessions.size,previousPrepares);
 const replays=h.calls.filter(c=>c.path==='/api/cases/direct'&&c.headers['Idempotency-Key']===original.headers['Idempotency-Key']);
 assert.equal(replays.length,2);assert.equal(replays[0].body,replays[1].body);
 assert.equal(h.tokens(),1); // queued items cannot request authorization while this PUT is unresolved
 const diagnostics=h.batch.diagnostics,firstError=diagnostics.items[0].original_put;
 const expectedCode=firstError.code;
 assert.equal(firstError.code,fault==='500'?'R2_UPLOAD_ERROR':'PUT_ACK_UNKNOWN');
 assert.equal(diagnostics.items[0].latest.code,'UPLOAD_INCOMPLETE');
 assert.equal(diagnostics.first_error.code,firstError.code);
 assert.equal(diagnostics.items[0].original_put.duration_ms,fault==='500'?150:120000);
 const text=JSON.stringify(diagnostics);
 for(const secret of['PRIVATE-','G'.repeat(60),'Q'.repeat(43)])assert.equal(text.includes(secret),false);
 diagnostics.items[0].original_put.code='MUTATED';
 assert.equal(h.batch.diagnostics.items[0].original_put.code,expectedCode);
 h.recover();const complete=await h.batch.attempt();
 assert.equal(complete.complete,true);assert.equal(complete.succeeded,n);assert.equal(h.puts.length,n);
 assert.equal(h.receipts.size,n);assert.equal(h.puts.filter(p=>p.index===0).length,1);
 assert.deepEqual(complete.items.find(i=>i.result.case_id===receipt.case_id).result,receipt);
 const posts=h.calls.filter(c=>c.path==='/api/cases/direct');
 assert.equal(new Set(posts.map(p=>p.headers['Idempotency-Key'])).size,n);
 assert.equal(posts.filter(p=>p.headers['Idempotency-Key']===original.headers['Idempotency-Key']).every(p=>p.body===original.body),true);
});
test('UNKNOWN pauses immediately even while Case reconciliation remains pending',async()=>{
 const h=harness(20,{fault:'500',slowReconcile:true,manualReconcile:true});
 const attempt=h.batch.attempt();
 await h.caseEntered.promise;await tick();await tick();
 assert.equal(h.batch.busy,true);assert.equal(h.batch.summary.succeeded,1);
 assert.equal(h.sessions.size,2);assert.equal(h.puts.length,2);assert.equal(h.batch.summary.queued,18);
 h.reconcile.resolve();await attempt;
});
test('already-started native PUT is drained and cannot be abandoned or duplicated',async()=>{
 const release=latch(),h=harness(16,{fault:'500',otherPutWait:release.promise});
 let settled=false;const attempt=h.batch.attempt();attempt.then(()=>{settled=true;});
 await h.both.promise;await tick();
 assert.equal(settled,false);assert.equal(h.batch.busy,true);assert.equal(h.batch.attempt(),attempt);
 assert.throws(()=>h.batch.abandon(),{code:'SUBMISSION_BUSY'});
 assert.equal(h.puts.length,2);release.resolve();
 const result=await attempt;assert.equal(result.succeeded,1);assert.equal(result.unknown,1);assert.equal(result.queued,14);
});
test('a successful authoritative Case reconciliation still pauses fresh dispatch until explicit resume',async()=>{
 const h=harness(20,{fault:'500'});h.recover();
 const first=await h.batch.attempt();
 assert.equal(first.succeeded,2);assert.equal(first.unknown,0);assert.equal(first.queued,18);assert.equal(first.paused,true);
 assert.equal(h.puts.length,2);assert.equal(h.receipts.size,2);
 assert.equal((await h.batch.attempt()).complete,true);
 assert.equal(h.puts.length,20);assert.equal(h.puts.filter(p=>p.index===0).length,1);assert.equal(h.receipts.size,20);
});
test('HEAD404/UPLOAD_INCOMPLETE after acknowledged PUT pauses without claiming the PUT failed',async()=>{
 const h=harness(20,{caseFault:true,slowReconcile:true}),s=await h.batch.attempt();
 assert.equal(s.succeeded,1);assert.equal(s.unknown,1);assert.equal(s.queued,18);assert.equal(h.puts.length,2);
 assert.equal(s.items[0].diagnostics.original_put,null);
 assert.equal(s.items[0].diagnostics.put_response.http_status,200);
 assert.equal(s.items[0].diagnostics.first.code,'UPLOAD_INCOMPLETE');
 await h.batch.attempt();assert.equal(h.puts.length,2);assert.equal(h.sessions.size,2);
});
test('legacy UNKNOWN pauses before Complete; retry verifies original reference before starting fresh images',async()=>{
 const h=harness(16,{direct:false,fault:'500'}),s=await h.batch.attempt();
 assert.equal(s.unknown,1);assert.equal(s.queued,14);assert.equal(h.puts.length,2);
 const target=h.puts.find(p=>p.index===0).u.key.replace('PRIVATE-OBJECT-','');
 await h.batch.attempt();assert.equal(h.puts.length,2);
 const complete=h.calls.filter(c=>c.path==='/api/uploads/complete'&&c.body.session_id===target);
 assert.equal(complete.length,1);
 h.recover();assert.equal((await h.batch.attempt()).complete,true);assert.equal(h.puts.length,16);
 assert.deepEqual(h.calls.filter(c=>c.path==='/api/uploads/complete'&&c.body.session_id===target).map(c=>c.body),[complete[0].body,complete[0].body]);
});
test('known zero-write validation rejection stays a confirmed failure, not UNKNOWN',async()=>{
 const h=harness(20,{fault:'reject'}),s=await h.batch.attempt();
 assert.equal(s.processed,20);assert.equal(s.succeeded,19);assert.equal(s.failed,1);assert.equal(s.unknown,0);assert.equal(s.complete,false);
 assert.equal(s.items[0].diagnostics.original_put.http_status,400);
 assert.equal(s.items[0].diagnostics.original_put.put_state,'not_started');
});
test('20/20 processed with a lost Case ACK is not 20 successful; exact Case/key is replayed once',async()=>{
 const h=harness(20,{caseFault:'lost-ack'}); // missing-object mode is disabled below
 h.recover();
 const a=await h.batch.attempt();assert.equal(a.processed,20);assert.equal(a.succeeded,19);assert.equal(a.unknown,1);assert.equal(a.complete,false);
 const original=h.calls.find(c=>c.path==='/api/cases/direct');
 const done=await h.batch.attempt();assert.equal(done.complete,true);assert.equal(h.puts.length,20);assert.equal(h.receipts.size,20);
 const replay=h.calls.filter(c=>c.path==='/api/cases/direct'&&c.headers['Idempotency-Key']===original.headers['Idempotency-Key']);
 assert.equal(replay.length,2);assert.equal(replay[0].body,replay[1].body);
});
for(const owner of['member','guest'])test(owner+' successful batch still uses one authorization and independent keys',async()=>{
 const h=harness(3,{owner});assert.equal((await h.batch.attempt()).complete,true);
 assert.equal(h.tokens(),1);assert.equal(h.puts.length,3);assert.equal(h.receipts.size,3);
 const prepared=h.calls.filter(c=>c.path==='/api/uploads/prepare');
 assert.equal(prepared.every(c=>c.body.batch_ticket&&!Object.hasOwn(c.body,'turnstile_token')),true);
 assert.equal(new Set(h.calls.filter(c=>c.path==='/api/cases/direct').map(c=>c.headers['Idempotency-Key'])).size,3);
});
test('XHR records explicit rejection, Timeout and lost ACK as safe enums and elapsed time',async t=>{
 const previous=globalThis.XMLHttpRequest;t.after(()=>{globalThis.XMLHttpRequest=previous;});
 const upload={upload_url:'https://voteproof.example/api/uploads/put/private/private',headers:{'Content-Type':'image/png','X-Upload-Grant':'PRIVATE-GRANT'}};
 for(const kind of['load','timeout','error','abort','success']){
  globalThis.XMLHttpRequest=class{
   constructor(){this.status=kind==='load'?500:200;this.upload={};this.responseText=JSON.stringify({ok:false,error:{code:'R2_UPLOAD_ERROR'}});}
   open(){}setRequestHeader(){}getResponseHeader(name){return name==='X-VoteProof-Upload-Stage'?'r2_put':name==='X-VoteProof-Put-State'?'unknown':null;}
   send(){queueMicrotask(()=>kind==='load'||kind==='success'?this.onload():this['on'+kind]());}
  };
  if(kind==='success'){const r=await putImage(upload,{},()=>{});assert.equal(r.status,200);continue;}
  await assert.rejects(putImage(upload,{},()=>{}),error=>{
   const d=safeUploadDiagnostic(error,'put',null);
   assert.equal(d.code,kind==='load'?'R2_UPLOAD_ERROR':'PUT_ACK_UNKNOWN');
   assert.equal(d.transport_event,kind==='error'?'network':kind);
   assert.equal(typeof d.duration_ms,'number');assert.equal(JSON.stringify(d).includes('PRIVATE-'),false);
   return true;
  });
 }
});
test('diagnostic whitelist drops malicious codes, stage, state and exception data',()=>{
 const d=safeUploadDiagnostic({code:'PRIVATE-CODE',status:700,uploadStage:'PRIVATE-STAGE',putState:'PRIVATE-STATE',
  transportEvent:'PRIVATE-EVENT',elapsedMs:Infinity,message:'PRIVATE-MESSAGE',token:'PRIVATE-TOKEN'},'PRIVATE-PHASE',NaN);
 assert.equal(JSON.stringify(d).includes('PRIVATE-'),false);
 assert.equal(d.code,'UNEXPECTED_ERROR');assert.equal(d.duration_ms,null);assert.equal(d.http_status,null);
 const formatted=uploadDiagnosticText({original_put:d,latest:{...d,phase:'case',code:'UPLOAD_INCOMPLETE',http_status:400}});
 assert.match(formatted,/最初PUT錯誤/);assert.match(formatted,/最近核對/);
});
test('recorded before/after request counts: normal unchanged; one UNKNOWN bounds 16/20-image dispatch',async()=>{
 // Recorded by executing base SHA versus this patch in the original local
 // assessment (evidence/REQUEST-COSTS.json). Keep CI network-free and compatible
 // with actions/checkout's depth=1; no git history, download or skipped assertion.
 const recorded=n=>({worker_http_model:{16:59,20:73}[n],prepare:n,case:n,gate:{16:10,20:12}[n],
  authorize:1,simulated_r2_put:n,simulated_case_head:n});
 const recordedUnknown=n=>({...recorded(n),worker_http_model:{16:66,20:82}[n],gate:n+1});
 const count=h=>({worker_http_model:h.calls.length+h.puts.length,prepare:h.calls.filter(c=>c.path.endsWith('/prepare')).length,
  case:h.calls.filter(c=>c.path==='/api/cases/direct').length,gate:h.calls.filter(c=>c.path.endsWith('/status')).length,
  authorize:h.calls.filter(c=>c.path.endsWith('/authorize')).length,
  simulated_r2_put:h.puts.length,simulated_case_head:h.calls.filter(c=>c.path==='/api/cases/direct').length});
 const costs={scope:'Deterministic frontend Mock counts; NOT Cloud billing or D1 row measurements',base_sha:base,
  before_source:'Recorded base-SHA local measurements; not re-executed in shallow CI',normal:{},unknown:{},
  d1_rows_read:'UNKNOWN_NOT_REMEASURED_BACKEND_UNCHANGED',d1_rows_written:'NO_NEW_PER_REQUEST_SQL_BACKEND_UNCHANGED',
  cloud_worker_cpu:'UNKNOWN',production_requests:0};
 for(const n of[16,20]){
  const normalAfter=harness(n);
  assert.equal((await normalAfter.batch.attempt()).complete,true);
  costs.normal[n]={before:recorded(n),after:count(normalAfter)};assert.deepEqual(costs.normal[n].before,costs.normal[n].after);
  const after=harness(n,{fault:'500',slowReconcile:true});
  await after.batch.attempt();
  costs.unknown[n]={before:recordedUnknown(n),after:count(after)};
  assert.deepEqual(costs.unknown[n].after,{worker_http_model:10,prepare:2,case:2,gate:3,authorize:1,simulated_r2_put:2,simulated_case_head:2});
  assert.equal(after.puts.length,2);assert.equal(after.batch.summary.queued,n-2);
 }
 fs.mkdirSync('.wrangler',{recursive:true});fs.writeFileSync('.wrangler/upload-1309-cost.json',JSON.stringify(costs,null,2));
});
