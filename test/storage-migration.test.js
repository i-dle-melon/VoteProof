import {fixtures,fixtureSQL} from '../scripts/lib/archive-isolated-fixtures.mjs';
import test,{mock}from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{unstable_splitSqlQuery}from'wrangler';import{embeddedCaseRuntime,image}from'./helpers/embedded-case-runtime.mjs';
test('populated 0024 to 0025 preserves historical rows/objects and OFF; new capacity starts unknown and real PUT fails closed',async()=>{
 const h=await embeddedCaseRuntime({migrationThrough:'0024_admin_member_contact_audit.sql'}),upstream=mock.method(globalThis,'fetch',async()=>Response.json({success:true}));try{
 const actor=await h.identity('super_admin'),campaign_id='STORAGE_MIGRATION';const created=await h.fetch('/api/admin/campaigns','POST',{campaign_id,name:'Historical fixture',category:'Solo',solo_target:'yuqi',start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',status:'active',points_per_proof:10,daily_limit:null},actor.headers);assert.equal(created.status,201);
 await h.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();const {p}=await h.upload(campaign_id,actor);await h.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
 const tables=(await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).results.map(r=>r.name),snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async name=>[name,(await h.db.prepare('SELECT * FROM '+name).all()).results]))),before=await snapshot(),head=await h.bucket.head(p.uploads[0].key);
 const sql=await readFile('migrations/0025_storage_cold_v1.sql','utf8');await h.db.batch(unstable_splitSqlQuery(sql).map(s=>h.db.prepare(s)));assert.deepEqual(await snapshot(),before);assert.deepEqual(await h.bucket.head(p.uploads[0].key),head);const state=await h.db.prepare('SELECT * FROM storage_capacity').first();assert.equal(state.blocked,1);assert.equal(state.trusted_until,0);assert.equal(state.observed_at,null);assert.equal((await h.db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);
 // Explicit isolated gate opening only verifies a real current PUT cannot bypass unknown capacity.
 await h.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();const u=p.uploads[0],r=await h.fetch(new URL(u.upload_url).pathname,'PUT',image,{...actor.headers,...u.headers,'Content-Length':'3'});assert.equal(r.status,503,await r.clone().text());assert.equal((await r.json()).error.code,'R2_STORAGE_CAPACITY_EXCEEDED');await h.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();assert.deepEqual((await h.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await h.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
 }finally{upstream.mock.restore();h.close();}
});

test('0025 to 0026 preserves populated destructive pins, audit, capacity and submissions OFF',async()=>{
 const h=await embeddedCaseRuntime({migrationThrough:'0025_storage_cold_v1.sql'});
 try{
  const at='2026-01-01T00:00:00.000Z',db=h.db;
  await db.prepare("INSERT INTO campaigns(campaign_id,name,category,solo_target,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at) VALUES('ISOLATED','Synthetic','Solo','synthetic','2000-01-01','2100-01-01','UTC','2000-01-01','2099-12-31',0,NULL,'active',?,?)").bind(at,at).run();
  const triggers=(await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN('submissions_cases_insert','submissions_uploads_insert','submissions_upload_files_insert')").all()).results;
  for(const t of triggers)await db.prepare('DROP TRIGGER '+t.name).run();
  const f=fixtures([['legacy-pin',1]])[0];await db.batch(unstable_splitSqlQuery(fixtureSQL(f,'1'.repeat(64))).filter(s=>!s.trim().startsWith('INSERT INTO isolated_')).map(s=>db.prepare(s)));
  for(const t of triggers)await db.prepare(t.sql).run();
  await db.prepare("INSERT INTO cold_proofs(file_id,state,lease_token,lease_until,sha256,r2_version,etag,size,updated_at) VALUES(?,'deleting','legacy-pin',9999999999,?,'legacy-version','unseeded',?,1)").bind(f.file,'1'.repeat(64),f.size).run();
  await db.prepare("INSERT INTO storage_audit VALUES('existing',1,'archive_delete_claim',?,'{}')").bind(f.file).run();
  const names=['cases','case_files','proof_backups','cold_proofs','storage_audit','storage_capacity','submission_settings'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(names.map(async n=>[n,(await db.prepare('SELECT * FROM '+n).all()).results]))),before=await snapshot();
  await db.batch(unstable_splitSqlQuery(await readFile('migrations/0026_archive_verification_handoff.sql','utf8')).map(s=>db.prepare(s)));
  const after=await snapshot();assert.equal(after.cold_proofs[0].verification_context,null);delete after.cold_proofs[0].verification_context;assert.deepEqual(after,before);
  await assert.rejects(db.prepare("UPDATE cases SET updated_at='changed' WHERE id=?").bind(f.id).run());
  assert.equal((await db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
 }finally{h.close();}
});
