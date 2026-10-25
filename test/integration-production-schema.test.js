import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {localPrehashCase} from '../scripts/lib/local-prehash-case-fixture.mjs';
const snapshot=JSON.parse((await readFile(new URL('./fixtures/production-schema-0011.json',import.meta.url),'utf8')).replace(/^\ufeff/,''));
const normalize=s=>s?.replaceAll('"','').replace(/\s+/g,' ').trim();
test('observed Production 0011 DDL matches baseline; ordered 0012-0029 preserves legacy rows, gate OFF and FK graph',async(t)=>{
  const h=await localAdminRuntime({migrationThrough:'0011_drive_backup_relay_lease_index.sql',seedCampaign:false,submissionsEnabled:false}),l=h.local,db=l.db;
  try{
    const schema=(await db.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results;
    assert.deepEqual(schema.map(s=>s.name).sort(),snapshot.schema.map(s=>s.name).sort());
    for(const actual of schema){const expected=snapshot.schema.find(s=>s.name===actual.name);assert.equal(actual.type,expected.type,actual.name);assert.equal(normalize(actual.sql),normalize(expected.sql),actual.name);}
    // Model the observed legacy category without guessing a Solo/group mapping.
    await db.prepare(`INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at)
      VALUES('LOCAL-TEST','Synthetic legacy campaign','投票','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','Asia/Taipei','2000-01-01','2099-12-31',10,NULL,'active','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`).run();
    const member=await h.identity({fanId:'idle_voteproof'});
    await db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();
    const legacy=await localPrehashCase(l,{member});
    await db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
    const beforeCase=await db.prepare('SELECT * FROM cases WHERE id=?').bind(legacy.id).first();
    const beforeFiles=(await db.prepare('SELECT * FROM case_files WHERE case_id=?').bind(legacy.id).all()).results;
    const pending=(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>/^\d+_.+\.sql$/.test(n)&&!snapshot.migrations.includes(n)).sort();
    assert.deepEqual(pending.map(n=>n.slice(0,4)),['0012','0013','0014','0015','0016','0017','0018','0019','0020','0021','0022','0023','0024','0025','0026','0027','0028','0029']);
    assert.equal(pending.at(-1),'0029_archive_fencing.sql');
    for(const name of pending){const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[],name);assert.equal((await db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0,name);}
    const after=await db.prepare('SELECT * FROM cases WHERE id=?').bind(legacy.id).first();for(const [key,value]of Object.entries(beforeCase))assert.deepEqual(after[key],value,key);
    const files=(await db.prepare('SELECT * FROM case_files WHERE case_id=?').bind(legacy.id).all()).results;for(const f of beforeFiles)for(const [key,value]of Object.entries(f))assert.deepEqual(files.find(i=>i.id===f.id)[key],value,key);
    assert.equal((await db.prepare('SELECT player_id FROM members WHERE member_id=?').bind(member.memberId).first()).player_id,'idle_voteproof');
    assert.equal((await db.prepare("SELECT category FROM campaigns WHERE campaign_id='LOCAL-TEST'").first()).category,'投票');
    assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
    assert.deepEqual((await db.prepare('SELECT id,epoch,mode,writer_policy,evidence_hash,verified_until FROM storage_archive_control').all()).results,
      [{id:1,epoch:1,mode:'paused',writer_policy:null,evidence_hash:null,verified_until:0}]);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_archive_dispatches').first()).n,0);
    assert.ok((await db.prepare('PRAGMA table_info(cold_proofs)').all()).results.some(column=>column.name==='archive_epoch'));
    t.diagnostic(JSON.stringify({last_migration:pending.at(-1),ordered_migrations:pending.length,legacy_case_preserved:true,
      legacy_files_preserved:beforeFiles.length,gate_off:true,foreign_keys:'PASS',quick_check:'ok',archive_mode:'paused',archive_epoch:1,dispatch_count:0}));
  }finally{await l.runtime.dispose();}
});
test('0018 transaction failure restores pre-migration tables, references and policies',async()=>{
  const h=await localAdminRuntime({migrationThrough:'0017_immutable_final_uploads.sql'}),l=h.local,db=l.db;
  try{
    const c=await h.makeCase();await db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
    const before=(await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const sql=await readFile(new URL('../migrations/0018_direct_intent_cases.sql',import.meta.url),'utf8'),statements=unstable_splitSqlQuery(sql).map(s=>db.prepare(s));
    statements.push(db.prepare("INSERT INTO integration_deliberately_missing_table VALUES(1)"));
    await assert.rejects(db.batch(statements));
    assert.deepEqual((await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results,before);
    assert.ok(await db.prepare('SELECT id FROM cases WHERE case_id=?').bind(c.case_id).first());assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    assert.equal((await db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);
  }finally{await l.runtime.dispose();}
});
