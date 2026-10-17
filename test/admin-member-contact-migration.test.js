import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {unstable_splitSqlQuery} from 'wrangler';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
test('populated 0023 to 0024 is additive, preserves every prior row and schema; FK zero quick_check ok gate OFF',async()=>{
 const h=await embeddedCaseRuntime({migrationThrough:'0023_member_status_events.sql'}),upstream=mock.method(globalThis,'fetch',async()=>Response.json({success:true}));
 try{
 const admin=await h.identity('admin'),member=await h.identity(),campaign_id='CONTACT_MIGRATION';
 assert.equal((await h.fetch('/api/admin/campaigns','POST',{campaign_id,name:'Historical',category:'Solo',solo_target:'yuqi',start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',status:'active',points_per_proof:10,daily_limit:null},admin.headers)).status,201);
 await h.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();const{ref}=await h.upload(campaign_id,member),r=await h.fetch('/api/cases/direct','POST',{campaign_id,vote_date:new Date().toISOString().slice(0,10),upload_session:ref},{...member.headers,'Idempotency-Key':randomUUID()});assert.equal(r.status,201);const c=(await r.json()).data;assert.equal((await h.fetch('/api/admin/cases/'+c.case_id+'/review','POST',{action:'approve',expected_version:0},admin.headers)).status,200);
 await h.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
 assert.equal((await h.fetch('/api/admin/leaderboards','POST',{leaderboard_id:'CONTACT_BOARD',name:'Preserved custom board',type:'custom',start_date:'2000-01-01',end_date:'2099-12-31',top_n:100,is_public:true,status:'active'},admin.headers)).status,201);
 const schema=(await h.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results,tables=schema.filter(r=>r.type==='table').map(r=>r.name);
 const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await h.db.prepare('SELECT * FROM '+t).all()).results.map(r=>JSON.stringify(r)).sort()])));const before=await snapshot();assert.ok(before.cases.length);assert.ok(before.members.length);assert.ok(before.point_transactions.length);assert.ok(before.leaderboards.length);
 const sql=await readFile('migrations/0024_admin_member_contact_audit.sql','utf8');const statements=unstable_splitSqlQuery(sql);for(const s of statements)assert.match(s.replace(/--[^\n]*/g,'').trim(),/^CREATE (?:TABLE|INDEX|TRIGGER)\b/);
 await h.db.batch(statements.map(s=>h.db.prepare(s)));assert.deepEqual(await snapshot(),before);const names=new Set(schema.map(r=>r.name));assert.deepEqual((await h.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results.filter(r=>names.has(r.name)),schema);
 assert.deepEqual((await h.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await h.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');assert.equal((await h.db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);
 }finally{upstream.mock.restore();h.close();}
});
