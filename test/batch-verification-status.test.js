import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BatchSubmission} from '../public/js/submission.js';
import {PublicError} from '../public/js/api.js';

globalThis.location={origin:'https://voteproof.example'};
function fixture(count,{rejectChallenge=false,direct=false}={}) {
  const phases=[],requests=[],prepares=[];let tokens=0,puts=0,cases=0,active=0,maxActive=0;
  const batch=new BatchSubmission({directIntent:direct,gate:async()=>{},progress:s=>phases.push(s.phase),
    token:async()=>{tokens++;if(rejectChallenge)throw new PublicError('TURNSTILE_INVALID',403);return 'synthetic-only';},
    api:async(path,options)=>{
      requests.push(path);
      if(path.endsWith('/authorize'))return {tickets:options.body.files.map(()=> 'T'.repeat(60)),expires_in:300};
      if(path.endsWith('/prepare')) {
        prepares.push(options.body);const id=randomUUID();
        return {session_id:id,expires_in:300,...(direct?{completion_mode:'direct'}:{}),uploads:[{key:id,method:'PUT',upload_url:`https://voteproof.example/api/uploads/put/${id}/${randomUUID()}`,headers:{'Content-Type':'image/png','X-Upload-Grant':'G'.repeat(60)}}]};
      }
      if(path.endsWith('/complete'))return {};
      assert.equal(path,direct?'/api/cases/direct':'/api/cases');cases++;
      return {case_id:'VP-20261031-'+'ABCDEFGHJKLMNPQRSTUVWXYZ'[cases-1].repeat(16),query_key:'Q'.repeat(43)};
    },put:async()=>{puts++;active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setImmediate(r));active--;}});
  batch.start({campaign_id:'SYNTHETIC',vote_date:'2026-10-31'},Array.from({length:count},(_,i)=>({name:`synthetic-${i}.png`,type:'image/png',size:3,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer})));
  return {batch,phases,requests,prepares,counts:()=>({tokens,puts,cases,maxActive})};
}

for(const direct of [false,true])test(`20 tickets ${direct?'Direct':'V2'}: one batch verification phase, no per-image human verification phase`,async()=>{
  const f=fixture(20,{direct});assert.equal((await f.batch.attempt()).complete,true);
  assert.deepEqual(f.counts(),{tokens:1,puts:20,cases:20,maxActive:2});
  assert.equal(f.requests.filter(x=>x.endsWith('/authorize')).length,1);
  assert.equal(f.prepares.length,20);
  assert.ok(f.prepares.every(x=>x.batch_ticket&&!Object.hasOwn(x,'turnstile_token')));
  assert.equal(f.phases.filter(x=>x==='verify').length,0);
  assert.equal(f.phases.filter(x=>x==='batch_verify').length,1);
  await f.batch.attempt();assert.equal(f.counts().cases,20);assert.equal(f.counts().tokens,1);
});

test('single image keeps exactly one real verification phase and one case',async()=>{
  const f=fixture(1);assert.equal((await f.batch.attempt()).complete,true);
  assert.equal(f.phases.filter(x=>x==='verify').length,1);
  assert.equal(f.phases.filter(x=>x==='batch_verify').length,0);
  assert.equal(f.requests.filter(x=>x.endsWith('/authorize')).length,0);
  assert.deepEqual(f.counts(),{tokens:1,puts:1,cases:1,maxActive:1});
});

test('failed batch challenge still fails closed before Prepare/PUT/Case',async()=>{
  const f=fixture(20,{rejectChallenge:true});await assert.rejects(f.batch.attempt(),{code:'TURNSTILE_INVALID'});
  assert.equal(f.prepares.length,0);assert.equal(f.counts().puts,0);assert.equal(f.counts().cases,0);
  assert.equal(f.phases.filter(x=>x==='batch_verify').length,1);
});
