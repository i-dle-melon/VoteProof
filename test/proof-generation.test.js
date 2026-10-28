import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{createHash,randomUUID}from'node:crypto';
import worker from'../src/index.js';import{proofKey,proofKeyEpoch}from'../src/lib/proof-generation.js';import{validateComplete}from'../src/api/upload-validation.js';
import{embeddedCaseRuntime,origin,image}from'./helpers/embedded-case-runtime.mjs';import{fencedRequest}from'../src/lib/prelaunch-reset-fence.js';
import{installResetExtensionLocal,snapshotReset,planSelectiveReset,executeSelectiveResetLocal}from'../scripts/lib/prelaunch-selective-reset.mjs';
globalThis.fetch=async u=>{if(String(u)!=='https://challenges.cloudflare.com/turnstile/v0/siteverify')throw Error('NETWORK_FORBIDDEN');return Response.json({success:true});};
const sql=fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'),sha=b=>createHash('sha256').update(b).digest('hex');
const scoped=n=>({PRELAUNCH_RESET_FENCE_ENABLED:'true',PRELAUNCH_RESET_CONTEXT:{epoch:n}});
async function setup(t,{old=false}={}){
 const rt=await embeddedCaseRuntime();t.after(()=>rt.close());rt.sqlite.exec('UPDATE submission_settings SET submissions_enabled=1');
 rt.sqlite.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at) VALUES('GEN-TEST','Synthetic','團體','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','Asia/Taipei','2000-01-01','2099-12-31',10,'active',?,?)").run(new Date().toISOString(),new Date().toISOString());
 if(old)rt.old=await rt.upload('GEN-TEST',null,{storageVersion:1,direct:false});
 rt.sqlite.exec('UPDATE submission_settings SET submissions_enabled=0');installResetExtensionLocal(rt.sqlite,sql);rt.sqlite.prepare('UPDATE prelaunch_reset_control SET run_id=?').run(randomUUID());
 const manifest=planSelectiveReset(snapshotReset(rt.sqlite),undefined,{legacy_io:'LOCAL_SYNTHETIC_ALL_INVOCATIONS_ENDED',image_bypass_closed:true});assert.deepEqual(manifest.blockers,[]);
 executeSelectiveResetLocal(rt.sqlite,manifest,{authority:'LOCAL_SYNTHETIC_ONLY',expectedManifestHash:manifest.sha256});
 rt.sqlite.exec("UPDATE prelaunch_reset_control SET mode='open'");rt.env.PRELAUNCH_RESET_FENCE_ENABLED='true';
 await fencedRequest(rt.env,new Request(origin+'/api/synthetic-open',{method:'POST'}),async env=>{await env.DB.prepare('UPDATE submission_settings SET submissions_enabled=1').run();return Response.json({ok:true});});return rt;
}
async function legacy(rt,n=2,extra={}){
 const p=await rt.fetch('/api/uploads/prepare','POST',{turnstile_token:'synthetic',files:Array.from({length:n},(_,i)=>({name:i+'.png',type:'image/png',size:image.length,algorithm:'sha256',sha256:sha(image)})),...extra});assert.equal(p.status,200,await p.clone().text());const data=(await p.json()).data;
 for(const u of data.uploads){const put=await worker.fetch(new Request(u.upload_url,{method:'PUT',headers:{...u.headers,Origin:origin,'Content-Length':String(image.length)},body:image}),rt.env);assert.equal(put.status,200,await put.text());}
 const ref={session_id:data.session_id,keys:data.uploads.map(u=>u.key)},complete=await rt.fetch('/api/uploads/complete','POST',ref);assert.equal(complete.status,200,await complete.text());return{data,ref};
}
const submit=(rt,ref,direct=false)=>rt.fetch(direct?'/api/cases/direct':'/api/cases','POST',{campaign_id:'GEN-TEST',vote_date:new Date().toISOString().slice(0,10),upload_session:ref},{Origin:origin,'Idempotency-Key':randomUUID()});

