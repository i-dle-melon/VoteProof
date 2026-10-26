import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';

test('populated 0029 to 0030 preserves cases/files/Gate/Audit, starts legacy UNKNOWN and passes FK',async t=>{
 const h=await localAdminRuntime({submissionsEnabled:true,migrationThrough:'0029_archive_fencing.sql'});t.after(()=>h.local.runtime.dispose());
 const made=await h.makeCase();const db=h.local.db;
 await db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
 const tables=['cases','case_files','point_transactions','storage_reservations','storage_audit','submission_settings','storage_archive_control'];
 const snapshot=()=>Promise.all(tables.map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all().then(r=>r.results)));
 const before=await snapshot(),source=await readFile(new URL('../migrations/0030_image_maintenance.sql',import.meta.url),'utf8');
 assert.doesNotMatch(source,/\bDROP\s+(TABLE|COLUMN|TRIGGER)\b/i);
 const statements=unstable_splitSqlQuery(source);await db.batch(statements.map(s=>db.prepare(s)));
 assert.deepEqual(await snapshot(),before);
 assert.deepEqual(await db.prepare('SELECT mode,version,legacy_status FROM image_maintenance_control').first(),{mode:'open',version:1,legacy_status:'unknown'});
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM image_mutation_operations').first()).n,0);
 assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
 assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 const file=(await db.prepare('SELECT object_key FROM case_files WHERE case_id=?').bind(made.id).first()).object_key;
 assert.ok(await h.local.bucket.head(file));
 await assert.rejects(db.batch(statements.map(s=>db.prepare(s))));
 assert.deepEqual(await snapshot(),before);assert.ok(await h.local.bucket.head(file));
});

test('0030 transaction failure rolls back new schema without clearing 0029 data',async t=>{
 const h=await localAdminRuntime({submissionsEnabled:false,migrationThrough:'0029_archive_fencing.sql'});t.after(()=>h.local.runtime.dispose());
 const db=h.local.db,source=await readFile(new URL('../migrations/0030_image_maintenance.sql',import.meta.url),'utf8');
 const schema=()=>db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().then(r=>r.results);
 const before=await schema();
 await assert.rejects(db.batch([...unstable_splitSqlQuery(source).map(s=>db.prepare(s)),db.prepare('INSERT INTO deliberately_absent_image_fixture VALUES(1)')]));
 assert.deepEqual(await schema(),before);
 assert.equal((await db.prepare('SELECT mode FROM storage_archive_control').first()).mode,'paused');
 assert.equal((await db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);
});
