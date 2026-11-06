import test from 'node:test';
import assert from 'node:assert/strict';
import {exactFixture} from './helpers/exact-classification-fixture.mjs';
import {manualReviewBatchInput,manualReviewBatch} from '../src/lib/manual-review-batch.js';
import {fencedRequest} from '../src/lib/prelaunch-reset-fence.js';
import {origin} from './helpers/embedded-case-runtime.mjs';
globalThis.fetch=async url=>{assert.equal(String(url),'https://challenges.cloudflare.com/turnstile/v0/siteverify');return Response.json({success:true});};
const item=(c,version=0)=>({case_id:c.data.case_id,expected_version:version});
const post=(f,cases,action='approve',extra={},status=false,headers=f.a.headers)=>f.fetch('/api/admin/cases/batch-review'+(status?'/status':''),'POST',{cases,action,...extra},headers);
async function data(r){const j=await r.json();assert.equal(j.ok,true,JSON.stringify(j));return j.data;}
const state=(f,c)=>f.read('SELECT status,version,points_awarded FROM cases WHERE case_id=?',c.data.case_id);

test('explicit batch accepts four distinct ID/version pairs and the unchanged single-review rules',()=>{
 const id='VP-20261106-AAAAAAAAAAAAAAAA',base={cases:[{case_id:id,expected_version:0}],action:'approve'};
 assert.equal(manualReviewBatchInput(base,'reviewer').items.length,1);
 for(const bad of [null,[],{...base,all:true},{...base,cases:[]},{...base,cases:Array(5).fill(base.cases[0])},{...base,cases:[...base.cases,...base.cases]},{...base,action:'revoke'},{...base,action:'reject',reason:' '},{...base,action:'mark_duplicate',reason:'duplicate'},{...base,action:'flag_detailed',review_risk_reason:'other'}])assert.throws(()=>manualReviewBatchInput(bad,'reviewer'));
});

test('detailed approval is explicit, retains fast-lane refusal and awards/audits once on replay',async t=>{
 const f=await exactFixture(t,{exact:false}),c=await f.proof();await data(await f.fetch('/api/admin/cases/'+c.data.case_id+'/review','POST',{action:'flag_detailed',expected_version:0,review_risk_reason:'manual_flag'},f.a.headers));
 const cases=[item(c,1)],fast=await data(await f.fetch('/api/admin/cases/batch-approve','POST',{cases},f.a.headers));assert.equal(fast.results[0].code,'DETAILED_REVIEW_REQUIRED');
 const r=await data(await post(f,cases));assert.equal(r.results[0].status,'approved');assert.equal(state(f,c).points_awarded,3);
 const counts=()=>f.read('SELECT (SELECT COUNT(*) FROM point_transactions) p,(SELECT COUNT(*) FROM admin_audit_logs) a');const before=counts();
 assert.equal((await data(await post(f,cases))).results[0].outcome,'already_reviewed');assert.equal((await data(await post(f,cases,'approve',{},true))).succeeded,1);assert.deepEqual(counts(),before);
});

test('all existing review actions preserve transitions, required reasons and ledger reversal',async t=>{
 const f=await exactFixture(t,{exact:false}),root=await f.proof(),copy=await f.proof(),rejected=await f.proof();
 assert.equal((await data(await post(f,[item(root)],'flag_detailed',{review_risk_reason:'other',reason:'Needs a closer review'}))).results[0].review_stage,'detailed');
 await data(await post(f,[item(root,1)]));await data(await post(f,[item(root,2)],'complete'));
 assert.equal(state(f,root).status,'completed');assert.equal(f.read('SELECT SUM(points) n FROM point_transactions').n,3);
 await data(await post(f,[item(copy)],'mark_duplicate',{reason:'same original',duplicate_of_case_id:root.data.case_id}));assert.equal(state(f,copy).status,'duplicate');
 await data(await post(f,[item(rejected)],'reject',{reason:'not eligible'}));assert.equal(state(f,rejected).status,'rejected');
 await data(await post(f,[item(root,3)],'revoke',{reason:'review correction'}));assert.equal(state(f,root).status,'revoked');assert.equal(f.read('SELECT SUM(points) n FROM point_transactions').n,0);
 const before=f.read('SELECT COUNT(*) n FROM point_transactions').n;await data(await post(f,[item(root,3)],'revoke',{reason:'review correction'}));assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,before);
 assert.equal(f.read('SELECT COUNT(*) n FROM case_files').n,3);assert.equal(f.read('SELECT COUNT(*) n FROM admin_audit_logs').n,6);
});

test('CAS conflict is isolated; non-pending targets cannot be approved or rejected',async t=>{
 const f=await exactFixture(t,{exact:false}),a=await f.proof(),b=await f.proof();await data(await post(f,[item(a)],'flag_detailed',{review_risk_reason:'manual_flag'}));
 const result=await data(await post(f,[item(a),item(b)]));assert.equal(result.failed,1);assert.equal(result.succeeded,1);assert.equal(result.results[0].code,'CASE_STATUS_CONFLICT');
 assert.equal((await data(await post(f,[item(b,1)],'reject',{reason:'no'}))).failed,1);assert.equal(state(f,b).status,'approved');await data(await post(f,[item(a,1)]));assert.equal(f.read('SELECT SUM(points) n FROM point_transactions').n,6);
});

