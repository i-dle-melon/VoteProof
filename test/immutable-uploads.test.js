import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {createCase} from '../src/api/cases.js';
import {putUpload,completeUpload} from '../src/api/uploads.js';
import {cleanupFinalUploads} from '../src/lib/immutable-uploads.js';
import {syntheticProofBytes} from './fixtures/exact-proof-corpus.js';
import {issueUploadGrant,uploadGrantConfig} from '../src/lib/upload-grant.js';
// Node host calls below use Workers' documented constant-time extension.
crypto.subtle.timingSafeEqual??=(a,b)=>timingSafeEqual(Buffer.from(a),Buffer.from(b));
const origin='https://voteproof.example',sha=x=>createHash('sha256').update(x).digest('hex'),bytes=new Uint8Array([1,2,3]);
let h,local;before(async()=>{h=await localAdminRuntime();local=h.local;});after(async()=>await local?.runtime.dispose());
async function data(r,status=200){const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v.data;}
const headers=actor=>({Origin:origin,...actor?.headers});
async function prepare(l=local,actor,source=bytes){return data(await l.fetch('/api/uploads/prepare','POST',{storage_version:2,campaign_id:'LOCAL-TEST',turnstile_token:'synthetic',files:[{name:'fixture.png',type:'image/png',size:source.length,algorithm:'sha256',sha256:sha(source)}]},headers(actor)));}
const reference=p=>({session_id:p.session_id,keys:[p.uploads[0].key],...(p.capability?{capability:p.capability}:{})});
const body=p=>({campaign_id:'LOCAL-TEST',vote_type:'Solo',vote_date:new Date().toISOString().slice(0,10),upload_session:reference(p)});
const complete=(p,l=local,actor,extra={})=>l.fetch('/api/uploads/complete','POST',{...reference(p),...extra},headers(actor));
const create=(p,l=local,actor,key=randomUUID(),extra={})=>l.fetch('/api/cases','POST',{...body(p),...extra},{...headers(actor),'Idempotency-Key':key});
async function uploaded(l=local,actor,source=bytes){const p=await prepare(l,actor,source);await l.put(p.uploads[0],source,headers(actor));return p;}
async function sealed(l=local,actor,source=bytes){const p=await uploaded(l,actor,source);await data(await complete(p,l,actor));return p;}
const environment=l=>({...l.authConfig,DB:l.db,PROOFS_BUCKET:l.bucket});
const req=(p,actor,key=randomUUID())=>new Request(origin+'/api/cases',{method:'POST',headers:{'Content-Type':'application/json',...headers(actor),'Idempotency-Key':key},body:JSON.stringify(body(p))});
const putReq=p=>new Request(p.uploads[0].upload_url,{method:'PUT',headers:{Origin:origin,...p.uploads[0].headers,'Content-Length':'3'},body:bytes});
const future='2099-01-01T00:00:00.000Z';

// Count actual submitted D1 operations; hooks use the raw DB to inject races
// immediately around the real transactional write/readback boundaries.
function observedDb(db,{beforeBatch,afterBatch}={}) {
 const metrics={statements:0,trips:0},raw=new WeakMap(),queries=new WeakMap();
 const wrap=(statement,sql)=>{
  const proxy=new Proxy(statement,{get(target,name){
   if(name==='bind')return(...args)=>wrap(target.bind(...args),sql);
   if(['first','all','run'].includes(name))return(...args)=>{metrics.statements++;metrics.trips++;return target[name](...args);};
   return typeof target[name]==='function'?target[name].bind(target):target[name];
  }});raw.set(proxy,statement);queries.set(proxy,sql);return proxy;
 };
 return {metrics,prepare:sql=>wrap(db.prepare(sql),sql),async batch(statements){
  metrics.statements+=statements.length;metrics.trips++;
  const sql=statements.map(s=>queries.get(s));await beforeBatch?.(sql);
  const result=await db.batch(statements.map(s=>raw.get(s)));await afterBatch?.(sql);return result;
 }};
}
const directComplete=(p,env,actor)=>completeUpload(env,null,new Request(origin+'/api/uploads/complete',{
 method:'POST',headers:{'Content-Type':'application/json',...headers(actor)},body:JSON.stringify(reference(p))}));
