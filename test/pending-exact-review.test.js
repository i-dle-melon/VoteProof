import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {exactFixture} from './helpers/exact-classification-fixture.mjs';
import {fencedRequest} from '../src/lib/prelaunch-reset-fence.js';
import {origin} from './helpers/embedded-case-runtime.mjs';
const upgrade=fs.readFileSync('migrations-exact-pending-classification/0001_pending_duplicate.sql','utf8');
globalThis.fetch=async url=>{assert.equal(String(url),'https://challenges.cloudflare.com/turnstile/v0/siteverify');return Response.json({success:true});};
const data=async r=>{const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b.data;};
const items=cases=>cases.map(c=>({case_id:c.data.case_id,expected_version:0}));
const batch=(f,cases)=>f.fetch('/api/admin/cases/batch-approve','POST',{cases:items(cases)},f.a.headers);
const withFence=(f,run)=>fencedRequest(f.env,new Request(origin+'/api/local-test',{method:'POST'}),async env=>{await run(env.DB);return Response.json({ok:true});});

test('pending original: second/third exact files link only to original; images, audit and idempotency retained',async t=>{
 const f=await exactFixture(t),original=await f.proof(),second=await f.proof(),third=await f.proof();
 for(const copy of[second,third]){
  assert.equal(copy.data.status,'duplicate');assert.equal(copy.data.exact_classification.decision,'exact_duplicate');
  assert.equal(f.read('SELECT c.case_id FROM cases d JOIN cases c ON c.id=d.duplicate_of_case_id WHERE d.case_id=?',copy.data.case_id).case_id,original.data.case_id);
  const replay=await f.create(copy.p,copy.key);assert.equal(replay.status,201);assert.deepEqual((await replay.json()).data,copy.data);
 }
 assert.equal(f.read('SELECT COUNT(*) n FROM cases').n,3);assert.equal(f.read('SELECT COUNT(*) n FROM case_files').n,3);
 assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,0);assert.equal(f.gets(),0);assert.equal(f.puts(),3);
 assert.equal((await data(await f.review(original,'approve'))).status,'approved');
 assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,1);
 assert.equal((await f.review(second,'approve')).status,409);
});

test('pending matches never cross member/Campaign/guest boundaries',async t=>{
 const f=await exactFixture(t);await f.proof();
 for(const[actor,campaign]of[[f.b,'A'],[f.a,'B'],[null,'A']]){
  const c=await f.proof(actor,campaign);assert.equal(c.data.status,'pending');
  assert.equal(c.data.exact_classification?.decision,actor?'clear':undefined);
 }
});

test('historical pending conflict: approve resolves duplicate with one audit, zero extra award; decision stays immutable',async t=>{
 const f=await exactFixture(t,{legacyWriter:true}),root=await f.proof(),copy=await f.proof();
 const prior=f.sqlite.prepare('SELECT * FROM case_sha256_decisions ORDER BY case_internal_id').all();
 await data(await f.review(root,'approve'));
 const result=await data(await f.review(copy,'approve'));assert.equal(result.status,'duplicate');assert.equal(result.review_outcome,'auto_duplicate');assert.equal(result.points_awarded,0);
 assert.equal(result.duplicate_of_case_id,root.data.case_id);
 const audit=f.read("SELECT action,after_json,reason FROM admin_audit_logs WHERE target_id=?",copy.data.case_id);
 assert.equal(audit.action,'mark_duplicate');assert.equal(JSON.parse(audit.after_json).requested_action,'approve');assert.equal(JSON.parse(audit.after_json).automatic_exact_review,1);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM case_sha256_decisions ORDER BY case_internal_id').all(),prior);
 assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,1);
 assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").n,0);
});

test('20 historical pending copies: five bounded batches resolve all; replay/status do not review or award twice',async t=>{
 const f=await exactFixture(t,{legacyWriter:true}),root=await f.proof(),copies=[];
 for(let n=0;n<20;n++)copies.push(await f.proof());await data(await f.review(root,'approve'));
 for(let i=0;i<20;i+=4){const chunk=copies.slice(i,i+4),r=await data(await batch(f,chunk));assert.equal(r.succeeded,4);assert.equal(r.failed,0);assert.ok(r.results.every(x=>x.status==='duplicate'&&x.outcome==='duplicate'));}
 const before=f.read('SELECT COUNT(*) n FROM admin_audit_logs').n;
 const replay=await data(await batch(f,copies.slice(0,4)));assert.ok(replay.results.every(x=>x.outcome==='already_duplicate'));
 const status=await data(await f.fetch('/api/admin/cases/batch-status?items='+encodeURIComponent(JSON.stringify(items(copies.slice(0,4)))),'GET',undefined,f.a.headers));assert.equal(status.succeeded,4);
 assert.equal(f.read('SELECT COUNT(*) n FROM admin_audit_logs').n,before);assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,1);
 assert.equal(f.read("SELECT COUNT(*) n FROM cases WHERE status='duplicate'").n,20);assert.equal(f.read('SELECT COUNT(*) n FROM case_files').n,21);
});

