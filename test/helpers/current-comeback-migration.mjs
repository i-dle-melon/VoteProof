import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';
export const currentComebackSQL=await readFile(new URL('../../migrations/0020_current_comeback.sql',import.meta.url),'utf8');
export async function verifyCurrentComebackMigration(db, memberId, fetch, headers) {
 await db.prepare(`INSERT INTO leaderboards(leaderboard_id,name,type,campaign_id,start_date,end_date,vote_type,top_n,is_public,status,created_at,updated_at,created_by,updated_by)
   VALUES('PRE20','Old named board','custom',NULL,'2000-01-01','2099-12-31',NULL,10,1,'active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',?,?)`).bind(memberId,memberId).run();
 const rebuilt=await fetch('/api/admin/leaderboards/PRE20/rebuild','POST',{expected_version:0},headers);assert.equal(rebuilt.status,200,await rebuilt.clone().text());
 const tables=['members','campaigns','cases','case_files','point_transactions','leaderboards','leaderboard_runs','leaderboard_results','admin_audit_logs','proof_backups','submission_settings','solo_targets'];
 const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await db.prepare('SELECT * FROM '+table).all()).results.map(row=>{const{is_current_comeback,...rest}=row;return JSON.stringify(rest);}).sort()])));
 const before=await snapshot(),schema=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND NOT (type='table' AND name='leaderboards') AND name NOT IN ('idx_leaderboards_one_current_comeback','leaderboards_current_comeback_insert','leaderboards_current_comeback_update') ORDER BY name").all()).results;
 assert.ok(before.leaderboard_results.length>0,'Populated historical results required');
 await db.batch(unstable_splitSqlQuery(currentComebackSQL).map(sql=>db.prepare(sql)));
 assert.deepEqual(await snapshot(),before);
 assert.deepEqual((await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND NOT (type='table' AND name='leaderboards') AND name NOT IN ('idx_leaderboards_one_current_comeback','leaderboards_current_comeback_insert','leaderboards_current_comeback_update') ORDER BY name").all()).results,schema);
 const rows=(await db.prepare('SELECT is_current_comeback FROM leaderboards').all()).results;assert.ok(rows.every(r=>r.is_current_comeback===0));
 assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
 assert.ok((await db.prepare("SELECT name FROM sqlite_master WHERE name='idx_leaderboards_one_current_comeback'").first()));
}
