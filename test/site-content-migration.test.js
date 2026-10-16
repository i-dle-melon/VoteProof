import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {unstable_splitSqlQuery} from 'wrangler';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
const sql=await readFile(new URL('../migrations/0021_campaign_content_announcements.sql',import.meta.url),'utf8');
test('0021 adds only independent content tables, indexes and audit triggers',()=>{
 for(const statement of unstable_splitSqlQuery(sql))assert.match(statement.replace(/--[^\n]*/g,"" ).trim(),/^CREATE (?:TABLE|INDEX|TRIGGER)\b/);
 for(const name of ['campaign_example_assets','campaign_content','site_announcements','admin_content_audit'])assert.match(sql,new RegExp('CREATE TABLE '+name));
});
test('Wrangler-split populated 0020 to 0021 preserves all existing rows and schema',async()=>{
 const h=await embeddedCaseRuntime({migrationThrough:'0020_current_comeback.sql'}),admin=await h.identity('super_admin');const upstream=mock.method(globalThis,'fetch',async()=>Response.json({success:true}));
 try{
 const campaign_id='PRE21';assert.equal((await h.fetch('/api/admin/campaigns','POST',{campaign_id,name:'Historical',category:'Solo',solo_target:'yuqi',start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',status:'active',points_per_proof:10,daily_limit:null},admin.headers)).status,201);
 await h.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();const {ref}=await h.upload(campaign_id,admin),r=await h.fetch('/api/cases/direct','POST',{campaign_id,vote_date:new Date().toISOString().slice(0,10),upload_session:ref},{...admin.headers,'Idempotency-Key':randomUUID()});assert.equal(r.status,201);const c=(await r.json()).data;assert.equal((await h.fetch('/api/admin/cases/'+c.case_id+'/review','POST',{action:'approve',expected_version:0},admin.headers)).status,200);
 const schema=(await h.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
 const tables=schema.filter(r=>r.type==='table').map(r=>r.name);const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async name=>[name,(await h.db.prepare('SELECT * FROM '+name).all()).results.map(r=>JSON.stringify(r)).sort()])));const before=await snapshot();assert.ok(before.cases.length);assert.ok(before.case_files.length);assert.ok(before.point_transactions.length);
 await h.db.batch(unstable_splitSqlQuery(sql).map(q=>h.db.prepare(q)));assert.deepEqual(await snapshot(),before);const names=new Set(schema.map(r=>r.name));assert.deepEqual((await h.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results.filter(r=>names.has(r.name)),schema);
 assert.deepEqual((await h.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await h.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');assert.equal((await h.fetch('/api/campaigns/PRE21/guidance')).status,200);
 }finally{upstream.mock.restore();h.close();}
});