test('all three key classes are structurally disjoint even when UUID/path suffixes are identical',()=>{
 for(const kind of ['staging','final','cases']){const suffix='same/server-identifiers.png',old=proofKey({},kind,suffix),a=proofKey(scoped(0),kind,suffix),b=proofKey(scoped(1),kind,suffix);assert.notEqual(old,a);assert.notEqual(a,b);assert.equal(b,`proofs/${kind}/g1/${suffix}`);assert.equal(proofKeyEpoch(b),1);}
 assert.throws(()=>proofKey({PRELAUNCH_RESET_FENCE_ENABLED:'true'},'final','x'),/TRUSTED/);
});
test('strict parser accepts historical and canonical generation references, rejecting malformed/unsafe epochs',()=>{
 const session=randomUUID(),file=randomUUID();for(const prefix of ['','g0/','g1/'])for(const kind of ['staging','final']){const key=`proofs/${kind}/${prefix}${kind==='staging'?'2026/10/28/':''}${session}/${file}.png`;assert.equal(validateComplete({session_id:session,keys:[key]}).keys[0],key);}
 for(const prefix of ['g01','g-1','g9007199254740992','g1/g2','g1%2f'])assert.throws(()=>validateComplete({session_id:session,keys:[`proofs/final/${prefix}/${session}/${file}.png`]}));
});
test('actual Legacy multi-image and private-copy use D1 epoch; client generation claims have no effect',async t=>{
 const rt=await setup(t),u=await legacy(rt,2,{generation:99,epoch:99});assert.ok(u.ref.keys.every(k=>k.startsWith('proofs/staging/g1/')));
 const result=await submit(rt,u.ref);assert.equal(result.status,201,await result.text());const rows=rt.sqlite.prepare('SELECT object_key,upload_object_key FROM case_files').all();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.object_key.startsWith('proofs/cases/g1/')&&r.upload_object_key.startsWith('proofs/staging/g1/')));
});
test('actual V2 and Direct remain usable with generation-bound final references',async t=>{
 const rt=await setup(t);for(const direct of[false,true]){const u=await rt.upload('GEN-TEST',null,{storageVersion:2,direct});assert.ok(u.ref.keys[0].startsWith('proofs/final/g1/'));const r=await submit(rt,u.ref,direct);assert.equal(r.status,201,await r.text());}
});
test('old native DELETE completing late cannot delete new Legacy bytes even with identical upload UUIDs',async t=>{
 const rt=await setup(t,{old:true}),oldKey=rt.old.ref.keys[0],ids=oldKey.match(/\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.png$/);assert.ok(ids);let entered,release;const ready=new Promise(r=>entered=r),latch=new Promise(r=>release=r);
 const oldIO=(async()=>{entered();await latch;await rt.bucket.delete(oldKey);})();await ready;
 const original=crypto.randomUUID;let i=0;crypto.randomUUID=()=>i<2?ids[++i]:original.call(crypto);let u;
 try{u=await legacy(rt,1);}finally{crypto.randomUUID=original;}
 assert.equal(u.ref.session_id,rt.old.ref.session_id);assert.notEqual(u.ref.keys[0],oldKey);assert.ok(await rt.bucket.head(u.ref.keys[0]));release();await oldIO;
 assert.equal(await rt.bucket.head(oldKey),null);assert.ok(await rt.bucket.head(u.ref.keys[0]));const r=await submit(rt,u.ref);assert.equal(r.status,201,await r.text());
});
test('old grant/session and all earlier-generation R2 reads/writes are refused without touching the bucket',async t=>{
 const rt=await setup(t,{old:true});const complete=await rt.fetch('/api/uploads/complete','POST',rt.old.ref);assert.equal(complete.status,409);
 const u=rt.old.p.uploads[0],put=await worker.fetch(new Request(u.upload_url,{method:'PUT',headers:{...u.headers,Origin:origin,'Content-Length':String(image.length)},body:image}),rt.env);assert.equal(put.status,409);
 let native=0;const real=rt.env.PROOFS_BUCKET;rt.env.PROOFS_BUCKET={...real,...Object.fromEntries(['get','head','put','delete'].map(n=>[n,async(...args)=>{native++;return real[n](...args);}]))};
 for(const n of['get','head','put','delete'])for(const key of[rt.old.ref.keys[0],'proofs/final/g0/'+randomUUID()+'/'+randomUUID()+'.png'])await assert.rejects(fencedRequest(rt.env,new Request(origin+'/api/synthetic-r2',{method:n==='put'||n==='delete'?'POST':'GET'}),async env=>{await env.PROOFS_BUCKET[n](key,image);return Response.json({ok:true});}));assert.equal(native,0);
 assert.ok(await real.head(rt.old.ref.keys[0]));
});
test('request paused before native PUT cannot write after the authoritative epoch changes',async t=>{
 const rt=await setup(t);let entered,release;const ready=new Promise(r=>entered=r),latch=new Promise(r=>release=r);let writes=0;const real=rt.env.PROOFS_BUCKET;rt.env.PROOFS_BUCKET={...real,async put(...args){writes++;return real.put(...args);}};
 const pending=fencedRequest(rt.env,new Request(origin+'/api/synthetic-late',{method:'POST'}),async env=>{const key=proofKey(env,'final',randomUUID()+'/'+randomUUID()+'.png');assert.ok(Object.isFrozen(env.PRELAUNCH_RESET_CONTEXT));entered();await latch;await env.PROOFS_BUCKET.put(key,image);return Response.json({ok:true});});await ready;rt.sqlite.exec('UPDATE prelaunch_reset_control SET epoch=2');release();await assert.rejects(pending);assert.equal(writes,0);
});