const sealWrite=sql=>sql[0]?.startsWith('INSERT INTO completed_uploads');
const sealRead=sql=>sql[0]?.includes('i.state AS intent_state');

test('V2 member/guest complete uses 9/5 and 8/4 D1 operations, including already-sealed retry',async()=>{
 const actor=await h.identity();
 for(const member of [actor,undefined]){
  const p=await uploaded(local,member);let first;
  for(let attempt=0;attempt<2;attempt++){
   const env=environment(local),db=observedDb(local.db);env.DB=db;
   const result=await data(await directComplete(p,env,member));
   assert.deepEqual(db.metrics,{statements:member?9:8,trips:member?5:4});
   if(first)assert.deepEqual(result,first);first=result;
  }
 }
});

test('duplicate concurrent completes seal exactly one consistent manifest',async()=>{
 const p=await uploaded();const responses=await Promise.all(Array.from({length:3},()=>complete(p)));
 const results=await Promise.all(responses.map(r=>data(r)));assert.deepEqual(results,[results[0],results[0],results[0]]);
 assert.equal((await local.db.prepare('SELECT count(*) n FROM completed_upload_files WHERE session_id=?').bind(p.session_id).first()).n,1);
 assert.equal((await local.db.prepare('SELECT state FROM proof_upload_intents WHERE session_id=?').bind(p.session_id).first()).state,'sealed');
});

test('lost seal transaction ACK and lost readback ACK both recover on complete retry',async()=>{
 for(const boundary of [sealWrite,sealRead]){
  const p=await uploaded(),env=environment(local);let injected=false;
  env.DB=observedDb(local.db,{afterBatch:sql=>{if(!injected&&boundary(sql)){injected=true;throw Error('Synthetic lost complete ACK');}}});
  assert.equal((await directComplete(p,env)).status,500);assert.ok(injected);
  const first=await data(await complete(p));assert.deepEqual(await data(await complete(p)),first);
  assert.equal((await local.db.prepare('SELECT state FROM proof_upload_intents WHERE session_id=?').bind(p.session_id).first()).state,'sealed');
 }
});

test('complete rejects a conflicting stored manifest and a corrupt stored file snapshot',async()=>{
 for(const corrupt of ['manifest','file']){
  const p=await sealed();
  await local.db.prepare(corrupt==='manifest'?"UPDATE completed_uploads SET manifest_hash=? WHERE session_id=?":
   'UPDATE completed_upload_files SET etag=? WHERE session_id=?').bind('a'.repeat(64),p.session_id).run();
  const response=await complete(p);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'UPLOAD_SESSION_CONFLICT');
  assert.ok(await local.bucket.head(p.uploads[0].key));
 }
});

test('consume before post-seal readback fails closed; an already-consumed complete remains compatible',async()=>{
 const p=await sealed(),env=environment(local);let consumed;
 env.DB=observedDb(local.db,{beforeBatch:async sql=>{if(sealRead(sql)&&!consumed)consumed=await data(await create(p),201);}});
 const response=await directComplete(p,env);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'UPLOAD_ALREADY_USED');
 assert.ok(consumed);await data(await complete(p));
 assert.equal((await local.db.prepare('SELECT count(*) n FROM cases WHERE upload_session_id=?').bind(p.session_id).first()).n,1);
});

test('consume after the readback snapshot remains valid; no second Case can consume it',async()=>{
 const p=await uploaded(),env=environment(local);let consumed;
 env.DB=observedDb(local.db,{afterBatch:async sql=>{if(sealRead(sql))consumed=await data(await create(p),201);}});
 await data(await directComplete(p,env));assert.ok(consumed);assert.equal((await create(p)).status,409);
 assert.ok(await local.bucket.head(p.uploads[0].key));
});

