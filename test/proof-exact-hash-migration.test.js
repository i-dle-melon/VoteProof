import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {localCaseRuntime} from '../scripts/lib/local-case-runtime.mjs';
import {localPrehashCase} from '../scripts/lib/local-prehash-case-fixture.mjs';
import {adminExactEvidence,backfillExactHashes} from '../src/lib/proof-exact-hash.js';
test('0011 to 0012 is additive, preserves old rows/R2/gate, leaves old hashes unverified until explicit local backfill',async()=>{
 const local=await localCaseRuntime({migrationThrough:'0011_drive_backup_relay_lease_index.sql'});
 try{
   const proof=await localPrehashCase(local);await local.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
   const tables=(await local.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results.map(x=>x.name);
   const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async name=>[name,(await local.db.prepare('SELECT * FROM "'+name+'"').all()).results])));
   const before=await snapshot(),r2=(await local.bucket.list()).objects.map(x=>[x.key,x.etag]);
   const sql=await readFile(new URL('../migrations/0012_proof_exact_hashes.sql',import.meta.url),'utf8');
   await local.db.batch(unstable_splitSqlQuery(sql).map(s=>local.db.prepare(s)));
   assert.deepEqual(await snapshot(),before);assert.deepEqual((await local.bucket.list()).objects.map(x=>[x.key,x.etag]),r2);
   assert.equal((await adminExactEvidence(local.db,proof.id)).hash_state,'not_verified');
   assert.equal((await backfillExactHashes({db:local.db,bucket:local.bucket},{dryRun:true})).written,0);
   assert.equal((await backfillExactHashes({db:local.db,bucket:local.bucket},{dryRun:false})).written,1);
   assert.deepEqual(await snapshot(),before);assert.equal((await adminExactEvidence(local.db,proof.id)).hash_state,'verified');
   assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await local.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
 }finally{await local.runtime.dispose();}
});