test('RBAC, MFA, CSRF and read-only status do not bypass review authorization',async t=>{
 const f=await exactFixture(t,{exact:false}),c=await f.proof();
 assert.equal((await post(f,[item(c)],'approve',{},false,f.b.headers)).status,403);
 assert.equal((await post(f,[item(c)],'approve',{},false,{...f.a.headers,'X-CSRF-Token':'invalid'})).status,403);
 const before=f.read('SELECT COUNT(*) n FROM admin_audit_logs').n;assert.equal((await data(await post(f,[item(c)],'approve',{},true))).unknown,1);assert.equal(f.read('SELECT COUNT(*) n FROM admin_audit_logs').n,before);assert.equal(state(f,c).status,'pending');
 const fixtureUpdate=(sql)=>fencedRequest(f.env,new Request(origin+'/api/local-test',{method:'POST'}),async env=>{await env.DB.prepare(sql).bind(f.a.memberId).run();return Response.json({ok:true});});
 await fixtureUpdate("UPDATE admin_memberships SET role='reviewer' WHERE member_id=?");
 assert.equal((await post(f,[item(c)],'revoke',{reason:'no'})).status,403);
 await fixtureUpdate('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?');
 assert.equal((await post(f,[item(c)])).status,403);
});

test('ACK loss reconciles the exact winning audit, halts remaining items and never awards twice',async t=>{
 const f=await exactFixture(t,{exact:false}),a=await f.proof(),b=await f.proof(),raw=f.env.DB;let writes=0;
 f.env.DB={...raw,async batch(xs){const result=await raw.batch(xs);if(xs.some(s=>s.sql.includes('UPDATE cases SET status ='))){writes++;throw Error('ACK_LOST');}return result;}};
 const r=await data(await post(f,[item(a),item(b)]));assert.equal(r.results[0].ok,true);assert.equal(r.results[1].code,'REVIEW_NOT_SUBMITTED');assert.equal(writes,1);assert.equal(state(f,a).status,'approved');assert.equal(state(f,b).status,'pending');
 const status=await data(await post(f,[item(a),item(b)],'approve',{},true));assert.equal(status.results[0].ok,true);assert.equal(status.results[1].unknown,true);assert.equal(writes,1);assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,1);assert.ok(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").n>=1);
});

test('unconfirmed failure keeps UNKNOWN and leaves later items, images and points untouched',async t=>{
 const f=await exactFixture(t,{exact:false}),a=await f.proof(),b=await f.proof(),raw=f.env.DB;let attempted=0;
 f.env.DB={...raw,async batch(xs){if(xs.some(s=>s.sql.includes('UPDATE cases SET status ='))){attempted++;throw Error('DELIVERY_UNKNOWN');}return raw.batch(xs);}};
 const r=await data(await post(f,[item(a),item(b)]));assert.equal(r.results[0].unknown,true);assert.equal(r.results[1].code,'REVIEW_NOT_SUBMITTED');assert.equal(attempted,1);assert.equal(state(f,a).status,'pending');assert.equal(state(f,b).status,'pending');assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,0);assert.equal(f.read('SELECT COUNT(*) n FROM case_files').n,2);
});

test('manual batch retains trusted exact-SHA auto-duplicate and idempotent audit resolution',async t=>{
 const f=await exactFixture(t,{legacyWriter:true}),root=await f.proof(),copy=await f.proof();await data(await f.review(root,'approve'));
 const r=await data(await post(f,[item(copy)]));assert.equal(r.results[0].status,'duplicate');assert.equal(r.results[0].outcome,'duplicate');assert.equal(r.results[0].points_awarded,0);
 assert.equal((await data(await post(f,[item(copy)],'approve',{},true))).results[0].outcome,'already_duplicate');assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,1);assert.equal(f.read('SELECT COUNT(*) n FROM admin_audit_logs WHERE target_id=?',copy.data.case_id).n,1);
});

test('same ID/version concurrent review has one winning audit and one points award',async t=>{
 const f=await exactFixture(t,{exact:false}),c=await f.proof();await Promise.all([post(f,[item(c)]),post(f,[item(c)])]);assert.equal(state(f,c).version,1);assert.equal(f.read('SELECT COUNT(*) n FROM point_transactions').n,1);assert.equal(f.read('SELECT COUNT(*) n FROM admin_audit_logs WHERE target_id=?',c.data.case_id).n,1);
});

test('audit reconciliation is bound to the requesting actor and exact shared reason',async t=>{
 const f=await exactFixture(t,{exact:false}),c=await f.proof(),cases=[item(c)];await data(await post(f,cases,'reject',{reason:'original reason'}));
 const spec=manualReviewBatchInput({cases,action:'reject',reason:'original reason'},'admin');
 const other=await manualReviewBatch(f.db,{member:{member_id:f.b.memberId},role:'admin'},spec.items,spec.input,{statusOnly:true});assert.equal(other.unknown,1);
 const wrong=await data(await post(f,cases,'reject',{reason:'different reason'},true));assert.equal(wrong.unknown,1);assert.equal(f.read('SELECT COUNT(*) n FROM admin_audit_logs WHERE target_id=?',c.data.case_id).n,1);
});
