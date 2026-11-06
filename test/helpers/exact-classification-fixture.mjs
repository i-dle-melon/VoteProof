// Network-free Worker/SQLite fixture; synthetic R2 and Turnstile only.
import fs from 'node:fs';import{createHash,randomUUID}from'node:crypto';
import{embeddedCaseRuntime,origin,image}from'./embedded-case-runtime.mjs';
import{installResetExtensionLocal}from'../../scripts/lib/prelaunch-selective-reset.mjs';
import{fencedRequest}from'../../src/lib/prelaunch-reset-fence.js';
import{memberSession,csrfToken}from'../../src/lib/auth-session.js';
import worker from'../../src/index.js';import assert from'node:assert/strict';
const sha=createHash('sha256').update(image).digest('hex');
export async function exactFixture(t,{exact=true,install=true,observe=true,pendingUpgrade=true,legacyWriter=false}={}){
 const f=await embeddedCaseRuntime();t.after(()=>f.close());const a=await f.identity('admin'),b=await f.identity();f.sqlite.exec('UPDATE submission_settings SET submissions_enabled=1');
 const now=new Date().toISOString();for(const campaign of['A','B'])f.sqlite.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at) VALUES(?,?,'團體','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','Asia/Taipei','2000-01-01','2099-12-31',3,'active',?,?)").run(campaign,campaign,now,now);
 f.sqlite.exec('BEGIN;'+fs.readFileSync('migrations-storage-policy/0001_observe_capacity.sql','utf8')+'COMMIT;');if(observe)f.sqlite.exec("UPDATE storage_capacity SET upload_policy='observe',trusted_until=0");
 installResetExtensionLocal(f.sqlite,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));f.sqlite.exec("UPDATE prelaunch_reset_control SET epoch=1,mode='open'");
 if(install)f.sqlite.exec('BEGIN;'+fs.readFileSync('migrations-exact-classification/0001_case_sha256.sql','utf8')+'COMMIT;');
 if(install&&pendingUpgrade)f.sqlite.exec('BEGIN;'+fs.readFileSync('migrations-exact-pending-classification/0001_pending_duplicate.sql','utf8')+'COMMIT;');
 Object.assign(f.env,{PRELAUNCH_RESET_FENCE_ENABLED:'true',...(observe?{STORAGE_CAPACITY_ENFORCEMENT:'disabled'}:{}),...(exact?{EXACT_DUPLICATE_CLASSIFICATION_ENABLED:'true'}:{})});
 if(exact&&install)await fencedRequest(f.env,new Request(origin+'/api/local-policy-fixture',{method:'POST'}),async env=>{await env.DB.prepare('UPDATE case_sha256_control SET enabled=1,version=version+1 WHERE id=1 AND version=0').run();return Response.json({ok:true});});
 for(const x of[a,b]){const m=await memberSession(new Request(origin,{headers:x.headers}),f.env);x.headers['X-CSRF-Token']=await csrfToken(m,{...f.env,PRELAUNCH_RESET_CONTEXT:{epoch:1}});}
 if(legacyWriter){const db=f.env.DB;f.env.DB={...db,prepare(sql){return db.prepare(sql.includes('INSERT INTO case_sha256_decisions')?sql.replace("m.status IN('approved','completed','pending') THEN 'exact_duplicate'","m.status IN('approved','completed') THEN 'exact_duplicate' WHEN m.status='pending' THEN 'pending_match'"):sql);}};}
 let puts=0,gets=0;const rawPut=f.bucket.put,rawGet=f.bucket.get;f.bucket.put=async(...args)=>{puts++;return rawPut(...args);};f.bucket.get=async(...args)=>{gets++;return rawGet(...args);};
 const read=(sql,...v)=>({...f.sqlite.prepare(sql).get(...v)});
 async function prepare(actor=a,campaign='A',mode='direct'){const headers=actor?.headers??{Origin:origin},r=await f.fetch('/api/uploads/prepare','POST',{storage_version:2,campaign_id:campaign,...(mode==='direct'?{completion_mode:'direct'}:{}),turnstile_token:'synthetic',files:[{name:'x.png',type:'image/png',size:image.length,algorithm:'sha256',sha256:sha}]},headers);assert.equal(r.status,200,await r.clone().text());return{...(await r.json()).data,headers,campaign};}
 const put=p=>worker.fetch(new Request(p.uploads[0].upload_url,{method:'PUT',headers:{...p.headers,...p.uploads[0].headers,'Content-Length':String(image.length)},body:image}),f.env);
 const body=p=>({campaign_id:p.campaign,vote_date:new Date().toISOString().slice(0,10),upload_session:{session_id:p.session_id,keys:[p.uploads[0].key],...(p.capability?{capability:p.capability}:{})}});
 const create=(p,key=randomUUID())=>f.fetch('/api/cases/direct','POST',body(p),{...p.headers,'Idempotency-Key':key});
 async function proof(actor=a,campaign='A'){const p=await prepare(actor,campaign);assert.equal((await put(p)).status,200);const key=randomUUID(),r=await create(p,key),data=await r.json();assert.equal(r.status,201,JSON.stringify(data));return{p,key,data:data.data};}
 const review=(c,action,version=0)=>f.fetch('/api/admin/cases/'+c.data.case_id+'/review','POST',{action,expected_version:version,...(['revoke','reject'].includes(action)?{reason:'Synthetic '+action}:{})},a.headers);
 return{...f,a,b,read,prepare,put,create,proof,review,puts:()=>puts,gets:()=>gets};
}