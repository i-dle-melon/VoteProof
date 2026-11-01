// Disposable workerd D1/R2 only. Native local D1 metadata, not cloud CPU evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {unstable_splitSqlQuery} from 'wrangler';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {measuredD1} from '../scripts/lib/measured-d1.mjs';
import {RESET_V1_SQL_SHA256} from '../src/lib/prelaunch-reset-schema.js';
import {fencedRequest} from '../src/lib/prelaunch-reset-fence.js';
import {adminIdentity} from '../src/lib/admin-identity.js';
import {cleanupCandidates,cleanCleanup} from '../src/lib/manual-r2-cleanup.js';
import {batchReject,batchApprove} from '../src/lib/review-batch.js';
import {saveSystemPresentation} from '../src/lib/system-leaderboards.js';
import {backupInsert} from '../src/lib/proof-backup-store.js';
const origin='https://voteproof.example';
test('native local D1 extensions, manual cleanup and review costs preserve real guards and FK',async t=>{
 const h=await localAdminRuntime(),local=h.local;t.after(()=>local.runtime.dispose());
 const admin=await h.identity({role:'super_admin'}),member=await h.identity(),cases=[];
 for(let n=0;n<3;n++)cases.push(await h.makeCase({member}));
 assert.equal((await h.review(admin,cases[0].case_id,'approve')).status,200);
 assert.equal((await h.review(admin,cases[0].case_id,'complete',1)).status,200);
 const file=await local.db.prepare('SELECT * FROM case_files WHERE case_id=?').bind(cases[0].id).first(),old=new Date(Date.now()-86400000*8).toISOString();
 await backupInsert(local.db,file.id,Math.floor(Date.now()/1000)).run();
 await local.db.batch([
  local.db.prepare('UPDATE cases SET reviewed_at=?,status_updated_at=? WHERE id=?').bind(old,old,cases[0].id),
  local.db.prepare("INSERT INTO drive_backup_folders VALUES('root','campaign-key','campaign-folder','root','test',1)"),
  local.db.prepare("INSERT INTO drive_backup_folders VALUES('root','date-key','date-folder','campaign-folder','test',1)"),
  local.db.prepare("UPDATE proof_backups SET status='confirmed',root_folder_id='root',drive_file_id='drive-file',drive_folder_id='date-folder',lease_until=NULL,completed_at=1 WHERE file_id=?").bind(file.id)
 ]);
 for(const path of['migrations-storage-policy/0001_observe_capacity.sql','migrations-reset-v1/0001_reset_fence.sql'])await local.db.batch(unstable_splitSqlQuery(fs.readFileSync(path,'utf8')).map(sql=>local.db.prepare(sql)));
 await local.db.batch([local.db.prepare('INSERT INTO prelaunch_reset_schema_versions VALUES(1,?,?)').bind(RESET_V1_SQL_SHA256,new Date().toISOString()),local.db.prepare("UPDATE prelaunch_reset_control SET mode='open'")]);
 const installation=measuredD1(local.db);
 for(const path of['migrations-manual-cleanup/0001_manual_guards.sql','migrations-admin-presentation/0001_leaderboard_presentation.sql'])await installation.db.batch(unstable_splitSqlQuery(fs.readFileSync(path,'utf8')).map(sql=>installation.db.prepare(sql)));
 const env={...local.authConfig,DB:local.db,PROOFS_BUCKET:local.bucket,PRELAUNCH_RESET_FENCE_ENABLED:'true',R2_MANUAL_CLEANUP_ENABLED:'true',R2_EXCLUSIVE_WRITER_CONFIRMED:'true'};
 const actor=await adminIdentity(new Request(origin,{headers:admin.headers}),env,['super_admin']);
 const costs={installation:installation.totals()};
 async function measure(name,operation){const m=measuredD1(local.db),value=await operation({...env,DB:m.db});costs[name]=m.totals();assert.ok(m.samples.every(s=>Number.isFinite(s.rows_read)&&Number.isFinite(s.rows_written)));return value;}
 const request=()=>new Request(origin+'/api/local-synthetic-operation',{method:'POST'});
 const scoped=(e,fn)=>fencedRequest(e,request(),async x=>Response.json(await fn(x)));
 const items=await measure('candidate_list',e=>cleanupCandidates(e.DB,new URL(origin+'/api/admin/storage/manual'))),candidate=items.items.find(x=>x.file_id===file.id);assert.equal(candidate.eligible,true,JSON.stringify(candidate));assert.equal(costs.candidate_list.rows_written,0);
 const input={file_id:file.id,case_version:2,backup_version:0,attempt_id:randomUUID()};
 let heads=0,deletes=0,gets=0;
 const bucket={head:async k=>{heads++;return local.bucket.head(k);},delete:async k=>{deletes++;return local.bucket.delete(k);},get:async k=>{gets++;return local.bucket.get(k);}};env.PROOFS_BUCKET=bucket;
 const before=(await local.db.prepare('SELECT * FROM point_transactions').all()).results;
 const d=await measure('clean_one',e=>scoped(e,x=>cleanCleanup(x,actor,input,{verify:async(_env,_row,sha)=>({sha256:sha,verified_at:Math.floor(Date.now()/1000),receipt:{synthetic:true}})})));assert.equal((await d.json()).state,'deleted');assert.equal(heads,4);assert.equal(deletes,1);assert.equal(gets,0);
 assert.deepEqual((await local.db.prepare('SELECT * FROM point_transactions').all()).results,before);assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,3);
 await assert.rejects(local.db.prepare('UPDATE cold_proofs SET state=\'verifying\' WHERE file_id=?').bind(file.id).run(),/MANUAL_CLEANUP_OWNER_REQUIRED/);
 await assert.rejects(local.db.prepare("UPDATE proof_backups SET version=version+1 WHERE file_id=?").bind(file.id).run(),/PINNED/);
 const rejected=await measure('reject_one',e=>scoped(e,x=>batchReject(x.DB,actor,[{case_id:cases[1].case_id,expected_version:0}],'Synthetic reason')));assert.equal((await rejected.json()).succeeded,1);
 const approved=await measure('approve_one',e=>scoped(e,x=>batchApprove(x.DB,actor,[{case_id:cases[2].case_id,expected_version:0}])));assert.equal((await approved.json()).succeeded,1);
 await measure('fixed_presentation',e=>scoped(e,x=>saveSystemPresentation(x.DB,actor,'system-history',{expected_version:0,name:'歷史累計',top_n:20,is_public:true})));
 assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM prelaunch_reset_permit').first()).n,0);
 fs.mkdirSync('.wrangler',{recursive:true});fs.writeFileSync('.wrangler/manual-cleanup-native-cost.json',JSON.stringify({evidence:'local workerd D1 meta only; cloud CPU UNKNOWN',fixture:{cases:3,bytesPerImage:3},costs,r2:{head:heads,delete:deletes,get:gets}},null,2));
});
