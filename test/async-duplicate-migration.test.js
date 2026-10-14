import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
test('0012 -> 0013 converts verified metadata only; preserves cases, points, R2, gate and Drive',async()=>{
  const h=await localAdminRuntime({migrationThrough:'0012_proof_exact_hashes.sql'});
  try {
    const c=await h.makeCase({member:await h.identity()}),db=h.local.db;
    await db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
    const tables=(await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results.map(r=>r.name);
    const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await db.prepare('SELECT * FROM "'+t+'"').all()).results])));
    const before=await snapshot(),objects=(await h.local.bucket.list()).objects.map(r=>[r.key,r.etag]);
    await db.batch(unstable_splitSqlQuery(await readFile(new URL('../migrations/0013_async_proof_duplicates.sql',import.meta.url),'utf8')).map(s=>db.prepare(s)));
    assert.deepEqual(await snapshot(),before);assert.deepEqual((await h.local.bucket.list()).objects.map(r=>[r.key,r.etag]),objects);
    const job=await db.prepare('SELECT * FROM proof_duplicate_jobs WHERE case_internal_id=?').bind(c.id).first();assert.equal(job.state,'pending');assert.equal(job.attempts,0);assert.equal(job.completed_at,null);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='idx_proof_exact_hash_lookup'").first()).n,0);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
  } finally {await h.local.runtime.dispose();}
});