test('cleanup before seal write or before readback cannot attest a stale sealed intent',async()=>{
 for(const boundary of [sealWrite,sealRead]){
  const p=await uploaded(),env=environment(local);let cleaned=false;
  env.DB=observedDb(local.db,{beforeBatch:async sql=>{if(!cleaned&&boundary(sql)){cleaned=true;await cleanupFinalUploads(environment(local),{now:future});}}});
  const response=await directComplete(p,env);assert.equal(response.status,409);assert.ok(cleaned);
  assert.equal((await local.db.prepare('SELECT state FROM proof_upload_intents WHERE session_id=?').bind(p.session_id).first()).state,'deleted');
  const creating=await create(p);assert.equal(creating.status,boundary===sealWrite?400:403);
  assert.equal((await creating.json()).error.code,boundary===sealWrite?'UPLOAD_NOT_COMPLETED':'UPLOAD_OWNER_MISMATCH');
 }
});

test('incomplete pinned writer cannot seal; provider-completed bytes with lost ACK retain their pin on seal',async()=>{
 const p=await prepare(),env=environment(local);let enter,release;
 const entered=new Promise(r=>enter=r),resume=new Promise(r=>release=r);
 env.PROOFS_BUCKET={head:(...args)=>local.bucket.head(...args),put:async(key,_stream,options)=>{enter();await resume;await local.bucket.put(key,bytes,options);throw Error('Synthetic lost native ACK');}};
 const writing=putUpload(env,new URL(p.uploads[0].upload_url),putReq(p));await entered;
 try{assert.equal((await complete(p)).status,400);}finally{release();}
 assert.equal((await writing).status,502);await data(await complete(p));
 const row=await local.db.prepare('SELECT state,write_token FROM proof_upload_intents WHERE session_id=?').bind(p.session_id).first();
 assert.equal(row.state,'sealed');assert.ok(row.write_token,'Seal must not release an ambiguous writer pin');
});

test('expired intent is rejected before R2 even if a client retries completion',async()=>{
 const p=await prepare(),session=randomUUID(),proof=randomUUID(),key=`proofs/final/${session}/${proof}.png`;
 await local.db.prepare(`INSERT INTO proof_upload_intents(session_id,proof_id,object_key,campaign_id,member_id,guest_capability_hash,
  content_type,size,expected_sha256,created_at,expires_at,grant_expires)
  SELECT ?,?,?,campaign_id,member_id,guest_capability_hash,content_type,size,expected_sha256,created_at,?,grant_expires
  FROM proof_upload_intents WHERE session_id=?`).bind(session,proof,key,'2000-01-01T00:00:00.000Z',p.session_id).run();
 const expired={...p,session_id:session,proof_id:proof,uploads:[{key}]},env=environment(local);
 env.PROOFS_BUCKET={head:()=>assert.fail('Expired intent must fail before HEAD')};
 for(let attempt=0;attempt<2;attempt++){const response=await directComplete(expired,env);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'UPLOAD_SESSION_EXPIRED');}
});

test('post-seal readback rechecks expiry instead of trusting the initial intent',async()=>{
 const p=await uploaded(),env=environment(local);
 env.DB=observedDb(local.db,{beforeBatch:async sql=>{if(sealRead(sql))await local.db.prepare(
  "UPDATE completed_uploads SET expires_at='2000-01-01T00:00:00.000Z' WHERE session_id=?").bind(p.session_id).run();}});
 const response=await directComplete(p,env);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'UPLOAD_SESSION_EXPIRED');
});

