import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {adminCase,applyReview} from '../src/lib/admin-store.js';
import {reviewInput} from '../src/lib/case-review.js';
import {manualReviewBatch} from '../src/lib/manual-review-batch.js';
const data=async r=>{const j=await r.json();assert.equal(j.ok,true,JSON.stringify(j));return j.data;};
function measured(raw){
 const stats={statements:0,trips:0,rows_read:0,rows_written:0},sql=[];
 const record=r=>{stats.rows_read+=r.meta?.rows_read??0;stats.rows_written+=r.meta?.rows_written??0;return r;};
 const wrap=raw=>({raw,bind:(...v)=>wrap(raw.bind(...v)),async all(){stats.trips++;return record(await raw.all());},async run(){stats.trips++;return record(await raw.run());},async first(column){const r=await this.all(),row=r.results[0]??null;return column?row?.[column]??null:row;}});
 return {stats,sql,db:{prepare(query){stats.statements++;sql.push(query.trim().replace(/\s+/g,' '));return wrap(raw.prepare(query));},async batch(statements){stats.trips++;return(await raw.batch(statements.map(s=>s.raw))).map(record);}}};
}
test('local workerd: detailed HTTP route works and selected batch keeps equivalent single-review write/trip cost',async t=>{
 const h=await localAdminRuntime();t.after(()=>h.local.runtime.dispose());const a=await h.identity({role:'admin'}),member=await h.identity();await h.local.campaign({campaign_id:'LIST-BATCH',points_per_proof:10,daily_limit:null});
 const cases=[];for(let n=0;n<8;n++){const c=await h.makeCase({member,metadata:{campaign_id:'LIST-BATCH'}});await data(await h.review(a,c.case_id,'flag_detailed',0,{review_risk_reason:'manual_flag'}));cases.push(c);}
 const actor={member:{member_id:a.memberId,tokenHash:a.hash},role:'admin'},single=measured(h.local.db),batch=measured(h.local.db);
 for(const c of cases.slice(0,4)){const row=await adminCase(single.db,c.case_id);await applyReview(single.db,actor,row,reviewInput({action:'approve',expected_version:1},'admin'));}
 const items=cases.slice(4).map(c=>({case_id:c.case_id,expected_version:1}));const result=await manualReviewBatch(batch.db,actor,items,reviewInput({action:'approve',expected_version:0},'admin'));
 assert.equal(result.succeeded,4);assert.equal(batch.stats.rows_written,single.stats.rows_written);assert.equal(batch.stats.trips,single.stats.trips);assert.equal(batch.stats.statements,single.stats.statements);assert.deepEqual(batch.sql,single.sql);assert.ok(batch.stats.statements+2<=50);
 const httpCase=await h.makeCase({member,metadata:{campaign_id:'LIST-BATCH'}});await data(await h.review(a,httpCase.case_id,'flag_detailed',0,{review_risk_reason:'manual_flag'}));
 const body={cases:[{case_id:httpCase.case_id,expected_version:1}],action:'approve'},response=await data(await h.local.fetch('/api/admin/cases/batch-review','POST',body,a.headers));assert.equal(response.results[0].status,'approved');
 const status=await data(await h.local.fetch('/api/admin/cases/batch-review/status','POST',body,a.headers));assert.equal(status.results[0].ok,true);
 fs.mkdirSync('.wrangler',{recursive:true});fs.writeFileSync('.wrangler/review-list-cost.json',JSON.stringify({scope:'Local workerd D1 metadata; service layer only; excludes HTTP auth and Reset Fence (fixture disabled); not Cloud native CPU',action:'approve',cases:4,baseline_single_review:single.stats,selected_batch:batch.stats,normal_review_sql_shapes_identical:true,sql_shape_sha256:createHash('sha256').update(JSON.stringify(batch.sql)).digest('hex'),read_comparison_limitation:'Different case IDs/order; ledger grows between samples. Not an identical-state Rows Read experiment.',per_case:{rows_read:batch.stats.rows_read/4,rows_written:batch.stats.rows_written/4,trips:batch.stats.trips/4},r2_review_operations:0,cloud_cpu:'UNKNOWN'},null,2));
});
