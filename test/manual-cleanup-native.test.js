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
test('cleanup list reads stay bounded with expired export history and still block unfinished packages',async t=>{
 const {local,identity,makeCase}=await localAdminRuntime();
 t.after(()=>local.runtime.dispose());
 const admin=await identity({role:'super_admin'});
 const stamp=new Date().toISOString(),old=new Date(Date.now()-86400000).toISOString();
 for(let n=0;n<12;n++)await makeCase();
 await local.db.prepare("UPDATE cases SET status='completed',reviewed_at=?,status_updated_at=?").bind(stamp,stamp).run();
 const files=(await local.db.prepare('SELECT id FROM case_files ORDER BY id').all()).results.map(row=>row.id);
 const expired=randomUUID(),active=randomUUID();
 const job=local.db.prepare(`INSERT INTO export_jobs(id,owner_member_id,created_at,expires_at,filters_json,from_utc,to_utc)
  VALUES(?,?,?,?,'{}',?,?)`);
 await local.db.batch([
  job.bind(expired,admin.memberId,old,old,old,stamp),
  job.bind(active,admin.memberId,stamp,'2099-01-01T00:00:00.000Z',old,stamp),
  local.db.prepare(`INSERT INTO export_completed_files(file_id,etag,file_size,content_type,job_id,package_no,confirmed_by,confirmed_at)
   SELECT id,etag,size,content_type,?,1,?,? FROM case_files`).bind(expired,admin.memberId,stamp),
  local.db.prepare(`INSERT INTO export_packages(job_id,number,image_count,total_bytes,status)
   VALUES(?,1,1,3,'planned'),(?,3,1,3,'completed')`).bind(active,active),
  local.db.prepare(`INSERT INTO export_job_items(job_id,ordinal,package_no,file_id,case_id,created_at,campaign_id,campaign_name,
   vote_type,source,review_status,review_stage,content_type,file_size,etag)
   SELECT ?,n,1,'historical-'||n,'synthetic',?,'synthetic','Synthetic','Solo','guest','completed','initial','image/png',3,'synthetic'
   FROM (WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<2000) SELECT n FROM seq)`).bind(expired,old),
  ...files.slice(0,3).map((id,n)=>local.db.prepare(`INSERT INTO export_job_items(job_id,ordinal,package_no,file_id,case_id,created_at,
   campaign_id,campaign_name,vote_type,source,review_status,review_stage,content_type,file_size,etag)
   VALUES(?,?,?,?,'synthetic',?,'synthetic','Synthetic','Solo','guest','completed','initial','image/png',3,'synthetic')`)
   .bind(active,n+1,n+1,id,stamp))
 ]);
 for(const path of ['migrations-storage-policy/0001_observe_capacity.sql','migrations-reset-v1/0001_reset_fence.sql']){
  await local.db.batch(unstable_splitSqlQuery(fs.readFileSync(path,'utf8')).map(sql=>local.db.prepare(sql)));
 }
 async function list(params){
  const measure=measuredD1(local.db);
  const result=await cleanupCandidates(measure.db,new URL(origin+'/api/admin/storage/manual?allow_early_export=1'+params));
  return {result,cost:measure.totals()};
 }
 const page=await list('&summary=0'),total=await list(''),filtered=await list('&eligible=no');
 t.diagnostic(JSON.stringify({page:page.cost,withTotals:total.cost,blockedWithTotals:filtered.cost}));
 assert.equal(total.result.total,12);
 assert.equal(total.result.eligible_count,10);
 assert.equal(total.result.eligible_bytes,30);
 assert.deepEqual(filtered.result.items.map(row=>row.file_id).sort(),files.slice(0,2));
 assert.equal(filtered.result.total,2);
 assert.equal(filtered.result.eligible_count,0);
 assert.equal(filtered.result.eligible_bytes,0);
 assert.deepEqual(page.result.items,total.result.items);
 assert.equal(page.result.total,undefined);
 assert.equal(page.cost.trips,1);
 assert.equal(total.cost.trips,2);
 for(const {cost} of [page,total,filtered]){
  assert.equal(cost.rows_written,0);
  assert.ok(cost.rows_read<1000,JSON.stringify(cost));
 }
});

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
 const historical=randomUUID(),stamp=new Date().toISOString();
 await local.db.prepare("INSERT INTO prelaunch_reset_operations(id,epoch,state,pending_r2,r2_writes,started_at) VALUES(?,1,'unknown',1,1,?)").bind(historical,stamp).run();
 await local.db.batch(unstable_splitSqlQuery(fs.readFileSync('migrations-manual-cleanup/0002_isolated_r2_scope.sql','utf8')).map(sql=>local.db.prepare(sql)));
 const preserved=await local.db.prepare('SELECT state,pending_r2,r2_writes,isolated_r2_key FROM prelaunch_reset_operations WHERE id=?').bind(historical).first();
 assert.deepEqual(preserved,{state:'unknown',pending_r2:1,r2_writes:1,isolated_r2_key:null});
 await local.db.prepare('UPDATE prelaunch_reset_control SET epoch=1 WHERE id=1').run();
 const isolatedKey='proofs/final/isolated/g1/'+randomUUID()+'/'+randomUUID()+'.png';
 const native=await fencedRequest({...env,PROOFS_BUCKET:local.bucket,R2_ISOLATED_PROOF_KEYS_ENABLED:'true'},request(),async scoped=>{
  assert.equal(scoped.PRELAUNCH_RESET_CONTEXT.isolatedProofs,true);
  const object=await scoped.PROOFS_BUCKET.put(isolatedKey,'synthetic', {onlyIf:new Headers({'If-None-Match':'*'})});
  return Response.json({version:object.version});
 });
 assert.ok((await native.json()).version);
 const scopedReceipt=await local.db.prepare('SELECT state,pending_r2,r2_writes FROM prelaunch_reset_operations WHERE isolated_r2_key=?').bind(isolatedKey).first();
 assert.deepEqual(scopedReceipt,{state:'completed',pending_r2:0,r2_writes:1});
 fs.mkdirSync('.wrangler',{recursive:true});fs.writeFileSync('.wrangler/manual-cleanup-native-cost.json',JSON.stringify({evidence:'local workerd D1 meta only; cloud CPU UNKNOWN',fixture:{cases:3,bytesPerImage:3},costs,r2:{head:heads,delete:deletes,get:gets}},null,2));
});