test('prepare retry allocates independent proof identities, no premature Case and no plaintext capability in DB',async()=>{
 const a=await prepare(),b=await prepare();assert.notEqual(a.proof_id,b.proof_id);assert.notEqual(a.session_id,b.session_id);
 assert.match(a.uploads[0].key,/^proofs\/final\//);assert.match(a.capability,/^[A-Za-z0-9_-]{43}$/);
 const row=await local.db.prepare('SELECT * FROM proof_upload_intents WHERE session_id=?').bind(a.session_id).first();assert.ok(!JSON.stringify(row).includes(a.capability));assert.equal(row.state,'prepared');
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases WHERE upload_session_id=?').bind(a.session_id).first()).n,0);
});
test('native conditional create rejects every replay body; complete recovers the original same-bytes upload',async()=>{
 const p=await uploaded(),u=p.uploads[0],before=await local.bucket.head(u.key);
 for(const source of [bytes,new Uint8Array([3,2,1])]){const r=await local.runtime.dispatchFetch(u.upload_url,{method:'PUT',headers:{Origin:origin,...u.headers,'Content-Length':'3'},body:source});assert.ok([409,502].includes(r.status));if(source===bytes)assert.equal((await r.json()).error.code,'UPLOAD_ALREADY_UPLOADED');}
 assert.equal((await local.bucket.head(u.key)).etag,before.etag);assert.deepEqual(new Uint8Array(await (await local.bucket.get(u.key)).arrayBuffer()),bytes);
 await data(await complete(p));await data(await complete(p));
});
test('seal rejects forged keys, metadata and absent/wrong guest capability without deleting immutable objects',async()=>{
 const p=await uploaded();assert.equal((await complete(p,local,undefined,{capability:'a'.repeat(43)})).status,403);
 assert.equal((await complete(p,local,undefined,{size:4})).status,400);
 const ref=reference(p);delete ref.capability;assert.equal((await local.fetch('/api/uploads/complete','POST',ref,headers())).status,403);
 assert.equal((await complete(p,local,undefined,{keys:[p.uploads[0].key.replace(p.proof_id,randomUUID())]})).status,409);
 // Privileged fixture mutation, simulating a damaged object; the client has no such API.
 await local.bucket.put(p.uploads[0].key,new Uint8Array([4,5,6]),{sha256:sha(new Uint8Array([4,5,6])),httpMetadata:{contentType:'image/png'}});
 assert.equal((await complete(p)).status,409);assert.ok(await local.bucket.head(p.uploads[0].key));
});
test('new member intents require CSRF and cannot be claimed by another member or guest',async()=>{
 const a=await h.identity(),b=await h.identity();const p=await sealed(local,a);
 assert.equal((await complete(p,local,b)).status,403);assert.equal((await create(p,local,b)).status,403);assert.equal((await create(p)).status,403);
 const bad=await local.fetch('/api/uploads/prepare','POST',{storage_version:2,campaign_id:'LOCAL-TEST',turnstile_token:'synthetic',files:[{name:'x.png',type:'image/png',size:3,algorithm:'sha256',sha256:sha(bytes)}]},{...a.headers,'X-CSRF-Token':'bad'});assert.equal(bad.status,403);
 const result=await data(await create(p,local,a),201);const row=await local.db.prepare('SELECT member_id FROM cases WHERE case_id=?').bind(result.case_id).first();assert.equal(row.member_id,a.memberId);
});
test('Campaign binding, fresh gate, Campaign expiry and member suspension still reject after seal',async()=>{
 const isolated=await localAdminRuntime(),l=isolated.local;try{
 await l.campaign({campaign_id:'OTHER'});const p=await sealed(l);assert.equal((await create(p,l,undefined,randomUUID(),{campaign_id:'OTHER'})).status,403);
 await l.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();try{assert.equal((await create(p,l)).status,503);}finally{await l.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();}
 const a=await isolated.identity(),m=await sealed(l,a);await l.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(a.memberId).run();assert.equal((await create(m,l,a)).status,403);
 await l.db.prepare("UPDATE campaigns SET status='closed',version=version+1 WHERE campaign_id='LOCAL-TEST'").run();assert.equal((await create(p,l)).status,400);
 }finally{await l.runtime.dispose();}
});
test('lost response and concurrent same-key replay return the same query key; second key cannot consume twice',async()=>{
 const p=await sealed(),key=randomUUID(),first=await data(await create(p,local,undefined,key),201);
 const replays=await Promise.all(Array.from({length:3},()=>create(p,local,undefined,key)));for(const r of replays)assert.deepEqual(await data(r,201),first);
 assert.equal((await create(p)).status,409);assert.ok(await local.bucket.head(p.uploads[0].key));
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases WHERE upload_session_id=?').bind(p.session_id).first()).n,1);
 const lookup=await local.fetch('/api/cases/'+first.case_id,'GET',undefined,{'X-Case-Query-Key':first.query_key});assert.equal(lookup.status,200);
});
test('lost D1 commit ACK preserves the one final object and reads back the committed result',async()=>{
 const p=await sealed(),env=environment(local),db=local.db;let injected=false;
 env.DB={prepare:q=>db.prepare(q),batch:async statements=>{const r=await db.batch(statements);if(!injected){injected=true;throw Error('synthetic lost ACK');}return r;}};
 const r=await createCase(env,null,req(p));assert.equal(r.status,201);assert.ok(await local.bucket.head(p.uploads[0].key));
 const f=await local.db.prepare('SELECT * FROM case_files WHERE upload_object_key=?').bind(p.uploads[0].key).first();assert.equal(f.id,p.proof_id);assert.equal(f.object_key,p.uploads[0].key);
});
test('missing sealed object fails before Case commit and does not enqueue backup or points',async()=>{
 const p=await sealed();await local.bucket.delete(p.uploads[0].key);assert.equal((await create(p)).status,409);assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases WHERE upload_session_id=?').bind(p.session_id).first()).n,0);
});
test('cleanup pins in-flight PUTs; late PUT after cleanup cannot resurrect an object',async()=>{
 const isolated=await localAdminRuntime();const l=isolated.local;try{
  const p=await prepare(l),env=environment(l);let enter,release;const entered=new Promise(r=>enter=r),resume=new Promise(r=>release=r);
  env.PROOFS_BUCKET={put:async(key,_stream,options)=>{enter();await resume;return l.bucket.put(key,bytes,options);},head:(...a)=>l.bucket.head(...a)};
  const uploading=putUpload(env,new URL(p.uploads[0].upload_url),putReq(p));await entered;
  assert.equal((await cleanupFinalUploads(environment(l),{now:future})).claimed,0);release();assert.equal((await uploading).status,200);
  assert.equal((await cleanupFinalUploads(environment(l),{now:future})).deleted,1);assert.equal(await l.bucket.head(p.uploads[0].key),null);
  const late=await l.runtime.dispatchFetch(p.uploads[0].upload_url,{method:'PUT',headers:{Origin:origin,...p.uploads[0].headers,'Content-Length':'3'},body:bytes});assert.equal(late.status,409);assert.equal(await l.bucket.head(p.uploads[0].key),null);
 }finally{await l.runtime.dispose();}
});
test('ambiguous PUT remains quarantined; it is never reclaimed by an expired clock lease',async()=>{
 const isolated=await localAdminRuntime(),l=isolated.local;try{const p=await prepare(l),env=environment(l);env.PROOFS_BUCKET={put:async()=>{throw Error('unknown native ACK');},head:(...a)=>l.bucket.head(...a)};
 const r=await putUpload(env,new URL(p.uploads[0].upload_url),putReq(p));assert.equal(r.status,502);assert.equal((await r.json()).error.code,'UPLOAD_REPREPARE_REQUIRED');assert.equal((await cleanupFinalUploads(environment(l),{now:future})).claimed,0);
 const replacement=await prepare(l);assert.notEqual(replacement.session_id,p.session_id);
 }finally{await l.runtime.dispose();}
});
test('cleanup wins before commit: guarded transaction creates no Case; Case winner is never collected',async()=>{
 const isolated=await localAdminRuntime(),l=isolated.local;try{
  const p=await sealed(l),env=environment(l);let enter,release;const entered=new Promise(r=>enter=r),resume=new Promise(r=>release=r);
  env.PROOFS_BUCKET={head:async(...a)=>{const o=await l.bucket.head(...a);enter();await resume;return o;}};
  const creating=createCase(env,null,req(p));await entered;assert.equal((await cleanupFinalUploads(environment(l),{now:future})).deleted,1);release();assert.notEqual((await creating).status,201);
  assert.equal((await l.db.prepare('SELECT COUNT(*) n FROM cases WHERE upload_session_id=?').bind(p.session_id).first()).n,0);
  const winner=await sealed(l);await data(await create(winner,l),201);await cleanupFinalUploads(environment(l),{now:future});assert.ok(await l.bucket.head(winner.uploads[0].key));
 }finally{await l.runtime.dispose();}
});
test('20 independent images survive a single missing object; retries do not rebuild the other 19',async()=>{
 const prepared=[];for(let i=0;i<20;i++)prepared.push({p:await sealed(),key:randomUUID()});const failed=prepared[7];await local.bucket.delete(failed.p.uploads[0].key);
 const ids=[];for(const item of prepared){const r=await create(item.p,local,undefined,item.key);if(item===failed)assert.equal(r.status,409);else ids.push((await data(r,201)).case_id);}
 assert.equal(new Set(ids).size,19);const replacement=await sealed();await data(await create(replacement),201);
 for(const item of prepared.filter(x=>x!==failed))assert.ok(ids.includes((await data(await create(item.p,local,undefined,item.key),201)).case_id));
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,0);
});
test('maximum 5 MiB proof links the original immutable key and native checksum',async()=>{
 const p=await sealed(local,undefined,syntheticProofBytes(5242880,75));await data(await create(p),201);const row=await local.db.prepare('SELECT f.object_key,h.sha256 FROM case_files f JOIN proof_exact_hashes h ON h.file_id=f.id WHERE f.id=?').bind(p.proof_id).first();assert.equal(row.object_key,p.uploads[0].key);assert.equal(row.sha256,sha(syntheticProofBytes(5242880,75)));
});
test('expired encrypted grants are rejected before any object write',async()=>{
 const p=await prepare(),row=await local.db.prepare('SELECT * FROM proof_upload_intents WHERE session_id=?').bind(p.session_id).first();
 const grant=await issueUploadGrant(await uploadGrantConfig(environment(local)),new URL(p.uploads[0].upload_url).pathname,row.object_key,{type:row.content_type,size:row.size,sha256:row.expected_sha256},
   {sessionId:row.session_id,proofId:row.proof_id,campaignId:row.campaign_id,memberId:null,guestCapabilityHash:row.guest_capability_hash,expires:Math.floor(Date.now()/1000)-1});
 const r=await local.runtime.dispatchFetch(grant.upload_url,{method:'PUT',headers:{Origin:origin,...grant.headers,'Content-Length':'3'},body:bytes});assert.equal(r.status,403);assert.equal(await local.bucket.head(row.object_key),null);
});
test('identity, expiration, checksum and permanent cleanup tombstones cannot be rewritten',async()=>{
 await assert.rejects(cleanupFinalUploads({}, {limit:11}),TypeError);
 const p=await prepare();for(const sql of ["UPDATE proof_upload_intents SET expected_sha256='"+'a'.repeat(64)+"' WHERE session_id=?","UPDATE proof_upload_intents SET expires_at='2100-01-01T00:00:00.000Z' WHERE session_id=?",'DELETE FROM proof_upload_intents WHERE session_id=?'])await assert.rejects(local.db.prepare(sql).bind(p.session_id).run());
});
test('unknown native PUT verifies the original upload in the browser without allocating another intent',async()=>{
 const {Submission}=await import('../public/js/submission.js');globalThis.location={origin};let prepared=0,puts=0;
 const api=async(path,opt)=>{if(path.endsWith('prepare')){prepared++;return{session_id:randomUUID(),expires_in:300,capability:'a'.repeat(43),uploads:[{key:'proofs/final/'+randomUUID()+'/'+randomUUID()+'.png',method:'PUT',headers:{'Content-Type':'image/png','X-Upload-Grant':'a'.repeat(64)},upload_url:origin+'/api/uploads/put/'+randomUUID()+'/'+randomUUID()}]};}if(path.endsWith('complete'))return{};return{case_id:'VP-20261014-'+'A'.repeat(16),query_key:'a'.repeat(43)};};
 const flow=new Submission({api,put:async()=>{if(puts++===0)throw Object.assign(Error('retry'),{code:'UPLOAD_REPREPARE_REQUIRED'});},token:async()=>randomUUID()});flow.start(body({session_id:randomUUID(),uploads:[{key:'x'}]}),[{type:'image/png',size:3,arrayBuffer:async()=>bytes.buffer}]);await assert.rejects(flow.attempt());assert.ok(await flow.attempt());assert.equal(prepared,1);assert.equal(puts,1);
});
test('lost native PUT ACK is recoverable by its provider-persisted writer marker, never by age alone',async()=>{
 const isolated=await localAdminRuntime(),l=isolated.local;try{const p=await prepare(l),env=environment(l);env.PROOFS_BUCKET={head:(...a)=>l.bucket.head(...a),put:async(key,_stream,options)=>{await l.bucket.put(key,bytes,options);throw Error('synthetic provider ACK loss');}};
 assert.equal((await putUpload(env,new URL(p.uploads[0].upload_url),putReq(p))).status,502);assert.ok(await l.bucket.head(p.uploads[0].key));
 assert.equal((await cleanupFinalUploads(environment(l),{now:future})).deleted,1);assert.equal(await l.bucket.head(p.uploads[0].key),null);
 }finally{await l.runtime.dispose();}
});
test('rollback stops new final intents but preserves reads of already sealed V2 proofs',async()=>{
 const isolated=await localAdminRuntime(),l=isolated.local;try{const p=await sealed(l);await l.setAuthConfig({IMMUTABLE_FINAL_UPLOAD_ENABLED:'false'});await assert.rejects(prepare(l));const old=await l.upload();assert.match(old.keys[0],/^proofs\/staging\//);await data(await create(p,l),201);
 }finally{await l.runtime.dispose();}
});
test('existing private Admin image and Drive relay use the same final authoritative object',async()=>{
 const isolated=await localAdminRuntime(),l=isolated.local;try{
 const relay='a'.repeat(64);await l.setAuthConfig({GOOGLE_DRIVE_BACKUP_ENABLED:'true',DRIVE_BACKUP_TRANSPORT:'apps_script_pull',DRIVE_BACKUP_RELAY_SECRET:relay});
 const p=await sealed(l),result=await data(await create(p,l),201),admin=await isolated.identity({role:'admin'});
 const image=await l.fetch(`/api/admin/cases/${result.case_id}/files/${p.proof_id}`,'GET',undefined,admin.headers);assert.equal(image.status,200);assert.deepEqual(new Uint8Array(await image.arrayBuffer()),bytes);
 const row=await l.db.prepare('SELECT * FROM proof_backups WHERE file_id=?').bind(p.proof_id).first();
 assert.ok(row,'Successful final-proof creation must enqueue the existing backup');assert.equal(row.source_object_key,p.uploads[0].key);
 const job=(await data(await l.fetch('/api/internal/drive-backup/claim','POST',{request_id:randomUUID(),root_folder_id:randomUUID().replaceAll('-','')},{Authorization:'Bearer '+relay}))).job;
 const backup=await l.fetch('/api/internal/drive-backup/'+job.backup_id+'/content','GET',undefined,{Authorization:'Bearer '+relay,'X-VoteProof-Backup-Lease':job.lease_token,'X-VoteProof-Backup-Attempt':String(job.attempt)});assert.equal(backup.status,200);assert.deepEqual(new Uint8Array(await backup.arrayBuffer()),bytes);
 }finally{await l.runtime.dispose();}
});
