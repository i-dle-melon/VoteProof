import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {BatchSubmission} from '../public/js/submission.js';
import {PublicError} from '../public/js/api.js';

globalThis.location={origin:'https://voteproof.example'};
const bytes=new Uint8Array([1,2,3]);
const hash=createHash('sha256').update(bytes).digest('hex');
const metadata={campaign_id:'LOCAL-TEST',vote_date:'2026-10-30'};
const file=()=>new File([bytes],'synthetic.png',{type:'image/png'});
const claim={name:'synthetic.png',type:'image/png',size:3,algorithm:'sha256',sha256:hash};
let h,local,member,other,siteverify=0,allowVerify=true;
before(async()=>{
 h=await localAdminRuntime({directIntent:true,turnstileService:()=>{siteverify++;return Response.json({success:allowVerify});}});
 local=h.local;member=await h.identity();other=await h.identity();
});
after(async()=>{await local?.runtime.dispose();});
const json=async response=>{const b=await response.json();if(!response.ok)throw new PublicError(b.error.code,response.status);return b.data;};
function api(actor){return async(path,options={})=>json(await local.fetch(path,options.method??'GET',options.body,{Origin:location.origin,...actor?.headers,...options.headers}));}
const authorize=(files=[claim,claim],actor=member,extra={})=>local.fetch('/api/uploads/batch/authorize','POST',{
 turnstile_token:randomUUID(),campaign_id:'LOCAL-TEST',files,...extra},{Origin:location.origin,...actor?.headers});
const prepare=(ticket,actor=member,extra={})=>local.fetch('/api/uploads/prepare','POST',{
 storage_version:2,campaign_id:'LOCAL-TEST',batch_ticket:ticket,files:[claim],...extra},{Origin:location.origin,...actor?.headers});

for(const [count,isMember,direct] of [[1,true,false],[3,true,false],[5,false,true],[6,false,false],[20,true,true]]){
 test(`${count} proofs / ${isMember?'member':'guest'} / ${direct?'Direct':'V2 complete'}: one verification, independent cases`,async()=>{
  const actor=isMember?member:null,send=api(actor),beforeVerify=siteverify;
  const beforeCases=await local.db.prepare('SELECT COUNT(*) n FROM cases').first();let tokenCalls=0,puts=0;
  const batch=new BatchSubmission({api:send,directIntent:direct,token:async()=>{tokenCalls++;return randomUUID();},put:async upload=>{
   puts++;await local.put(upload,bytes,actor?.headers);
  }});
  batch.start(metadata,Array.from({length:count},file),{caseApi:send});
  const result=await batch.attempt();
  assert.equal(result.complete,true,JSON.stringify(result.items.map(x=>x.error)));
  assert.equal(siteverify-beforeVerify,1);assert.equal(tokenCalls,1);assert.equal(puts,count);
  assert.equal(new Set(result.items.map(x=>x.result.case_id)).size,count);
  assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,beforeCases.n+count);
  await batch.attempt();assert.equal(puts,count);assert.equal(siteverify-beforeVerify,1);
 });
}

test('ticket replay can only recover its fixed prepared intent; changed scope, identity or consumed intent is rejected',async()=>{
 const verifiedBefore=siteverify,grant=await json(await authorize());
 const first=await json(await prepare(grant.tickets[0]));
 const repeated=await json(await prepare(grant.tickets[0]));
 assert.equal(first.session_id,repeated.session_id);assert.equal(first.uploads[0].key,repeated.uploads[0].key);
 assert.equal(siteverify-verifiedBefore,1);
 for(const [actor,extra,code] of [[other,{},'UPLOAD_OWNER_MISMATCH'],[null,{},'UPLOAD_OWNER_MISMATCH'],
  [member,{files:[{...claim,sha256:'f'.repeat(64)}]},'BATCH_AUTH_INVALID'],
  [member,{campaign_id:'DIFFERENT'},'BATCH_AUTH_INVALID'],[member,{completion_mode:'direct'},'BATCH_AUTH_INVALID']]){
  const r=await prepare(grant.tickets[0],actor,extra);assert.equal(r.status,403);assert.equal((await r.json()).error.code,code);
 }
 const sessionCount=await local.db.prepare('SELECT COUNT(*) n FROM proof_upload_intents WHERE session_id=?').bind(first.session_id).first();assert.equal(sessionCount.n,1);
 await local.put(first.uploads[0],bytes,member.headers);
 const ref={session_id:first.session_id,keys:[first.uploads[0].key]};
 await json(await local.fetch('/api/uploads/complete','POST',ref,member.headers));
 const key=randomUUID(),body={...metadata,upload_session:ref},headers={...member.headers,'Idempotency-Key':key};
 const receipt=await json(await local.fetch('/api/cases','POST',body,headers));
 assert.equal((await json(await local.fetch('/api/cases','POST',body,headers))).case_id,receipt.case_id);
 assert.equal((await prepare(grant.tickets[0])).status,409);
 assert.equal(siteverify-verifiedBefore,1);
});

