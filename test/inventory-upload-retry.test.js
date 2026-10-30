import test from 'node:test';
import assert from 'node:assert/strict';
import {Submission,BatchSubmission,canWaitForInventory} from '../public/js/submission.js';
import {PublicError,putImage,errorMessage} from '../public/js/api.js';
import {MemberSession} from '../public/js/member-api.js';

const uuid='11111111-1111-4111-8111-111111111111';
const fileId='22222222-2222-4222-8222-222222222222';
const bytes=new Uint8Array([1,2,3]);
const file={name:'proof.png',type:'image/png',size:3,arrayBuffer:async()=>bytes.slice().buffer};
const safeError=()=>Object.assign(new PublicError('R2_STORAGE_INVENTORY_BUSY',503),
 {putRejected:true,putState:'not_started',uploadStage:'capacity_admission'});
const date='2026-10-30';
const response={session_id:uuid,expires_in:300,
 uploads:[{key:`proofs/final/${uuid}/${fileId}.png`,method:'PUT',
 upload_url:`https://voteproof.example/api/uploads/put/${uuid}/${fileId}`,
 headers:{'Content-Type':'image/png','X-Upload-Grant':'A'.repeat(60)}}]};
const caseResult={case_id:'VP-20261030-'+'A'.repeat(16),query_key:'a'.repeat(43)};
const metadata={campaign_id:'CAMPAIGN',vote_date:date,note:''};
function fixture({error=safeError(),failCount=1,expires=300}={}){
 let clock=10000,puts=0,tokens=0,cases=0,sleeps=0,prepares=0;
 const api=async(path)=>{
   if(path==='/api/uploads/prepare'){prepares++;return {...response,expires_in:expires};}
   if(path==='/api/uploads/complete')return {};
   if(path==='/api/cases'){cases++;return caseResult;}
   throw Error('Unexpected '+path);
 };
 const flow=new Submission({api,put:async()=>{puts++;if(puts<=failCount)throw error;},
   token:async()=>{tokens++;return 'synthetic';},now:()=>clock,
   sleep:async ms=>{sleeps++;clock+=ms;}});
 flow.start(metadata,[file]);
 return{flow,counts:()=>({puts,tokens,cases,sleeps,prepares})};
}
test('only confirmed zero-write inventory admission can wait/retry',()=>{
 assert.equal(canWaitForInventory(safeError()),true);
 for(const delta of [
   {putRejected:false},{putState:'unknown'},{putState:'acknowledged'},
   {putState:undefined},{uploadStage:'r2_put'},
   {code:'R2_STORAGE_CAPACITY_EXCEEDED'},{code:'R2_STORAGE_SNAPSHOT_STALE'},{code:'PUT_ACK_UNKNOWN'},
   {status:0}
 ]) assert.equal(canWaitForInventory(Object.assign(safeError(),delta)),false,JSON.stringify(delta));
});

test('XHR preserves only the explicit Busy no-write diagnostic; stale and unknown remain nonretryable',async()=>{
 const previous=globalThis.XMLHttpRequest;
 try{
  for(const code of ['R2_STORAGE_INVENTORY_BUSY','R2_STORAGE_SNAPSHOT_STALE','R2_UPLOAD_ERROR']){
   globalThis.XMLHttpRequest=class{
    upload={};status=503;responseText=JSON.stringify({error:{code}});
    open(method){assert.equal(method,'PUT');}setRequestHeader(){}
    getResponseHeader(name){return{'X-VoteProof-Upload-Rejected':'1','X-VoteProof-Put-State':code==='R2_UPLOAD_ERROR'?'unknown':'not_started','X-VoteProof-Upload-Stage':'capacity_admission'}[name]??null;}
    send(){queueMicrotask(()=>this.onload());}
   };
   await assert.rejects(putImage(response.uploads[0],file,()=>{}),error=>error.code===code&&canWaitForInventory(error)===(code==='R2_STORAGE_INVENTORY_BUSY'));
  }
  assert.match(errorMessage({code:'R2_STORAGE_INVENTORY_BUSY'}),/盤點/);
  assert.doesNotMatch(errorMessage({code:'R2_STORAGE_CAPACITY_EXCEEDED'}),/正在.*盤點/);
 }finally{globalThis.XMLHttpRequest=previous;}
});

test('batch forwards its deterministic sleep; busy limit pauses later items without a real timer',async()=>{
 const old=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
  let puts=0,sleeps=0,clock=10000,tokens=0,authorizations=0,prepares=0;
  const flow=new BatchSubmission({now:()=>clock,sleep:async ms=>{assert.equal(ms,5000);sleeps++;clock+=ms;},
   api:async path=>{
    if(path.endsWith('/status'))return{submissions_enabled:true};
    if(path.endsWith('/authorize')){authorizations++;return{tickets:['A','B','C'].map(x=>x.repeat(60)),expires_in:300};}
    if(path.endsWith('/prepare')){prepares++;return response;}
    assert.fail('No Complete or Case may follow rejected PUT');
   },put:async()=>{puts++;throw safeError();},token:async()=>{tokens++;return'synthetic';}});
  flow.start(metadata,[file,file,file]);const result=await flow.attempt();
  assert.deepEqual([result.succeeded,result.failed,result.queued],[0,1,2]);
  assert.deepEqual({puts,sleeps,tokens,authorizations,prepares},{puts:13,sleeps:12,tokens:1,authorizations:1,prepares:1});
 }finally{globalThis.location=old;}
});

