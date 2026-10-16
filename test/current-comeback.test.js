import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { embeddedCaseRuntime } from './helpers/embedded-case-runtime.mjs';
import { definition } from '../scripts/lib/local-leaderboard-runtime.mjs';
let h,admin;
const data=async(r,status=200)=>{const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j.data;};
const create=(extra={})=>h.fetch('/api/admin/leaderboards','POST',definition({type:'campaign',campaign_id:'C_2026',start_date:null,end_date:null,...extra}),admin.headers);
const update=(row,extra={})=>h.fetch('/api/admin/leaderboards/'+row.leaderboard_id+'/update','POST',{...Object.fromEntries(['name','type','campaign_id','start_date','end_date','vote_type','top_n','is_public','status','is_current_comeback'].map(k=>[k,row[k]])),expected_version:row.version,...extra},admin.headers);
const selected=()=>h.db.prepare('SELECT leaderboard_id,version FROM leaderboards WHERE is_current_comeback=1').all();
before(async()=>{h=await embeddedCaseRuntime();admin=await h.identity('super_admin');
 await data(await h.fetch('/api/admin/campaigns','POST',{campaign_id:'C_2026',name:'Campaign underscore',category:'團體',solo_target:null,start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',points_per_proof:10,daily_limit:null,status:'active'},admin.headers),201);
});
after(()=>h?.close());
test('new campaign board is unselected; generated ID persists and unknown Campaign is rejected',async()=>{
 const input={...definition({type:'campaign',campaign_id:'C_2026',start_date:null,end_date:null})};delete input.leaderboard_id;
 const board=await data(await h.fetch('/api/admin/leaderboards','POST',input,admin.headers),201);assert.match(board.leaderboard_id,/^board-/);assert.equal(board.is_current_comeback,false);
 assert.deepEqual((await selected()).results,[]);
 const response=await create({campaign_id:'UNKNOWN'});assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_CAMPAIGN');
});
test('selecting new current comeback atomically replaces previous, audits both and preserves snapshots',async()=>{
 const first=await data(await create({is_current_comeback:true}),201);
 const run=await data(await h.fetch('/api/admin/leaderboards/'+first.leaderboard_id+'/rebuild','POST',{expected_version:first.version},admin.headers));
 const second=await data(await create({is_current_comeback:true}),201);
 assert.deepEqual((await selected()).results.map(r=>r.leaderboard_id),[second.leaderboard_id]);
 const prior=await data(await h.fetch('/api/admin/leaderboards/'+first.leaderboard_id,'GET',undefined,admin.headers));
 assert.equal(prior.is_current_comeback,false);assert.equal(prior.version,2);assert.equal(prior.current_run_id,run.run_id);
 assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE target_id=? AND after_json LIKE '%is_current_comeback%'").bind(first.leaderboard_id).first()).n,2);
 const board=(await data(await h.fetch('/api/leaderboards'))).leaderboards.find(b=>b.leaderboard_id===first.leaderboard_id);assert.equal(board.is_current_comeback,false);
});
test('stale CAS cannot clear another current selection; concurrent selections leave exactly one',async()=>{
 const a=await data(await create(),201),b=await data(await create(),201),old=(await selected()).results[0].leaderboard_id;
 assert.equal((await update(a,{is_current_comeback:true,expected_version:99})).status,409);assert.equal((await selected()).results[0].leaderboard_id,old);
 const results=await Promise.all([update(a,{is_current_comeback:true}),update(b,{is_current_comeback:true})]);assert.ok(results.every(r=>r.status===200||r.status===409));assert.equal((await selected()).results.length,1);
 const winner=await data(await h.fetch('/api/admin/leaderboards/'+(await selected()).results[0].leaderboard_id,'GET',undefined,admin.headers));
 const archived=await data(await update(winner,{status:'archived',is_current_comeback:false}));assert.equal(archived.is_current_comeback,false);assert.equal((await selected()).results.length,0);
});
test('database refuses multiple current rows and incompatible type/status; RBAC/CSRF remain enforced',async()=>{
 const a=await data(await create({is_current_comeback:true}),201),b=await data(await create(),201);
 await assert.rejects(h.db.prepare('UPDATE leaderboards SET is_current_comeback=1 WHERE leaderboard_id=?').bind(b.leaderboard_id).run());
 await assert.rejects(h.db.prepare("UPDATE leaderboards SET status='archived' WHERE leaderboard_id=?").bind(a.leaderboard_id).run());
 const reviewer=await h.identity('reviewer');assert.equal((await h.fetch('/api/admin/leaderboards','POST',definition(),reviewer.headers)).status,403);
 const headers={...admin.headers};delete headers['X-CSRF-Token'];assert.equal((await h.fetch('/api/admin/leaderboards','POST',definition(),headers)).status,403);
});
test('selection-only update preserves published results and failed transaction rolls selection/audit back',async()=>{
 const a=await data(await create(),201);
 const run=await data(await h.fetch('/api/admin/leaderboards/'+a.leaderboard_id+'/rebuild','POST',{expected_version:0},admin.headers));
 const current=await data(await h.fetch('/api/admin/leaderboards/'+a.leaderboard_id,'GET',undefined,admin.headers));
 const picked=await data(await update(current,{is_current_comeback:true}));assert.equal(picked.current_run_id,run.run_id);
 const publicBoard=(await data(await h.fetch('/api/leaderboards'))).leaderboards.find(b=>b.leaderboard_id===a.leaderboard_id);assert.equal(publicBoard.is_current_comeback,true);
 const auditCount=(await h.db.prepare('SELECT COUNT(*) n FROM admin_audit_logs').first()).n;
 const original=h.db.batch.bind(h.db);h.db.batch=statements=>original([...statements,h.db.prepare('SELECT * FROM forced_local_transaction_failure')]);
 try{assert.equal((await create({is_current_comeback:true})).status,503);}finally{h.db.batch=original;}
 assert.deepEqual((await selected()).results.map(r=>r.leaderboard_id),[a.leaderboard_id]);assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM admin_audit_logs').first()).n,auditCount);
 // Expiry after clearing the old selection makes the target INSERT a no-op.
 // The final transaction guard must still roll the clear/audit back.
 h.db.batch=statements=>{const at=statements.findIndex(s=>s.sql.startsWith('INSERT INTO leaderboards'));
   return original([...statements.slice(0,at),h.db.prepare('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?').bind(admin.memberId),...statements.slice(at)]);};
 try{assert.equal((await create({is_current_comeback:true})).status,503);}finally{h.db.batch=original;}
 assert.deepEqual((await selected()).results.map(r=>r.leaderboard_id),[a.leaderboard_id]);assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM admin_audit_logs').first()).n,auditCount);
 assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM auth_atomic_guards').first()).n,0);
});
