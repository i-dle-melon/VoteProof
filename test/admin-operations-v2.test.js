import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {exportFilters,exportScope,countExport,snapshotExport} from '../src/lib/image-export.js';
import {backupInsert} from '../src/lib/proof-backup-store.js';
let h,a,b,member,rows=[];
const call=(path,method='GET',body,actor=a)=>h.local.fetch('/api/admin/'+path,method,body,actor?.headers??{});
async function data(r){assert.equal(r.status,200,await r.clone().text());return(await r.json()).data;}
const filters=extra=>({from:'2000-01-01T00:00',to:'2099-12-31T23:59',entire_campaign:false,campaign_id:null,
 statuses:['pending','approved','rejected','other'],vote_types:['Solo','團體'],sources:['member','guest'],...extra});
const create=(actor=a,f={})=>call('image-exports/jobs','POST',{job_id:randomUUID(),filters:filters(f)},actor).then(data);
const start=(j,actor=a,extra={})=>call(`image-exports/jobs/${j.id}/packages/1/start`,'POST',{
 attempt_id:randomUUID(),expected_attempt_id:j.packages[0].attempt_id,...extra},actor);
const state=(j,p,status='completed',actor=a)=>call(`image-exports/jobs/${j.id}/packages/1/state`,'POST',{attempt_id:p.attempt_id,status,...(status==='completed'?{confirmed:true}:{})},actor);
before(async()=>{
 h=await localAdminRuntime();a=await h.identity({role:'admin'});b=await h.identity({role:'reviewer'});member=await h.identity();
 await h.local.campaign({campaign_id:'V2',points_per_proof:10,daily_limit:null});
 for(let i=0;i<27;i++)rows.push(await h.makeCase({member,metadata:{campaign_id:'V2'}}));
 const files=(await h.local.db.prepare('SELECT id FROM case_files').all()).results;
 await h.local.db.batch(files.map(f=>backupInsert(h.local.db,f.id,Math.floor(Date.now()/1000))));
});
after(async()=>h?.local.runtime.dispose());
test('global overview counts every state beyond the first twenty, no sensitive case rows',async()=>{
 await data(await h.review(a,rows[20].case_id,'approve'));
 await data(await h.review(a,rows[21].case_id,'approve'));
 await data(await h.review(a,rows[21].case_id,'complete',1));
 await data(await h.review(a,rows[22].case_id,'reject',0,{reason:'Test'}));
 await data(await h.review(a,rows[23].case_id,'mark_duplicate',0,{reason:'Test',duplicate_of_case_id:rows[20].case_id}));
 await data(await h.review(a,rows[24].case_id,'approve'));await data(await h.review(a,rows[24].case_id,'revoke',1,{reason:'Test'}));
 const o=await data(await call('overview'));assert.deepEqual(o.case_totals,{pending:22,approved:2,rejected:2,revoked:1});
 assert.equal(o.case_counts.completed,1);assert.ok(o.member_count>=3);assert.equal(o.cases,undefined);
 const plan=(await h.local.db.prepare('EXPLAIN QUERY PLAN SELECT status,COUNT(*) FROM cases GROUP BY status').all()).results;
 assert.ok(plan.some(r=>/COVERING INDEX idx_cases_status/.test(r.detail)));
 const measured=await h.local.db.prepare('SELECT status,COUNT(*) count FROM cases GROUP BY status').all();
 console.log(JSON.stringify({local_cost_sample:'overview_statuses',fixture_cases:27,meta:measured.meta,plan:plan.map(r=>r.detail),cloudflare_cpu_ms:null}));
});
test('backup pending and missing are separate, metadata-only ten-row pages and RBAC',async()=>{
 const before=(await h.local.db.prepare('SELECT COUNT(*) n FROM proof_backups').first()).n;
 for(const page of [1,2,3]){
  const list=await data(await call('backups/jobs?status=pending&page='+page));assert.equal(list.page_size,10);assert.equal(list.total,before);
  assert.ok(list.files.length<=10);assert.ok(list.files.every(r=>r.status==='pending'&&r.case_id&&r.file_id&&r.created_at));
  assert.doesNotMatch(JSON.stringify(list),/object_key|etag|lease_token|drive_file_id|secret/);
 }
 const missing=await data(await call('backups/missing'));assert.equal(missing.total,0);
 assert.equal((await call('backups/jobs', 'GET',undefined,b)).status,403);
 for(const query of ['page=0','page=1&page=2','status=bad','status=pending&token=x'])assert.equal((await call('backups/jobs?'+query)).status,400);
 assert.equal((await h.local.db.prepare('SELECT COUNT(*) n FROM proof_backups').first()).n,before);
 const measured=await h.local.db.prepare("SELECT COUNT(*) total FROM proof_backups WHERE provider='google_drive' AND status='pending'").all();
 console.log(JSON.stringify({local_cost_sample:'backup_pending_count',fixture_jobs:before,meta:measured.meta,cloudflare_cpu_ms:null}));
});
test('initial review pages exclude detailed/risk/new/changed cases and remain stable after approvals',async()=>{
 await data(await h.review(a,rows[0].case_id,'flag_detailed',0,{review_risk_reason:'manual_flag'}));
 const plan=await data(await call('cases/initial-review'));assert.equal(plan.total,21);
 const queryPlan=(await h.local.db.prepare("EXPLAIN QUERY PLAN SELECT case_id,version,created_at,id FROM cases WHERE status='pending' AND review_stage='initial' AND review_risk_reason IS NULL AND created_at<=? AND updated_at<=? ORDER BY created_at,id LIMIT 21").bind(plan.cutoff,plan.cutoff).all()).results;
 // SQLite may prefer the existing status index for this tiny fixture. Do not
 // force a new index or hide a real scan just to pin the optimizer's choice.
 assert.ok(queryPlan.some(r=>/USING.*INDEX idx_cases_/.test(r.detail)));
 assert.ok(await h.local.db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_cases_initial_review'").first());
 const page=await data(await call('cases/initial-review?'+new URLSearchParams({cutoff:plan.cutoff})));assert.equal(page.cases.length,20);assert.ok(page.next_cursor);
 const fresh=await h.makeCase({member,metadata:{campaign_id:'V2'}});
 const chunk=page.cases.slice(0,4);const response=await data(await call('cases/batch-approve','POST',{cases:chunk}));assert.equal(response.succeeded,4);
 const next=await data(await call('cases/initial-review?'+new URLSearchParams({cutoff:plan.cutoff,cursor:page.next_cursor})));
 assert.equal(next.cases.length,1);assert.ok(!next.cases.some(c=>c.case_id===fresh.case_id));
 assert.equal((await call('cases/batch-approve','POST',{cases:[...chunk,chunk[0]]})).status,400);
 const balance=(await h.local.db.prepare('SELECT SUM(points) n FROM point_transactions WHERE member_id=?').bind(member.memberId).first()).n;
 const replays=await Promise.all([call('cases/batch-approve','POST',{cases:chunk}),call('cases/batch-approve','POST',{cases:chunk},b)]);
 for(const r of replays)assert.equal((await data(r)).succeeded,4);
 assert.equal((await h.local.db.prepare('SELECT SUM(points) n FROM point_transactions WHERE member_id=?').bind(member.memberId).first()).n,balance);
 const ack=await data(await call('cases/batch-status?items='+encodeURIComponent(JSON.stringify(chunk))));assert.equal(ack.succeeded,4);
 const partial=await data(await call('cases/batch-approve','POST',{cases:[{case_id:rows[0].case_id,expected_version:1},next.cases[0]]}));
 assert.equal(partial.failed,1);assert.equal(partial.succeeded,1);assert.equal(partial.results[0].code,'DETAILED_REVIEW_REQUIRED');
});
test('batch mutations keep CSRF/MFA and state/version checks',async()=>{
 const input={cases:[{case_id:rows[25].case_id,expected_version:99}]};
 assert.equal((await data(await call('cases/batch-approve','POST',input))).failed,1);
 assert.equal((await call('cases/batch-approve','POST',input,{headers:{...a.headers,'X-CSRF-Token':'bad'}})).status,403);
 const weak=await h.identity({role:'admin',elevated:false});assert.equal((await call('cases/initial-review','GET',undefined,weak)).status,403);
 assert.equal((await call('cases/batch-status?items=x')).status,400);
});
test('same scope concurrent administrators share one immutable snapshot and global history',async()=>{
 const jobs=await Promise.all([create(a),create(b)]);assert.equal(jobs[0].id,jobs[1].id);
 const j=await data(await call('image-exports/jobs/'+jobs[0].id,'GET',undefined,b));assert.ok(j.creator_fan_id);
 assert.equal(j.image_count,28);assert.ok(j.creator_name);assert.ok((await data(await call('image-exports','GET',undefined,b))).jobs.some(r=>r.id===j.id));
 assert.equal((await call('image-exports/jobs/'+j.id,'GET',undefined,member)).status,403);
 const pkg=await data(await start(j,a));
 assert.equal((await start(j,b,{expected_attempt_id:pkg.package.attempt_id})).status,409);
 assert.equal((await state(j,pkg.package,'completed',b)).status,409);
 const path=`image-exports/jobs/${j.id}/packages/1/attempts/${pkg.package.attempt_id}/files/${pkg.items[0].file_id}`;
 assert.equal((await call(path,'GET',undefined,b)).status,409);assert.equal((await call(path)).status,200);
 await data(await state(j,pkg.package,'failed'));assert.equal((await h.local.db.prepare('SELECT COUNT(*) n FROM export_completed_files').first()).n,0);
 const retried=await data(await start(j,b,{expected_attempt_id:pkg.package.attempt_id}));await data(await state(j,retried.package,'completed',b));
 const n=(await h.local.db.prepare('SELECT COUNT(*) n FROM export_completed_files').first()).n;assert.equal(n,28);
 await data(await state(j,retried.package,'completed',b));assert.equal((await h.local.db.prepare('SELECT COUNT(*) n FROM export_completed_files').first()).n,n);
 const empty=await data(await call('image-exports/query','POST',filters({only_undownloaded:true})));assert.equal(empty.image_count,0);
 const again=await data(await start({...j,packages:[{...retried.package,status:'completed'}]},a,{expected_attempt_id:retried.package.attempt_id}));assert.equal(again.read_only,true);
 assert.equal((await start({...j,packages:[{...retried.package,status:'completed'}]},b,{expected_attempt_id:retried.package.attempt_id})).status,409);
 await data(await state(j,{attempt_id:again.download_attempt_id},'completed',a));
 assert.equal((await data(await call('image-exports/query','POST',filters()))).image_count,28);
 const audit=(await h.local.db.prepare('SELECT DISTINCT member_id FROM export_operation_audit').all()).results;
 assert.ok(audit.some(r=>r.member_id===a.memberId)&&audit.some(r=>r.member_id===b.memberId));
 await assert.rejects(h.local.db.prepare('DELETE FROM export_completed_files').run());await assert.rejects(h.local.db.prepare('UPDATE export_operation_audit SET action=action').run());
});
test('expired claims recover and stale ACK cannot complete a newer attempt',async()=>{
 const j=await create(a,{statuses:['pending']});const first=await data(await start(j));
 await h.local.db.batch([h.local.db.prepare('UPDATE export_packages SET lease_until=0 WHERE job_id=?').bind(j.id),h.local.db.prepare('UPDATE export_file_claims SET lease_until=0 WHERE job_id=?').bind(j.id)]);
 const second=await data(await start(j,b,{expected_attempt_id:first.package.attempt_id}));
 assert.equal((await state(j,first.package)).status,409);
 await data(await state(j,second.package,'failed',b));
 assert.equal((await h.local.db.prepare('SELECT COUNT(*) n FROM export_file_claims WHERE job_id=?').bind(j.id).first()).n,0);
});
test('explicit completion and its file/audit records commit together; overlapping scopes cannot double-claim',async()=>{
 await h.makeCase({member,metadata:{campaign_id:'V2'}});
 const j=await create(a,{only_undownloaded:true}),s=await data(await start(j));assert.equal(j.image_count,1);
 const overlap=await create(b,{only_undownloaded:true,package_bytes:64*1024*1024});assert.equal((await start(overlap,b)).status,409);
 const naked=await h.local.fetch(`/api/admin/image-exports/jobs/${j.id}/packages/1/state`,'POST',{attempt_id:s.package.attempt_id,status:'completed'},a.headers);assert.equal(naked.status,400);
 const before=(await h.local.db.prepare('SELECT COUNT(*) n FROM export_completed_files').first()).n;
 await h.local.db.prepare("CREATE TRIGGER v2_synthetic_audit_failure BEFORE INSERT ON export_operation_audit WHEN NEW.action='completed' BEGIN SELECT RAISE(ABORT,'Synthetic audit failure'); END").run();
 assert.equal((await state(j,s.package)).status,409);
 assert.equal((await h.local.db.prepare('SELECT COUNT(*) n FROM export_completed_files').first()).n,before);
 assert.equal((await h.local.db.prepare('SELECT status FROM export_packages WHERE job_id=?').bind(j.id).first()).status,'in_progress');
 await h.local.db.prepare('DROP TRIGGER v2_synthetic_audit_failure').run();await data(await state(j,s.package));
 assert.equal((await h.local.db.prepare('SELECT COUNT(*) n FROM export_completed_files').first()).n,before+1);
});
test('inclusive end minute preserves half-open UTC, leap day/month/year and exact campaign boundaries',async()=>{
 for(const [date,to] of [['2026-12-31','2026-12-31T16:00:00.000Z'],['2026-10-31','2026-10-31T16:00:00.000Z'],['2028-02-29','2028-02-29T16:00:00.000Z']]){
  const scoped=await exportScope(h.local.db,exportFilters(filters({from:date+'T00:00',to:date+'T23:59',end_inclusive:true})));
  assert.equal(scoped.to_utc,to);
 }
 const f=exportFilters(filters({from:'2026-10-22T12:34',to:'2026-10-22T12:34',end_inclusive:true}));
 assert.equal((await exportScope(h.local.db,f)).to_utc,'2026-10-22T04:35:00.000Z');
 const scope=await exportScope(h.local.db,exportFilters(filters({entire_campaign:true,campaign_id:'V2',end_inclusive:true})));
 assert.equal(scope.to_utc,'2100-01-01T00:00:00.000Z');
 assert.throws(()=>exportFilters(filters({from:'2026-02-30T00:00',end_inclusive:true})));
});
test('0027 compatibility, additive migration preserves rows and backfills only completed snapshots',async()=>{
 const old=await localAdminRuntime({migrationThrough:'0027_storage_inventory_phases.sql'});
 try{
  const actor=await old.identity({role:'admin'});const before=(await old.local.db.prepare('SELECT * FROM members').all()).results;
  const r=await old.local.fetch('/api/admin/image-exports','GET',undefined,actor.headers);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'EXPORT_SCHEMA_NOT_READY');
  const exportJobs=(await old.local.db.prepare('SELECT * FROM export_jobs').all()).results;
  const blocked=await old.local.fetch('/api/admin/image-exports/jobs','POST',{job_id:randomUUID(),filters:filters()},actor.headers);
  assert.equal(blocked.status,503);assert.equal((await blocked.json()).error.code,'EXPORT_SCHEMA_NOT_READY');
  assert.deepEqual((await old.local.db.prepare('SELECT * FROM export_jobs').all()).results,exportJobs);
  // Only shared export is unavailable before 0028; essential Admin reads remain
  // available. A migration readiness failure is never a successful empty export.
  for(const path of ['me','overview','cases'])assert.equal((await old.local.fetch('/api/admin/'+path,'GET',undefined,actor.headers)).status,200);
  await old.makeCase();const oldActor={member:{member_id:actor.memberId,tokenHash:actor.hash},role:'admin'},scope=await exportScope(old.local.db,exportFilters(filters()));
  const completeId=randomUUID(),failedId=randomUUID();
  for(const id of [completeId,failedId])await snapshotExport(old.local.db,oldActor,id,scope);
  await old.local.db.prepare("UPDATE export_packages SET status='completed',completed_at=?,attempt_id=? WHERE job_id=?").bind(new Date().toISOString(),randomUUID(),completeId).run();
  await old.local.db.prepare("UPDATE export_packages SET status='failed' WHERE job_id=?").bind(failedId).run();
  const oldCases=(await old.local.db.prepare('SELECT * FROM cases').all()).results,oldFiles=(await old.local.db.prepare('SELECT * FROM case_files').all()).results;
  const sql=await readFile(new URL('../migrations/0028_admin_operations_v2.sql',import.meta.url),'utf8');
  await old.local.db.batch(unstable_splitSqlQuery(sql).map(s=>old.local.db.prepare(s)));
  assert.deepEqual((await old.local.db.prepare('SELECT * FROM members').all()).results,before);
  assert.deepEqual((await old.local.db.prepare('SELECT * FROM cases').all()).results,oldCases);assert.deepEqual((await old.local.db.prepare('SELECT * FROM case_files').all()).results,oldFiles);
  const completed=(await old.local.db.prepare('SELECT * FROM export_completed_files').all()).results;assert.equal(completed.length,1);assert.equal(completed[0].job_id,completeId);
  assert.equal((await old.local.fetch('/api/admin/image-exports','GET',undefined,actor.headers)).status,200);
  assert.deepEqual((await old.local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await old.local.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
 }finally{await old.local.runtime.dispose();}
});
