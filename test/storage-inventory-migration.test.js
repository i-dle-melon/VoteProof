import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {inventoryPage} from '../src/lib/storage-capacity.js';

test('0027 preserves populated 0026 capacity and a legacy in-flight cursor',async()=>{
  const h=await localAdminRuntime({submissionsEnabled:false,migrationThrough:'0026_archive_verification_handoff.sql'});
  try{
    const db=h.local.db,id=randomUUID();
    await db.prepare("UPDATE storage_capacity SET inventory_id=?,inventory_cursor='legacy-cursor',inventory_bytes=123,inventory_count=2,inventory_version=7,trusted_until=0 WHERE id=1").bind(id).run();
    const before=await db.prepare('SELECT * FROM storage_capacity').first();
    await db.prepare(await readFile('migrations/0027_storage_inventory_phases.sql','utf8')).run();
    const after=await db.prepare('SELECT * FROM storage_capacity').first();assert.equal(after.inventory_phase,null);
    delete after.inventory_phase;assert.deepEqual(after,before);
    const result=await inventoryPage({DB:db,R2_EXCLUSIVE_WRITER_CONFIRMED:'true',PROOFS_BUCKET:{list:async({cursor,limit})=>{
      assert.equal(cursor,'legacy-cursor');assert.equal(limit,200);return{objects:[{key:'synthetic',size:77}],truncated:false};
    }}});
    assert.equal(result.complete,true);assert.equal(result.bytes,200);
    assert.equal((await db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);
    assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await h.local.runtime.dispose();}
});
