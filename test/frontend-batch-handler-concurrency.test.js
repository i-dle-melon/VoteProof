import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import worker from '../src/index.js';
import {embeddedCaseRuntime,origin,image} from './helpers/embedded-case-runtime.mjs';
import {installResetExtensionLocal} from '../scripts/lib/prelaunch-selective-reset.mjs';
import {BatchSubmission} from '../public/js/submission.js';import {PublicError} from '../public/js/api.js';
globalThis.location={origin};

for(const [member,n,direct] of [[false,1,false],[true,3,false],[false,20,false],[true,20,true]])test(`actual handlers, ${member?'member':'guest'} ${n} proofs, ${direct?'Direct':'V2 Complete'}: concurrency safe with Reset Fence`,{timeout:20000},async t=>{
 const rt=await embeddedCaseRuntime();t.after(()=>rt.close());
 rt.sqlite.exec("UPDATE submission_settings SET submissions_enabled=1");
 rt.sqlite.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at) VALUES('BATCH-LOCAL','Synthetic','團體','2000-01-01','2100-01-01','Asia/Taipei','2000-01-01','2099-12-31',10,'active',?,?)").run(new Date().toISOString(),new Date().toISOString());
 const actor=member?await rt.identity():null;let verifies=0,puts=0;const calls=[],summaries=[];
 installResetExtensionLocal(rt.sqlite,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));
 rt.sqlite.exec("UPDATE prelaunch_reset_control SET epoch=1,mode='open'");rt.env.PRELAUNCH_RESET_FENCE_ENABLED='true';
 if(actor){const probe=await rt.fetch('/api/auth/me','GET',undefined,actor.headers);assert.equal(probe.status,200);actor.headers['X-CSRF-Token']=(await probe.json()).data.csrf_token;}
 t.mock.method(globalThis,'fetch',async url=>{assert.equal(String(url),'https://challenges.cloudflare.com/turnstile/v0/siteverify');verifies++;return Response.json({success:true});});
 const api=async(path,options={})=>{
  calls.push({path,...options});const r=await worker.fetch(new Request(origin+path,{method:options.method??'GET',headers:{Origin:origin,...actor?.headers,...options.headers,...(options.body?{'Content-Type':'application/json'}:{})},...(options.body?{body:typeof options.body==='string'?options.body:JSON.stringify(options.body)}:{})}),rt.env);
  const body=await r.json();if(!r.ok)throw new PublicError(body.error.code,r.status);return body.data;
 };
 const b=new BatchSubmission({api,gate:async()=>{const s=await api('/api/submissions/status');assert.equal(s.submissions_enabled,true);},directIntent:direct,token:async()=> 'synthetic',changed:s=>summaries.push(s),put:async u=>{
  puts++;const r=await worker.fetch(new Request(u.upload_url,{method:'PUT',headers:{Origin:origin,...actor?.headers,'Content-Length':String(image.length),...u.headers},body:image}),rt.env);
  assert.equal(r.status,200,await r.clone().text());
 }});
 b.start({campaign_id:'BATCH-LOCAL',vote_date:new Date().toISOString().slice(0,10)},Array.from({length:n},(_,i)=>new File([image],`synthetic-${i}.png`,{type:'image/png'})));
 const s=await b.attempt();assert.equal(s.complete,true,JSON.stringify(s.items.map(i=>({status:i.status,error:i.error}))));assert.equal(verifies,1);assert.equal(puts,n);
 const query=sql=>rt.sqlite.prepare(sql).get();assert.equal(query('SELECT COUNT(*) n FROM cases').n,n);assert.equal(query('SELECT COUNT(*) n FROM case_files').n,n);
 assert.equal(query('SELECT COUNT(*) n FROM proof_upload_intents WHERE write_token IS NOT NULL').n,0);assert.equal(query("SELECT COUNT(*) n FROM storage_reservations WHERE state='reserved'").n,0);
 assert.equal(query("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state IN('active','unknown')").n,0);
 assert.equal(new Set(s.items.map(i=>i.result.case_id)).size,n);assert.equal(rt.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
 const before=calls.length;await b.attempt();assert.equal(calls.length,before);assert.ok(summaries.every(x=>x.succeeded+x.failed+x.unknown+x.queued+x.processing===x.total));
});