for(const code of ['SUBMISSIONS_DISABLED','AUTH_IDENTITY_CHANGED','NETWORK_ERROR'])test(code+': failed retry gate stops before another PUT, without inventing UNKNOWN',async()=>{
 const old=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
  let clock=10000,puts=0,gateFails=true,prepares=0;
  const flow=new Submission({now:()=>clock,sleep:async ms=>{clock+=ms;},retryGate:async()=>{if(gateFails)throw new PublicError(code);},
   api:async path=>{if(path.endsWith('/prepare')){prepares++;return response;}if(path.endsWith('/complete'))return{};if(path==='/api/cases')return caseResult;assert.fail(path);},
   put:async()=>{if(++puts===1)throw safeError();},token:async()=>'synthetic'});
  flow.start(metadata,[file]);await assert.rejects(flow.attempt(),e=>e.code===code&&e.pauseBatch===true);assert.equal(puts,1);
  gateFails=false;assert.deepEqual(await flow.attempt(),caseResult);assert.equal(puts,2);assert.equal(prepares,1);
 }finally{globalThis.location=old;}
});

for(const advance of [301000,61000])test('wait timer advanced '+advance+'ms never resends an expired or over-budget Grant',async()=>{
 const old=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
  let clock=10000,puts=0;
  const flow=new Submission({now:()=>clock,sleep:async()=>{clock+=advance;},token:async()=>'synthetic',api:async path=>{assert.equal(path,'/api/uploads/prepare');return response;},put:async()=>{puts++;throw safeError();}});
  flow.start(metadata,[file]);await assert.rejects(flow.attempt(),{code:'R2_STORAGE_INVENTORY_BUSY'});assert.equal(puts,1);
 }finally{globalThis.location=old;}
});

test('Busy after one successful case preserves its receipt and retries only the original failed intent',async()=>{
 const old=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
  let clock=10000,recovered=false,prepares=0,authorizations=0,tokens=0,sleeps=0;const uploads=[],caseKeys=[],posts=[];
  const flow=new BatchSubmission({now:()=>clock,sleep:async ms=>{clock+=ms;sleeps++;},token:async()=>{tokens++;return'synthetic';},
   api:async(path,options)=>{
    if(path.endsWith('/status'))return{submissions_enabled:true};
    if(path.endsWith('/authorize')){authorizations++;return{tickets:['A','B','C'].map(x=>x.repeat(60)),expires_in:300};}
    if(path.endsWith('/prepare')){const n=++prepares;return{...response,session_id:String(n),uploads:[{...response.uploads[0],key:'original-'+n}]};}
    if(path.endsWith('/complete'))return{};
    if(path==='/api/cases'){caseKeys.push(options.headers['Idempotency-Key']);posts.push(JSON.parse(options.body));return{...caseResult,case_id:'VP-20261030-'+String.fromCharCode(65+caseKeys.length).repeat(16)};}
    assert.fail(path);
   },put:async upload=>{uploads.push(upload);if(upload.key==='original-2'&&!recovered)throw safeError();}});
  flow.start(metadata,[file,file,file]);const first=await flow.attempt();
  assert.deepEqual([first.succeeded,first.failed,first.queued],[1,1,1]);assert.equal(caseKeys.length,1);assert.equal(sleeps,12);
  const successful=first.items[0].result,original=uploads[1];recovered=true;const final=await flow.attempt();
  assert.equal(final.complete,true);assert.deepEqual(final.items[0].result,successful);assert.equal(caseKeys.length,3);assert.equal(new Set(caseKeys).size,3);
  assert.equal(uploads.filter(x=>x.key==='original-1').length,1);assert.ok(uploads.filter(x=>x.key==='original-2').every(x=>x===original));
  assert.deepEqual({prepares,authorizations,tokens},{prepares:3,authorizations:1,tokens:1});assert.deepEqual(posts.map(p=>p.upload_session.keys[0]),['original-1','original-2','original-3']);
 }finally{globalThis.location=old;}
});

