import {test} from 'node:test';
import assert from 'node:assert/strict';
import {issueBatchTickets,readBatchTicket} from '../src/lib/batch-turnstile.js';

const make=async()=>{
 const raw=crypto.getRandomValues(new Uint8Array(32));
 return {key:await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])};
};
const image=sha=>({type:'image/png',size:123,sha256:sha});
const source={campaignId:'CAMPAIGN',completionMode:'direct',memberId:'M-TEST',
 files:[image('a'.repeat(64)),image('b'.repeat(64))]};
const invalid=async fn=>assert.rejects(fn,e=>e.code==='BATCH_AUTH_INVALID');

test('batch Turnstile tickets bind each distinct immutable proof',async()=>{
 const config=await make();
 const data=await issueBatchTickets(config,source);
 assert.equal(data.tickets.length,2);
 assert.notEqual(data.tickets[0],data.tickets[1]);
 const one=await readBatchTicket(config,data.tickets[0],
  {files:[source.files[0]],campaignId:'CAMPAIGN',completionMode:'direct'});
 const two=await readBatchTicket(config,data.tickets[1],
  {files:[source.files[1]],campaignId:'CAMPAIGN',completionMode:'direct'});
 assert.equal(one.count,2);assert.equal(one.index,0);assert.equal(two.index,1);
 assert.equal(one.batch_id,two.batch_id);
 assert.notEqual(one.session_id,two.session_id);
 assert.notEqual(one.proof_id,two.proof_id);
 assert.equal(one.member_id,'M-TEST');
 await invalid(()=>readBatchTicket(config,data.tickets[0],
  {files:[source.files[1]],campaignId:'CAMPAIGN',completionMode:'direct'}));
 await invalid(()=>readBatchTicket(config,data.tickets[0],
  {files:[source.files[0]],campaignId:'OTHER',completionMode:'direct'}));
 await invalid(()=>readBatchTicket(config,data.tickets[0],
  {files:[source.files[0]],campaignId:'CAMPAIGN',completionMode:'legacy'}));
 const bad=data.tickets[0].slice(0,-1)+(data.tickets[0].endsWith('A')?'B':'A');
 await invalid(()=>readBatchTicket(config,bad,{files:[source.files[0]],campaignId:'CAMPAIGN',completionMode:'direct'}));
});
test('batch tickets reject excessive or missing files',async()=>{
 const config=await make();
 await invalid(()=>issueBatchTickets(config,{...source,files:[]}));
 await invalid(()=>issueBatchTickets(config,{...source,files:Array(21).fill(source.files[0])}));
});

test('batch tickets expire and cannot cross a reset generation',async()=>{
 const config=await make(),data=await issueBatchTickets(config,{...source,generation:1});
 const input={files:[source.files[0]],campaignId:'CAMPAIGN',completionMode:'direct',generation:1};
 await readBatchTicket(config,data.tickets[0],input);
 await invalid(()=>readBatchTicket(config,data.tickets[0],{...input,generation:2}));
 await invalid(()=>readBatchTicket({...config,origin:'https://different.example'},data.tickets[0],input));
 const other=await make();await invalid(()=>readBatchTicket(other,data.tickets[0],input));
 const clock=Date.now;try{Date.now=()=>clock()+301000;await invalid(()=>readBatchTicket(config,data.tickets[0],input));}finally{Date.now=clock;}
});
