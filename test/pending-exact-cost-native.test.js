// Real local workerd D1 metadata; no Cloud CPU/billing claim and no remote I/O.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import{createHash,randomUUID,timingSafeEqual}from'node:crypto';
import{unstable_splitSqlQuery}from'wrangler';
import{localAdminRuntime}from'../scripts/lib/local-admin-runtime.mjs';
import{RESET_V1_SQL_SHA256}from'../src/lib/prelaunch-reset-schema.js';
import{memberSession,csrfToken}from'../src/lib/auth-session.js';
import{fencedRequest}from'../src/lib/prelaunch-reset-fence.js';
import{prepareUpload,putUpload}from'../src/api/uploads.js';
import{createDirectCase}from'../src/api/cases.js';import{reviewAdminCase}from'../src/api/admin.js';
import{observeUploadCost}from'./helpers/upload-cost-observer.mjs';
crypto.subtle.timingSafeEqual??=(a,b)=>timingSafeEqual(Buffer.from(a),Buffer.from(b));
const origin='https://voteproof.example',bytes=new Uint8Array([1,2,3]),sha=createHash('sha256').update(bytes).digest('hex');
const compact=c=>({read:c.rows_read,written:c.rows_written,trips:c.trips,metadata_complete:c.rows_metadata_complete,r2:c.r2});

test('local native D1: pending policy costs, automatic review and atomic Trigger rollback',async t=>{
 const h=await localAdminRuntime({directIntent:true}),l=h.local;t.after(()=>l.runtime.dispose());
 const actor=await h.identity({role:'admin'});let db=l.db;
 await db.prepare("UPDATE campaigns SET points_per_proof=3,daily_limit=NULL WHERE campaign_id='LOCAL-TEST'").run();
 const install=sql=>db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
 await install(fs.readFileSync('migrations-storage-policy/0001_observe_capacity.sql','utf8'));
 await db.prepare("UPDATE storage_capacity SET upload_policy='observe',trusted_until=0").run();
 await install(fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));
 await db.prepare('INSERT INTO prelaunch_reset_schema_versions VALUES(1,?,?)').bind(RESET_V1_SQL_SHA256,new Date().toISOString()).run();
 await db.prepare("UPDATE prelaunch_reset_control SET epoch=1,mode='open'").run();
 await install(fs.readFileSync('migrations-exact-classification/0001_case_sha256.sql','utf8'));
 const upgrade=fs.readFileSync('migrations-exact-pending-classification/0001_pending_duplicate.sql','utf8');
 const oldTrigger=(await db.prepare("SELECT sql FROM sqlite_master WHERE name='case_sha_decision_insert'").first()).sql;
 await assert.rejects(()=>db.batch([...unstable_splitSqlQuery(upgrade).map(s=>db.prepare(s)),db.prepare('SELECT * FROM local_missing_table')]));
 assert.equal((await db.prepare("SELECT sql FROM sqlite_master WHERE name='case_sha_decision_insert'").first()).sql,oldTrigger);
 const upgradeCost=await install(upgrade);
 await l.setAuthConfig({PRELAUNCH_RESET_FENCE_ENABLED:'true',STORAGE_CAPACITY_ENFORCEMENT:'disabled',EXACT_DUPLICATE_CLASSIFICATION_ENABLED:'true',GOOGLE_DRIVE_BACKUP_ENABLED:'true',DRIVE_BACKUP_RELAY_SECRET:'a'.repeat(64)});
 db=l.db;const env={...l.authConfig,DB:l.db,PROOFS_BUCKET:l.bucket};
 await fencedRequest(env,new Request(origin+'/api/local-policy',{method:'POST'}),async e=>{await e.DB.prepare('UPDATE case_sha256_control SET enabled=1,version=version+1 WHERE id=1').run();return Response.json({ok:true});});
 const session=await memberSession(new Request(origin,{headers:actor.headers}),env);actor.headers['X-CSRF-Token']=await csrfToken(session,{...env,PRELAUNCH_RESET_CONTEXT:{epoch:1}});
 const request=(path,body,extra={})=>new Request(origin+path,{method:'POST',headers:{...actor.headers,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
 const measure=async(handler,req,{legacyWriter=false,exact=true}={})=>{
  const raw=env.DB;
  const localEnv={...env,EXACT_DUPLICATE_CLASSIFICATION_ENABLED:exact?'true':'false',DB:legacyWriter?{prepare(sql){return raw.prepare(sql.includes('INSERT INTO case_sha256_decisions')?sql.replace("m.status IN('approved','completed','pending') THEN 'exact_duplicate'","m.status IN('approved','completed') THEN 'exact_duplicate' WHEN m.status='pending' THEN 'pending_match'"):sql);},batch:xs=>raw.batch(xs)}:raw};
  const o=observeUploadCost(localEnv);const value=await o.run(e=>fencedRequest(e,req,scoped=>handler(scoped,new URL(req.url),req)));assert.equal(o.count.rows_metadata_complete,true);
  return{value,cost:compact(o.count)};
 };
 async function proof(legacyWriter=false){
  const p=await measure(prepareUpload,request('/api/uploads/prepare',{storage_version:2,completion_mode:'direct',campaign_id:'LOCAL-TEST',turnstile_token:'synthetic',files:[{name:'x.png',type:'image/png',size:3,algorithm:'sha256',sha256:sha}]}));
  const put=await measure(putUpload,new Request(p.value.uploads[0].upload_url,{method:'PUT',headers:{...actor.headers,...p.value.uploads[0].headers,'Content-Length':'3'},body:bytes}));
  const c=await measure(createDirectCase,request('/api/cases/direct',{campaign_id:'LOCAL-TEST',vote_date:new Date().toISOString().slice(0,10),upload_session:{session_id:p.value.session_id,keys:[p.value.uploads[0].key]}},{'Idempotency-Key':randomUUID()}),{legacyWriter});
  const total={read:0,written:0,trips:0,r2:{head:0,get:0,put:0,delete:0}};for(const x of[p,put,c]){for(const k of['read','written','trips'])total[k]+=x.cost[k];for(const k of Object.keys(total.r2))total.r2[k]+=x.cost.r2[k];}
  return{...c,total};
 }
 const root=await proof(),historical=await proof(true),current=await proof();
 assert.equal(historical.value.status,'pending');assert.equal(current.value.status,'duplicate');
 const normal=await measure(reviewAdminCase,request('/api/admin/cases/'+root.value.case_id+'/review',{action:'approve',expected_version:0}));
 const duplicate=await measure(reviewAdminCase,request('/api/admin/cases/'+historical.value.case_id+'/review',{action:'approve',expected_version:0}));
 assert.equal(duplicate.value.status,'duplicate');assert.equal(duplicate.value.points_awarded,0);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,1);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").first()).n,0);
 assert.equal(historical.total.written,current.total.written,'no extra daily writes for pending duplicate classification');
 const evidence={fixture:'single synthetic member/Campaign; local workerd only',root:root.total,old_pending_match:historical.total,new_pending_duplicate:current.total,normal_approval:normal.cost,automatic_duplicate_review:duplicate.cost,upgrade:upgradeCost.map(r=>({read:r.meta.rows_read,written:r.meta.rows_written})),cloud_cpu:'UNKNOWN'};
 fs.mkdirSync('.wrangler',{recursive:true});fs.writeFileSync('.wrangler/pending-exact-cost.json',JSON.stringify(evidence,null,2));console.log('LOCAL_NATIVE_PENDING_EXACT_COST '+JSON.stringify(evidence));
});