test('actual MemberSession owner change during Busy wait prevents another PUT or guest fallback',async()=>{
 const old=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 const first={member:{member_id:'M-local-first',status:'active'},csrf_token:'a'.repeat(64),expires_in:300},second={member:{member_id:'M-local-second',status:'active'},csrf_token:'b'.repeat(64),expires_in:300};
 let current=first,clock=10000,puts=0;
 const session=new MemberSession({fetcher:async path=>{assert.equal(path,'/api/auth/me');return Response.json({ok:true,data:current});}});session.accept(first);const sender=session.caseSender();
 try{
  const flow=new BatchSubmission({gate:()=>sender.verify(),now:()=>clock,sleep:async ms=>{clock+=ms;current=second;},token:async()=>'synthetic',
   api:async path=>{if(path.endsWith('/authorize'))return{tickets:['A','B'].map(x=>x.repeat(60)),expires_in:300};if(path.endsWith('/prepare'))return response;assert.fail('No Case or guest fallback');},put:async()=>{puts++;throw safeError();}});
  flow.start(metadata,[file,file]);const result=await flow.attempt();assert.equal(puts,1);assert.equal(result.items[0].error,'AUTH_IDENTITY_CHANGED');assert.equal(result.succeeded,0);assert.equal(result.queued,1);
 }finally{session.clear();globalThis.location=old;}
});
test('one transient inventory admission rejection retries the same prepared proof exactly once',async()=>{
 const previous=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
   const f=fixture();assert.deepEqual(await f.flow.attempt(),caseResult);
   assert.deepEqual(f.counts(),{puts:2,tokens:1,cases:1,sleeps:1,prepares:1});
 }finally{globalThis.location=previous;}
});
test('ambiguous native R2 PUT is never automatically resent',async()=>{
 const previous=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
   const f=fixture({error:Object.assign(safeError(),{putState:'unknown'})});
   await assert.rejects(f.flow.attempt(),e=>e.code==='R2_STORAGE_INVENTORY_BUSY');
   assert.deepEqual(f.counts(),{puts:1,tokens:1,cases:0,sleeps:0,prepares:1});
 }finally{globalThis.location=previous;}
});
test('real capacity rejection is not automatically resent',async()=>{
 const previous=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
   const f=fixture({error:Object.assign(safeError(),{code:'R2_STORAGE_CAPACITY_EXCEEDED'})});
   await assert.rejects(f.flow.attempt(),e=>e.code==='R2_STORAGE_CAPACITY_EXCEEDED');
   assert.deepEqual(f.counts(),{puts:1,tokens:1,cases:0,sleeps:0,prepares:1});
 }finally{globalThis.location=previous;}
});
test('inventory retries are bounded and stop before grant expiry',async()=>{
 const previous=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
   const f=fixture({failCount:100});
   await assert.rejects(f.flow.attempt(),e=>e.code==='R2_STORAGE_INVENTORY_BUSY');
   assert.deepEqual(f.counts(),{puts:13,tokens:1,cases:0,sleeps:12,prepares:1});
   const short=fixture({failCount:100,expires:1});
   await assert.rejects(short.flow.attempt(),e=>e.code==='R2_STORAGE_INVENTORY_BUSY');
   assert.equal(short.counts().puts,1);
 }finally{globalThis.location=previous;}
});

test('stale snapshot without an active scan never automatically retries',async()=>{
 const previous=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
   const f=fixture({error:Object.assign(safeError(),{code:'R2_STORAGE_SNAPSHOT_STALE'})});
   await assert.rejects(f.flow.attempt(),{code:'R2_STORAGE_SNAPSHOT_STALE'});
   assert.deepEqual(f.counts(),{puts:1,tokens:1,cases:0,sleeps:0,prepares:1});
 }finally{globalThis.location=previous;}
});
test('a stale snapshot rejection without the no-write receipt NEVER retries',async()=>{
 const previous=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
   const f=fixture({error:Object.assign(safeError(),{code:'R2_STORAGE_SNAPSHOT_STALE',putRejected:false})});
   await assert.rejects(f.flow.attempt(),e=>e.code==='R2_STORAGE_SNAPSHOT_STALE');
   assert.deepEqual(f.counts(),{puts:1,tokens:1,cases:0,sleeps:0,prepares:1});
 }finally{globalThis.location=previous;}
});
test('batch stops on first stale capacity failure and leaves remaining items queued',async()=>{
 const previous=globalThis.location;globalThis.location={origin:'https://voteproof.example'};
 try{
   let tokenCount=0,puts=0,prepares=0,sleeps=0,cases=0;
   const files=Array.from({length:3},(_,i)=>({...file,name:'proof'+i+'.png'}));
   const flow=new BatchSubmission({
     api:async(path)=>{
       if(path==='/api/submissions/status')return{submissions_enabled:true};
       if(path==='/api/uploads/batch/authorize')return{tickets:files.map((_,i)=>String(i).repeat(60)),expires_in:300};
       if(path==='/api/uploads/prepare'){prepares++;return response;}
       if(path==='/api/uploads/complete')return{};
       if(path==='/api/cases'){cases++;return caseResult;}
       throw Error(path);
     },
     put:async()=>{puts++;throw Object.assign(safeError(),{code:'R2_STORAGE_SNAPSHOT_STALE'});},
     token:async()=>{tokenCount++;return 'synthetic';},
     now:()=>10000,
     sleep:async()=>{sleeps++;}
   });
   flow.start(metadata,files);
   const summary=await flow.attempt();
   assert.equal(summary.succeeded,0);
   assert.equal(summary.failed,1);
   assert.equal(summary.queued,2);
   assert.equal(puts,1);
   assert.equal(prepares,1);
   assert.equal(tokenCount,1);
   assert.equal(cases,0);
   assert.equal(sleeps,0);
 }finally{globalThis.location=previous;}
});
