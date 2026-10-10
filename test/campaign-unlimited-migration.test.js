import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';
import { localCaseRuntime } from '../scripts/lib/local-case-runtime.mjs';
import { localLeaderboardRuntime } from '../scripts/lib/local-leaderboard-runtime.mjs';

test('0008 to 0009 preserves populated campaigns, ledger, published snapshot, audit and gate',async()=>{
  const member='M-'+randomUUID(),session=randomUUID(),caseId=randomUUID(),transaction=randomUUID(),run=randomUUID(),audit=randomUUID();
  const tables=['members','campaigns','cases','completed_uploads','point_transactions','leaderboards','leaderboard_runs','leaderboard_results','admin_audit_logs','member_tiers','submission_settings'];
  const oldRows={}; let oldSchema;
  const local=await localCaseRuntime({seedCampaign:false,submissionsEnabled:false,migrationHook:async(db,name)=>{
    if(name!=='0008_submission_gate.sql')return;
    const now=new Date().toISOString();
    await db.prepare(`INSERT INTO members(id,member_id,login_name,nickname,status,created_at,updated_at,last_login_at)
      VALUES(?,?,?,'Local upgrade','active',?,?,?)`).bind(randomUUID(),member,randomUUID().replaceAll('-',''),now,now,now).run();
    for(const limit of [0,1,1000]) await db.prepare(`INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at,created_by,updated_by,version,last_mutation_id)
      VALUES(?,'Local upgrade','local','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','UTC','2000-01-01','2099-12-31',10,?,'active',?,?,?,?,3,?)`)
      .bind('UPGRADE-'+limit,limit,now,now,member,member,randomUUID()).run();
    await db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();
    await db.batch([
      db.prepare('INSERT INTO completed_uploads(session_id,manifest_hash,completed_at,expires_at) VALUES(?,?,?,?)').bind(session,randomBytes(32).toString('hex'),now,'2100-01-01T00:00:00.000Z'),
      db.prepare(`INSERT INTO cases(id,case_id,created_at,updated_at,nickname,player_id,campaign_id,vote_type,vote_date,query_key_hash,upload_session_id,member_id,status,points_awarded)
        VALUES(?,?,?,?,'Local upgrade','local','UPGRADE-1000','Solo','2026-10-10',?,? ,?,'approved',10)`)
        .bind(caseId,'VP-20261010-AAAAAAAAAAAAAAAA',now,now,randomBytes(32).toString('hex'),session,member),
      db.prepare(`INSERT INTO point_transactions(transaction_id,created_at,member_id,case_id,campaign_id,category,vote_type,vote_date,points,reason,created_by,metadata_json)
        VALUES(?,?,?,?,'UPGRADE-1000','proof_approved','Solo','2026-10-10',10,'Local upgrade',?,'{"daily_limit":1000}')`).bind(transaction,now,member,caseId,member),
      db.prepare(`INSERT INTO leaderboards(leaderboard_id,name,type,campaign_id,top_n,is_public,status,created_at,updated_at,created_by,updated_by)
        VALUES('UPGRADE-BOARD','Local upgrade','campaign','UPGRADE-1000',10,1,'active',?,?,?,?)`).bind(now,now,member,member),
      db.prepare(`INSERT INTO leaderboard_runs(run_id,leaderboard_id,generated_at,definition_version,source_count,source_last_transaction_id,status,definition_json,integrity_errors)
        VALUES(?,'UPGRADE-BOARD',?,0,1,?,'building','{}',0)`).bind(run,now,transaction),
      db.prepare(`INSERT INTO leaderboard_results(run_id,leaderboard_id,rank,member_id,nickname,points,proof_count,reached_at)
        VALUES(?,'UPGRADE-BOARD',1,?,'Local upgrade',10,1,?)`).bind(run,member,now),
      db.prepare("UPDATE leaderboard_runs SET status='success',row_count=1 WHERE run_id=?").bind(run),
      db.prepare("UPDATE leaderboards SET current_run_id=? WHERE leaderboard_id='UPGRADE-BOARD'").bind(run),
      db.prepare(`INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json)
        VALUES(?,?,?,'admin','campaign_create','campaign','UPGRADE-1000',0,'{}','{"daily_limit":1000}')`).bind(audit,now,member)
    ]);
    await db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
    for(const t of tables)oldRows[t]=(await db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()).results;
    oldSchema=(await db.prepare("SELECT type,name,tbl_name FROM sqlite_schema ORDER BY type,name").all()).results;
  }});
  try{
    for(const t of tables)assert.deepEqual((await local.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()).results,oldRows[t],t+' rows preserved');
    assert.deepEqual((await local.db.prepare("SELECT type,name,tbl_name FROM sqlite_schema ORDER BY type,name").all()).results,oldSchema);
    const column=(await local.db.prepare('PRAGMA table_info(campaigns)').all()).results.find(r=>r.name==='daily_limit');
    assert.equal(column.notnull,0);
    await local.db.prepare("UPDATE campaigns SET daily_limit=NULL WHERE campaign_id='UPGRADE-1'").run();
    assert.equal((await local.db.prepare("SELECT daily_limit FROM campaigns WHERE campaign_id='UPGRADE-1'").first()).daily_limit,null);
    for(const invalid of [-1,1001,1.5,'unlimited'])await assert.rejects(local.db.prepare("UPDATE campaigns SET daily_limit=? WHERE campaign_id='UPGRADE-1'").bind(invalid).run());
    await assert.rejects(local.db.prepare("DELETE FROM campaigns WHERE campaign_id='UPGRADE-0'").run());
    await assert.rejects(local.db.prepare("UPDATE campaigns SET campaign_id='OTHER' WHERE campaign_id='UPGRADE-0'").run());
    await assert.rejects(local.db.prepare("UPDATE point_transactions SET points=20 WHERE transaction_id=?").bind(transaction).run());
    assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    assert.equal((await local.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
    assert.equal((await local.db.prepare('SELECT submissions_enabled FROM submission_settings WHERE id=1').first()).submissions_enabled,0);
  }finally{await local.runtime.dispose();}
});

test('Unlimited proof ledger rebuilds a correct campaign leaderboard after approval/revoke',async()=>{
  const h=await localLeaderboardRuntime();
  try{
    const member=await h.identity(),campaign=await h.campaign({daily_limit:null});
    const first=await h.award(member,campaign);await h.award(member,campaign);
    assert.equal((await h.review(h.admin,first.case_id,'revoke',1,{reason:'Local unlimited revoke'})).status,200);
    const board=await h.create({type:'campaign',campaign_id:campaign});
    assert.equal((await h.rebuild(board)).status,200);
    const snapshot=await h.snapshot(board);
    assert.equal(snapshot.rankings.length,1);assert.equal(snapshot.rankings[0].member_id,member.memberId);
    assert.equal(snapshot.rankings[0].points,10);assert.equal(snapshot.rankings[0].proof_count,1);
  }finally{await h.local.runtime.dispose();}
});

test('0009 integrity guard failure rolls back the rebuild without leaving temporary tables',async()=>{
  let rollbackVerified=false;
  const local=await localCaseRuntime({seedCampaign:false,migrationHook:async(db,name)=>{
    if(name!=='0008_submission_gate.sql')return;
    // Inject a failing guard result only into this disposable migration batch.
    const source=await readFile(new URL('../migrations/0009_campaign_unlimited_daily_limit.sql',import.meta.url),'utf8');
    const injected=source.replace('SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END','SELECT 0');
    assert.notEqual(injected,source);
    await assert.rejects(db.batch(unstable_splitSqlQuery(injected).map(sql=>db.prepare(sql))));
    const column=(await db.prepare('PRAGMA table_info(campaigns)').all()).results.find(r=>r.name==='daily_limit');
    assert.equal(column.notnull,1);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN('campaigns_next','campaign_migration_guard')").first()).n,0);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    rollbackVerified=true;
  }});
  try{assert.equal(rollbackVerified,true);}finally{await local.runtime.dispose();}
});