test('lost duplicate-review ACK reconciles authoritative audit once and never resubmits a write',async t=>{
 const f=await exactFixture(t,{legacyWriter:true}),root=await f.proof(),copy=await f.proof();await data(await f.review(root,'approve'));
 const db=f.env.DB;let commits=0;
 f.env.DB={...db,async batch(xs){const r=await db.batch(xs);if(xs.some(x=>x.sql.includes('automatic_exact_review'))){commits++;throw Error('LOCAL_ACK_LOST');}return r;}};
 const r=await data(await batch(f,[copy]));assert.equal(r.succeeded,1);assert.equal(r.results[0].outcome,'already_duplicate');assert.equal(commits,1);
 assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,1);
 assert.equal(f.read('SELECT COUNT(*) n FROM admin_audit_logs WHERE target_id=?',copy.data.case_id).n,1);
 assert.ok(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").n>=1,'lost ACK retains Fence UNKNOWN');
});

test('reference revoke/version race fails closed before duplicate write; no award or audit',async t=>{
 const f=await exactFixture(t,{legacyWriter:true}),root=await f.proof(),copy=await f.proof();await data(await f.review(root,'approve'));
 const db=f.env.DB;let raced=false;
 f.env.DB={...db,async batch(xs){if(!raced&&xs.some(x=>x.sql.includes('verified.id=?'))){raced=true;f.env.DB=db;await data(await f.review(root,'revoke',1));}return db.batch(xs);}};
 assert.equal((await f.review(copy,'approve')).status,409);assert.equal(raced,true);
 assert.equal(f.read('SELECT status,version FROM cases WHERE case_id=?',copy.data.case_id).status,'pending');
 assert.equal(f.read('SELECT COUNT(*) n FROM admin_audit_logs WHERE target_id=?',copy.data.case_id).n,0);
 assert.equal(f.read('SELECT SUM(points) total FROM point_transactions').total,0);
});

test('audit failure rolls back duplicate classification and preserves original ledger',async t=>{
 const f=await exactFixture(t,{legacyWriter:true}),root=await f.proof(),copy=await f.proof();await data(await f.review(root,'approve'));
 f.sqlite.exec("CREATE TRIGGER local_duplicate_audit_failure BEFORE INSERT ON admin_audit_logs WHEN NEW.action='mark_duplicate' BEGIN SELECT RAISE(ABORT,'LOCAL_AUDIT_FAILURE');END");
 assert.equal((await f.review(copy,'approve')).status,503);
 assert.equal(f.read('SELECT status FROM cases WHERE case_id=?',copy.data.case_id).status,'pending');assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,1);
});

test('stale CAS, bad CSRF and non-admin cannot auto-classify; manually classified duplicate is not approve replay',async t=>{
 const f=await exactFixture(t,{legacyWriter:true}),root=await f.proof(),copy=await f.proof();await data(await f.review(root,'approve'));
 assert.equal((await f.review(copy,'approve',1)).status,409);
 const path='/api/admin/cases/'+copy.data.case_id+'/review',body={action:'approve',expected_version:0};
 assert.equal((await f.fetch(path,'POST',body,{...f.a.headers,'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await f.fetch(path,'POST',body,f.b.headers)).status,403);
 await data(await f.fetch(path,'POST',{action:'mark_duplicate',reason:'Manual classification',expected_version:0,duplicate_of_case_id:root.data.case_id},f.a.headers));
 const r=await data(await batch(f,[copy]));assert.equal(r.succeeded,0);assert.equal(r.failed,1);assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,1);
});

test('historical approval resolution does not require the pending upgrade; old trigger still protects duplicates',async t=>{
 const f=await exactFixture(t,{pendingUpgrade:false,legacyWriter:true}),root=await f.proof(),copy=await f.proof();await data(await f.review(root,'approve'));
 assert.equal((await data(await f.review(copy,'approve'))).status,'duplicate');
});

test('new Runtime without new trigger fails closed on pending match; DDL failure restores original guard',async t=>{
 const f=await exactFixture(t,{pendingUpgrade:false}),root=await f.proof(),p=await f.prepare();await f.put(p);
 assert.equal((await f.create(p)).status,500);assert.equal(f.read('SELECT COUNT(*) n FROM cases').n,1);
 const before=f.read("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='case_sha_decision_insert'").sql;
 try{f.sqlite.exec('BEGIN;'+upgrade+'SELECT * FROM local_missing_table;COMMIT;');assert.fail('must rollback');}catch{f.sqlite.exec('ROLLBACK');}
 assert.equal(f.read("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='case_sha_decision_insert'").sql,before);
 assert.equal(f.read('PRAGMA foreign_key_check').table,undefined);assert.equal(root.data.status,'pending');
});

test('original rejection before creation excludes it atomically; no automatic promotion of prior duplicates',async t=>{
 const f=await exactFixture(t),root=await f.proof(),duplicate=await f.proof(),p=await f.prepare();await f.put(p);
 const db=f.env.DB;let raced=false;f.env.DB={...db,async batch(xs){if(!raced&&xs.some(x=>x.sql.includes('INSERT INTO case_sha256_decisions'))){raced=true;f.env.DB=db;await data(await f.review(root,'reject'));}return db.batch(xs);}};
 const r=await f.create(p);assert.equal(r.status,201);assert.equal((await r.json()).data.status,'pending');
 assert.equal(f.read('SELECT status FROM cases WHERE case_id=?',duplicate.data.case_id).status,'duplicate');assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,0);
});

test('OFF without extension does not query optional SHA tables or change normal approval',async t=>{
 const f=await exactFixture(t,{exact:false,install:false}),root=await f.proof(),db=f.env.DB,queries=[];
 f.env.DB={...db,prepare(sql){queries.push(sql);return db.prepare(sql);}};
 assert.equal((await data(await f.review(root,'approve'))).status,'approved');assert.ok(!queries.some(s=>s.includes('case_verified_sha256_sources')||s.includes('case_sha256_control')));
});