test('lost Prepare, PUT and Case ACKs retain fixed intents and idempotency without another verification or PUT',async()=>{
 const beforeVerify=siteverify,beforeCases=(await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n;
 const send=api(member),posts=[],prepared=[];let lostPrepare=true,lostPut=true,lostCase=true,puts=0;
 const transport=async(path,options)=>{
  const data=await send(path,options);
  if(path.endsWith('/prepare')){
   prepared.push(data.session_id);
   if(lostPrepare){lostPrepare=false;throw new PublicError('NETWORK_ERROR');}
  }
  if(path==='/api/cases'){
   posts.push({body:options.body,key:options.headers['Idempotency-Key'],caseId:data.case_id});
   if(lostCase){lostCase=false;throw new PublicError('NETWORK_ERROR');}
  }
  return data;
 };
 const batch=new BatchSubmission({api:transport,token:async()=>randomUUID(),put:async upload=>{
  puts++;await local.put(upload,bytes,member.headers);
  if(lostPut){lostPut=false;const e=new PublicError('R2_UPLOAD_ERROR',502);e.putState='unknown';throw e;}
 }});
 batch.start(metadata,[file(),file(),file()],{caseApi:transport});
 const partial=await batch.attempt();assert.equal(partial.complete,false);assert.equal(partial.succeeded,0);
 const done=await batch.attempt();assert.equal(done.complete,true);
 assert.equal(siteverify-beforeVerify,1);assert.equal(puts,3);
 assert.equal(new Set(prepared).size,3);assert.equal(prepared.length,4);
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,beforeCases+3);
 const repeated=posts.filter(p=>p.key===posts[0].key);assert.equal(repeated.length,2);
 assert.equal(repeated[0].body,repeated[1].body);assert.equal(repeated[0].caseId,repeated[1].caseId);
});

test('batch authorization enforces gate, campaign, CSRF, Origin, count and consumed Siteverify token',async()=>{
 const casesBefore=await local.db.prepare('SELECT COUNT(*) n FROM cases').first();
 assert.equal((await authorize(Array(21).fill(claim))).status,400);
 assert.equal((await authorize([claim,claim],member,{campaign_id:'MISSING'})).status,400);
 const body={turnstile_token:'synthetic',campaign_id:'LOCAL-TEST',files:[claim,claim]};
 assert.equal((await local.fetch('/api/uploads/batch/authorize','POST',body,{...member.headers,'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await local.fetch('/api/uploads/batch/authorize','POST',body,{Origin:'https://other.example'})).status,403);
 await local.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
 try{assert.equal((await authorize()).status,503);}finally{await local.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();}
 const grant=await json(await authorize([claim,claim],member,{turnstile_token:'one-use-fixture-token'}));
 allowVerify=false;
 try{assert.equal((await authorize([claim,claim],member,{turnstile_token:'one-use-fixture-token'})).status,403);}finally{allowVerify=true;}
 await local.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
 try{assert.equal((await prepare(grant.tickets[0])).status,503);}finally{await local.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();}
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,casesBefore.n);
 assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 assert.equal(local.unexpectedUpstreams.length,0);
});
