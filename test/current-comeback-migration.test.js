import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { embeddedCaseRuntime } from './helpers/embedded-case-runtime.mjs';
import { localAdminRuntime } from '../scripts/lib/local-admin-runtime.mjs';
import { currentComebackSQL,verifyCurrentComebackMigration } from './helpers/current-comeback-migration.mjs';
test('0020 is additive, forward-only and does not rewrite historical rows',()=>{
 assert.doesNotMatch(currentComebackSQL,/\b(DROP|DELETE|REPLACE|UPDATE|INSERT INTO)\s+(?:TABLE\s+)?(?:campaigns|cases|case_files|point_transactions|leaderboard_results|leaderboard_runs)\b/i);
 assert.doesNotMatch(currentComebackSQL,/\bDROP\s+(TABLE|COLUMN|INDEX|TRIGGER)\b/i);
 assert.match(currentComebackSQL,/ADD COLUMN is_current_comeback INTEGER NOT NULL DEFAULT 0/);
 assert.match(currentComebackSQL,/CREATE UNIQUE INDEX/);
});
test('populated SQLite 0019 to 0020 preserves Cases, ledger, published results and registry',async()=>{
 const h=await embeddedCaseRuntime({migrationThrough:'0019_solo_target_registry.sql'}),a=await h.identity('super_admin');
 const upstream=mock.method(globalThis,'fetch',async()=>Response.json({success:true}));
 try{
  const campaign_id='PRE20_C';
  const created=await h.fetch('/api/admin/campaigns','POST',{campaign_id,name:'Historical Solo',category:'Solo',solo_target:'yuqi',start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',points_per_proof:10,daily_limit:null,status:'active'},a.headers);assert.equal(created.status,201);
  await h.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();
  const {ref}=await h.upload(campaign_id,a);
  const made=await h.fetch('/api/cases/direct','POST',{campaign_id,vote_date:new Date().toISOString().slice(0,10),upload_session:ref},{...a.headers,'Idempotency-Key':randomUUID()});assert.equal(made.status,201,await made.clone().text());
  const c=(await made.json()).data;assert.equal((await h.fetch('/api/admin/cases/'+c.case_id+'/review','POST',{action:'approve',expected_version:0},a.headers)).status,200);
  await verifyCurrentComebackMigration(h.db,a.memberId,h.fetch,a.headers);
 }finally{upstream.mock.restore();h.close();}
});
test('real Miniflare populated 0019 to 0020 preserves historical publication',async()=>{
 const h=await localAdminRuntime({migrationThrough:'0019_solo_target_registry.sql'}),a=await h.identity({role:'super_admin'});
 try{
  await h.local.campaign({campaign_id:'PRE20_C',category:'Solo',solo_target:'yuqi',points_per_proof:10,daily_limit:null});
  const c=await h.makeCase({member:a,metadata:{campaign_id:'PRE20_C'}});assert.equal((await h.review(a,c.case_id,'approve')).status,200);
  await verifyCurrentComebackMigration(h.local.db,a.memberId,h.local.fetch,a.headers);
 }finally{await h.local.runtime.dispose();}
});
