import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
// Takes a pre-generated local directory so we do not regenerate 54 MiB per test.
const folder=process.env.ARCHIVE_OFFLINE_ARTIFACTS;
test('offline exported migration chain/setup restores exact latest submission gates and only synthetic fixtures',{skip:!folder},async()=>{
  const h=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-10-07',d1Databases:['DB']}));
  try{
    const db=await h.getD1Database('DB');
    for(const name of (await readdir(folder+'/migrations')).sort())await db.batch(unstable_splitSqlQuery(await readFile(folder+'/migrations/'+name,'utf8')).map(sql=>db.prepare(sql)));
    const gates=await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN('submissions_cases_insert','submissions_uploads_insert','submissions_upload_files_insert') ORDER BY name").all();
    // This test ONLY uses disposable native LOCAL D1.
    await db.batch(unstable_splitSqlQuery(await readFile(folder+'/synthetic-setup.sql','utf8')).map(sql=>db.prepare(sql)));
    assert.deepEqual((await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN('submissions_cases_insert','submissions_uploads_insert','submissions_upload_files_insert') ORDER BY name").all()).results,gates.results);
    assert.equal(await db.prepare('SELECT submissions_enabled FROM submission_settings').first('submissions_enabled'),0);
    assert.equal(await db.prepare('SELECT count(*) n FROM isolated_fixtures').first('n'),18);
    assert.equal(await db.prepare("SELECT count(*) n FROM isolated_fixtures WHERE object_key NOT LIKE 'proofs/synthetic/%'").first('n'),0);
    assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check,'ok');assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await h.dispose();}
});
