import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{createHash,randomBytes,randomUUID}from'node:crypto';
import{unstable_splitSqlQuery}from'wrangler';import{localAdminRuntime}from'../scripts/lib/local-admin-runtime.mjs';

test('local native workerd/D1/R2: conditional admission, changes(), atomic pin rollback and read-only health',async t=>{
 const h=await localAdminRuntime({directIntent:true});t.after(()=>h.local.runtime.dispose());const l=h.local,actor=await h.identity({role:'admin'}),relay=randomBytes(32).toString('hex');
 let db=l.db;await db.prepare("UPDATE storage_capacity SET inventory_id=?,inventory_phase='scan',trusted_until=0").bind(randomUUID()).run();
 await db.batch(unstable_splitSqlQuery(fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8')).map(sql=>db.prepare(sql)));
 await db.prepare('INSERT INTO prelaunch_reset_schema_versions VALUES(1,?,?)').bind('19054e1e954a03456b7e93052cc3f051f79817380828f35f607ebb5231e04cbe',new Date().toISOString()).run();
 await db.prepare("UPDATE prelaunch_reset_control SET epoch=1,mode='open'").run();
 await l.setAuthConfig({PRELAUNCH_RESET_FENCE_ENABLED:'true',R2_EXCLUSIVE_WRITER_CONFIRMED:'true',GOOGLE_DRIVE_BACKUP_ENABLED:'true',DRIVE_BACKUP_RELAY_SECRET:relay});db=l.db;
 const image=new Uint8Array([1,2,3]),headers={Origin:'https://voteproof.example'};
 const prepare=async()=>{const r=await l.fetch('/api/uploads/prepare','POST',{campaign_id:'LOCAL-TEST',storage_version:2,completion_mode:'direct',turnstile_token:'synthetic',files:[{name:'synthetic.png',type:'image/png',size:3,algorithm:'sha256',sha256:createHash('sha256').update(image).digest('hex')}]},headers);assert.equal(r.status,200,await r.clone().text());return(await r.json()).data;};
 const put=p=>l.runtime.dispatchFetch(p.uploads[0].upload_url,{method:'PUT',headers:{...p.uploads[0].headers,...headers,'Content-Length':'3'},body:image});
 const count=async(sql)=>(await db.prepare(sql).first()).n;
 const p=await prepare();const denied=await put(p);assert.equal(denied.status,503,await denied.clone().text());
 assert.equal(denied.headers.get('X-VoteProof-Upload-Stage'),'capacity_admission');assert.equal(denied.headers.get('X-VoteProof-Put-State'),'not_started');assert.equal(denied.headers.get('X-VoteProof-Upload-Rejected'),'1');
 assert.equal(await count('SELECT COUNT(*) n FROM proof_upload_intents WHERE write_token IS NOT NULL'),0);
 assert.equal(await count("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'"),0);
 assert.equal(await count("SELECT COUNT(*) n FROM storage_reservations WHERE state='reserved'"),0);assert.equal(await l.bucket.head(p.uploads[0].key),null);
 const relayHeaders={Authorization:'Bearer '+relay,'X-VoteProof-Reset-Epoch':'1'};
 const scan=await l.fetch('/api/internal/drive-backup/storage/tick','POST',{inventory_only:true},relayHeaders);assert.equal(scan.status,200,await scan.clone().text());
 const s=(await scan.json()).data.inventory;assert.equal(s.phase,'finalize');
 const final=await l.fetch('/api/internal/drive-backup/storage/inventory/finalize','POST',{inventory_id:s.inventory_id,inventory_version:s.inventory_version},relayHeaders);assert.equal(final.status,200,await final.clone().text());
 const uploaded=await put(p);assert.equal(uploaded.status,200,await uploaded.clone().text());assert.ok(await l.bucket.head(p.uploads[0].key));
 assert.equal(await count('SELECT COUNT(*) n FROM proof_upload_intents WHERE write_token IS NOT NULL'),0);
 const before=await count('SELECT COUNT(*) n FROM prelaunch_reset_operations');
 for(const path of ['/api/admin/health-monitor/summary','/api/admin/health-monitor/events']){const r=await l.fetch(path,'GET',undefined,actor.headers);assert.equal(r.status,200,await r.clone().text());}
 assert.equal(await count('SELECT COUNT(*) n FROM prelaunch_reset_operations'),before);
 const rejected=await prepare();await db.prepare("CREATE TRIGGER local_native_admission_fault BEFORE INSERT ON storage_reservations BEGIN SELECT RAISE(ABORT,'synthetic native admission fault');END").run();
 const failed=await put(rejected);assert.equal(failed.status,502);assert.equal(failed.headers.get('X-VoteProof-Upload-Stage'),'capacity_admission');assert.equal(failed.headers.get('X-VoteProof-Put-State'),'not_started');
 assert.equal(await count('SELECT COUNT(*) n FROM proof_upload_intents WHERE write_token IS NOT NULL'),0);assert.equal(await count("SELECT COUNT(*) n FROM storage_reservations WHERE state='reserved'"),0);
 assert.equal(await count("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'"),1);assert.equal(await l.bucket.head(rejected.uploads[0].key),null);
 assert.equal(l.unexpectedUpstreams.length,0);
 console.log(JSON.stringify({platform:'LOCAL workerd/D1/R2',atomic_admission:'PASS',trigger_rollback:'PASS',health_control_rows_added:0,cloud_native_cpu_ms:'UNKNOWN',production_requests:0}));
});
