import test from 'node:test';
import assert from 'node:assert/strict';
import {Submission,canWaitForInventory} from '../public/js/submission.js';
import {PublicError} from '../public/js/api.js';

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
   {code:'R2_STORAGE_CAPACITY_EXCEEDED'},{code:'PUT_ACK_UNKNOWN'},
   {status:0}
 ]) assert.equal(canWaitForInventory(Object.assign(safeError(),delta)),false,JSON.stringify(delta));
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
