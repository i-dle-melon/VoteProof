import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';
import { localAdminRuntime } from '../scripts/lib/local-admin-runtime.mjs';
import { driveConfigFixture } from '../scripts/lib/drive-backup-fixture.mjs';
const newTables = ['proof_backups','drive_backup_folders','backup_processor_lock','backup_admin_audit'];
test('0010 clean schema has no jobs, folders, locks or audits; gate stays OFF', async () => {
  const h = await localAdminRuntime();
  try {
    for (const table of newTables) assert.equal((await h.local.db.prepare('SELECT count(*) AS n FROM ' + table).first()).n, 0);
    await h.local.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
    assert.deepEqual((await h.local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
    assert.equal((await h.local.db.prepare('PRAGMA quick_check').first()).quick_check, 'ok');
  } finally { await h.local.runtime.dispose(); }
});
test('0001–0009 to 0010 preserves representative cases, approved ledger, proofs, members, audit and gate', async () => {
  const h = await localAdminRuntime();
  try {
    let db = h.local.db;
    for (const table of newTables) await db.prepare('DROP TABLE ' + table).run();
    const admin = await h.identity({ role: 'admin' }), member = await h.identity();
    await db.prepare("UPDATE campaigns SET points_per_proof=10,daily_limit=NULL WHERE campaign_id='LOCAL-TEST'").run();
    await h.local.setAuthConfig(driveConfigFixture());
    db = h.local.db;
    // Real local createCase still succeeds without 0010, even when scheduling is on.
    const approved = await h.makeCase({ member }); const pending = await h.makeCase({ member });
    assert.equal((await h.review(admin,approved.case_id,'approve')).status,200);
    await db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
    const tables = (await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results.map(x=>x.name);
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table,
      (await db.prepare('SELECT * FROM "' + table + '"').all()).results.map(r => JSON.stringify(r)).sort()])));
    const before = await snapshot();
    const schema = (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
    const source = await readFile(new URL('../migrations/0010_google_drive_backups.sql',import.meta.url),'utf8');
    await db.batch(unstable_splitSqlQuery(source).map(sql=>db.prepare(sql)));
    assert.deepEqual(await snapshot(), before);
    const afterSchema = (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
    for (const old of schema) assert.deepEqual(afterSchema.find(row=>row.name===old.name), old);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM cases').first()).n,2);
    assert.equal((await db.prepare('SELECT sum(points) AS n FROM point_transactions').first()).n,10);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM case_files').first()).n,2);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM proof_backups').first()).n,0);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
    assert.equal((await db.prepare('SELECT submissions_enabled FROM submission_settings WHERE id=1').first()).submissions_enabled,0);
    const archived = await db.prepare('SELECT object_key FROM case_files WHERE case_id=?').bind(pending.id).first(); assert.ok(await h.local.bucket.head(archived.object_key));
  } finally { await h.local.runtime.dispose(); }
});
