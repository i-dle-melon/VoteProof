import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {batchApprove,batchReviewInput,REVIEW_BATCH_LIMIT} from '../src/lib/review-batch.js';
let h,local,admin,reviewer,member;
before(async()=>{h=await localAdminRuntime();local=h.local;admin=await h.identity({role:'super_admin'});reviewer=await h.identity({role:'reviewer'});member=await h.identity();await local.campaign({campaign_id:'WORKFLOW',points_per_proof:10,daily_limit:null});});
after(async()=>{await local?.runtime.dispose();});
const proof=()=>h.makeCase({member,metadata:{campaign_id:'WORKFLOW'}});
const items=cases=>cases.map(c=>({case_id:c.case_id,expected_version:0}));
const batch=(cases,actor=reviewer)=>local.fetch('/api/admin/cases/batch-approve','POST',{cases},actor.headers);
async function data(r){const j=await r.json();assert.equal(j.ok,true,JSON.stringify(j));return j.data;}
const row=id=>local.db.prepare('SELECT * FROM cases WHERE case_id=?').bind(id).first();
const awards=id=>local.db.prepare("SELECT COUNT(*) n FROM point_transactions t JOIN cases c ON c.id=t.case_id WHERE c.case_id=? AND category='proof_approved'").bind(id).first();
test('batch validation accepts only exact distinct IDs/versions; no filter-based mass approval',()=>{
 assert.equal(REVIEW_BATCH_LIMIT,4);
 const id='VP-20261014-'+ 'A'.repeat(16);
 for(const value of [null,0,'case',[],{case_id:42,expected_version:0}])assert.throws(()=>batchReviewInput({cases:[value]}),e=>e.code==='INVALID_REVIEW_BATCH');
 for(const body of [{status:'pending'},{cases:[]},{cases:[{case_id:id,expected_version:0}],campaign_id:'WORKFLOW'},{cases:Array(5).fill({case_id:id,expected_version:0})},{cases:[{case_id:id,expected_version:0},{case_id:id,expected_version:0}]},{cases:[{case_id:'*',expected_version:0}]}])assert.throws(()=>batchReviewInput(body),e=>e.code==='INVALID_REVIEW_BATCH');
});
test('partial batch success uses independent transactions and awards only successful approved cases',async()=>{
 const a=await proof(),b=await proof(),c=await proof();
 await data(await h.review(reviewer,b.case_id,'flag_detailed',0,{review_risk_reason:'manual_flag'}));
 const unknown='VP-20261014-'+ 'Z'.repeat(16),result=await data(await batch([...items([a,b,c]),{case_id:unknown,expected_version:0}]));
 assert.equal(result.succeeded,2);assert.equal(result.failed,2);
 assert.equal(result.results.find(r=>r.case_id===b.case_id).code,'DETAILED_REVIEW_REQUIRED');
 assert.equal(result.results.find(r=>r.case_id===unknown).code,'CASE_NOT_FOUND');
 for(const id of [a.case_id,c.case_id]){assert.equal((await row(id)).points_awarded,10);assert.equal((await awards(id)).n,1);}
 assert.equal((await row(b.case_id)).status,'pending');assert.equal((await awards(b.case_id)).n,0);
});
test('concurrent batch retries and lost response never award twice',async()=>{
 const cases=[await proof(),await proof()],responses=await Promise.all([batch(items(cases)),batch(items(cases))]);
 for(const r of responses)assert.equal((await data(r)).succeeded,2);
 const replay=await data(await batch(items(cases)));assert.ok(replay.results.every(r=>r.outcome==='already_approved'));
 for(const c of cases)assert.equal((await awards(c.case_id)).n,1);
 const pending=await proof(),statements=new Map();let lost=false;
 const db={prepare(sql){const st=local.db.prepare(sql);statements.set(st,sql);return st;},async batch(list){const result=await local.db.batch(list);if(!lost){lost=true;throw Error('Acknowledgement lost');}return result;}};
 const resolved=await batchApprove(db,{member:{member_id:reviewer.memberId,tokenHash:reviewer.hash},role:'reviewer'},items([pending]));
 assert.equal(resolved.succeeded,1);assert.equal(resolved.results[0].outcome,'already_approved');assert.equal((await awards(pending.case_id)).n,1);
});
test('generic detailed reasons route pending cases without rejection or points; detailed approval is explicit',async()=>{
 for(const reason of ['manual_flag','exact_duplicate','auto_check_failed','other']){
  const c=await proof();const flagged=await data(await h.review(reviewer,c.case_id,'flag_detailed',0,{review_risk_reason:reason,reason:reason==='other'?'Manual explanation':null}));
  assert.equal(flagged.review_stage,'detailed');assert.equal(flagged.status,'pending');assert.equal((await awards(c.case_id)).n,0);
  const audit=await local.db.prepare("SELECT * FROM admin_audit_logs WHERE target_id=? AND action='flag_detailed'").bind(c.case_id).first();assert.equal(JSON.parse(audit.after_json).review_risk_reason,reason);
  const approved=await data(await h.review(reviewer,c.case_id,'approve',1));assert.equal(approved.status,'approved');assert.equal((await awards(c.case_id)).n,1);
 }
 const c=await proof();const invalid=await h.review(reviewer,c.case_id,'flag_detailed',0,{review_risk_reason:'pixel_score'});assert.equal(invalid.status,400);assert.equal((await row(c.case_id)).review_stage,'initial');
});
test('manual detailed flag versus fast approval CAS permits one winning transition',async()=>{
 const c=await proof();const [flag,fast]=await Promise.all([h.review(reviewer,c.case_id,'flag_detailed',0,{review_risk_reason:'exact_duplicate'}),batch(items([c]))]);
 const current=await row(c.case_id);assert.equal(current.version,1);
 if(current.status==='approved'){assert.equal(flag.status,409);assert.equal((await data(fast)).succeeded,1);assert.equal((await awards(c.case_id)).n,1);}else{assert.equal(current.review_stage,'detailed');assert.equal(flag.status,200);assert.equal((await data(fast)).failed,1);assert.equal((await awards(c.case_id)).n,0);}
 assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE target_id=? AND target_version=1").bind(c.case_id).first()).n,1);
});
test('audit failure rolls back detailed flag; batch failure keeps other case successes',async()=>{
 const a=await proof(),b=await proof();
 await local.db.prepare("CREATE TRIGGER local_workflow_audit_failure BEFORE INSERT ON admin_audit_logs WHEN NEW.action='flag_detailed' BEGIN SELECT RAISE(ABORT,'local audit failure'); END").run();
 assert.equal((await h.review(reviewer,a.case_id,'flag_detailed',0,{review_risk_reason:'manual_flag'})).status,503);assert.equal((await row(a.case_id)).version,0);assert.equal((await row(a.case_id)).review_stage,'initial');
 await local.db.prepare('DROP TRIGGER local_workflow_audit_failure').run();
 await local.db.prepare(`CREATE TRIGGER local_workflow_case_failure BEFORE UPDATE ON cases WHEN NEW.case_id='${b.case_id}' AND NEW.status='approved' BEGIN SELECT RAISE(ABORT,'local case failure'); END`).run();
 const result=await data(await batch(items([a,b])));assert.equal(result.succeeded,1);assert.equal(result.failed,1);assert.equal((await awards(a.case_id)).n,1);assert.equal((await awards(b.case_id)).n,0);
 await local.db.prepare('DROP TRIGGER local_workflow_case_failure').run();
 const retry=await data(await batch(items([b])));assert.equal(retry.succeeded,1);assert.equal((await awards(b.case_id)).n,1);
});
test('batch/flag require real session, CSRF, role and MFA; revoked actor cannot commit',async()=>{
 const c=await proof();for(const actor of [await h.identity(),await h.identity({role:'reviewer',elevated:false})])assert.equal((await batch(items([c]),actor)).status,403);
 const missing=await local.fetch('/api/admin/cases/batch-approve','POST',{cases:items([c])},{...reviewer.headers,'X-CSRF-Token':'bad'});assert.equal(missing.status,403);
 const stale=await h.identity({role:'reviewer'}),db={prepare:local.db.prepare.bind(local.db),async batch(list){await local.db.prepare('UPDATE auth_sessions SET revoked_at=1 WHERE token_hash=?').bind(stale.hash).run();return local.db.batch(list);}};
 const result=await batchApprove(db,{member:{member_id:stale.memberId,tokenHash:stale.hash},role:'reviewer'},items([c]));assert.equal(result.failed,1);assert.equal((await awards(c.case_id)).n,0);
});
test('review stage filter is validated and cursor-bound; bounded batch stays within Free query budget',async()=>{
 const detailed=await proof();await data(await h.review(reviewer,detailed.case_id,'flag_detailed',0,{review_risk_reason:'other',reason:'Manual concern'}));
 const response=await data(await local.fetch('/api/admin/cases?review_stage=detailed&status=pending','GET',undefined,reviewer.headers));assert.ok(response.cases.some(c=>c.case_id===detailed.case_id));assert.ok(response.cases.every(c=>c.review_stage==='detailed'));
 assert.equal((await local.fetch('/api/admin/cases?review_stage=pixel','GET',undefined,reviewer.headers)).status,400);
 const cases=[await proof(),await proof(),await proof(),await proof()];let queryCount=0;
 const db={prepare(sql){queryCount++;return local.db.prepare(sql);},batch:local.db.batch.bind(local.db)};
 const result=await batchApprove(db,{member:{member_id:reviewer.memberId,tokenHash:reviewer.hash},role:'reviewer'},items(cases));assert.equal(result.succeeded,4);assert.ok(queryCount+2<=50);
});
