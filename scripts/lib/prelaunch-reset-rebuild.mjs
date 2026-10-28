import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';
import {KEEP_TABLES,CLEAR_TABLES,tablePolicy,retainedRows} from './prelaunch-reset-policy.mjs';
import {capture,retainedDigests,digest,ident,assertReady} from './prelaunch-reset-snapshot.mjs';
export function rebuildLocal({source,snapshot,targetPath,window,runId,manifestHash,remainingBytes=0,failBeforeCommit=false}){
 assertReady(snapshot,window);if(capture(source).hash!==snapshot.hash)throw Error('SOURCE_CHANGED');
 if(!/^[a-f0-9]{64}$/.test(manifestHash)||!Number.isSafeInteger(remainingBytes)||remainingBytes<0)throw Error('INVALID_REBUILD_INPUT');
 if(targetPath!==':memory:'&&(fs.existsSync(targetPath)||targetPath.startsWith('\\\\')||targetPath.includes('://')))throw Error('TARGET_MUST_BE_NEW_LOCAL_FILE');
 const db=new DatabaseSync(targetPath);db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;');
 const insert=(name,row)=>{const cols=Object.keys(row);db.prepare('INSERT INTO '+ident(name)+'('+cols.map(ident).join(',')+') VALUES('+cols.map(()=>'?').join(',')+')').run(...cols.map(c=>row[c]));};
 try{
  // Restore to an UNBOUND, new database. Never DROP/disable a source trigger.
  // No partially assembled database is accepted as an activatable target.
  for(const row of snapshot.schema.filter(x=>x.type==='table'))db.exec(row.sql);
  for(const row of snapshot.schema.filter(x=>x.type==='index'))db.exec(row.sql);
  for(const [name,rows]of Object.entries(snapshot.tables)){
   tablePolicy(name);
   for(const row of retainedRows(name,rows))insert(name,row);
   if(name==='leaderboards')for(const row of rows){if(!Number.isSafeInteger(row.version+1))throw Error('VERSION_OVERFLOW');insert(name,{...row,current_run_id:null,version:row.version+1});}
  }
  const time=Math.floor(Date.now()/1000),cap=snapshot.tables.storage_capacity[0],image=snapshot.tables.image_maintenance_control[0],archive=snapshot.tables.storage_archive_control[0];
  insert('image_maintenance_control',{...image,mode:'closed',version:image.version+1,generation:image.generation+1,legacy_status:'unknown',legacy_evidence_hash:null,updated_at:time});
  insert('storage_archive_control',{...archive,mode:'paused',epoch:archive.epoch+1,writer_policy:null,evidence_hash:null,verified_until:0,updated_at:time});
  insert('storage_capacity',{...cap,used_bytes:remainingBytes,reserved_bytes:0,blocked:1,observed_at:null,trusted_until:0,inventory_id:null,inventory_phase:null,inventory_cursor:null,inventory_version:cap.inventory_version+1,inventory_bytes:0,inventory_count:0,inventory_staging:0,inventory_other:0,cleanup_requested:0,episode:cap.episode+1});
  for(const row of snapshot.sequence.filter(x=>KEEP_TABLES.has(x.name)||x.name==='admin_audit_logs')){const r=db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(row.seq,row.name);if(!r.changes)db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);}
  for(const row of snapshot.schema.filter(x=>x.type==='view'))db.exec(row.sql);
  for(const row of snapshot.schema.filter(x=>x.type==='trigger'))db.exec(row.sql);
  insert('storage_audit',{id:runId,created_at:time,action:'prelaunch_reset',target:runId,detail:JSON.stringify({source_hash:snapshot.hash,manifest_hash:manifestHash,preserved_identity_hash:digest(retainedDigests(snapshot))})});
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('TARGET_FK_FAILURE');
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('TARGET_INTEGRITY_FAILURE');
  const actual=capture(db);
  if(digest(actual.schema)!==digest(snapshot.schema))throw Error('TARGET_SCHEMA_MISMATCH');
  if(digest(retainedDigests(actual))!==digest(retainedDigests(snapshot)))throw Error('IDENTITY_OR_CONFIGURATION_CHANGED');
  if(capture(source).hash!==snapshot.hash)throw Error('SOURCE_CHANGED');
  if(failBeforeCommit)throw Error('LOCAL_INJECTED_BUILD_FAILURE');
  db.exec('COMMIT');return db;
 }catch(e){db.exec('ROLLBACK');db.close();throw e;}
}
export function verifyLocalTarget(db,snapshot,{runId,manifestHash}){
 const actual=capture(db);
 if(digest(actual.schema)!==digest(snapshot.schema)||digest(retainedDigests(actual))!==digest(retainedDigests(snapshot)))throw Error('TARGET_IDENTITY_OR_SCHEMA_CHANGED');
 if(digest(actual.tables.admin_audit_logs)!==digest(retainedRows('admin_audit_logs',snapshot.tables.admin_audit_logs)))throw Error('TARGET_AUDIT_PARTITION_MISMATCH');
 for(const name of CLEAR_TABLES){const rows=actual.tables[name]??[];if(name==='storage_audit'){
   if(rows.length!==1||rows[0].id!==runId||rows[0].action!=='prelaunch_reset'||JSON.parse(rows[0].detail).manifest_hash!==manifestHash||JSON.parse(rows[0].detail).source_hash!==snapshot.hash)throw Error('RESET_AUDIT_MISMATCH');
  }else if(rows.length)throw Error('BUSINESS_DATA_REMAINS');}
 for(const board of snapshot.tables.leaderboards){const row=actual.tables.leaderboards.find(b=>b.leaderboard_id===board.leaderboard_id);if(digest(row)!==digest({...board,current_run_id:null,version:board.version+1}))throw Error('LEADERBOARD_DEFINITION_CHANGED');}
 if(actual.tables.leaderboards.length!==snapshot.tables.leaderboards.length)throw Error('LEADERBOARD_DEFINITION_CHANGED');
 const control=actual.tables.image_maintenance_control[0],archive=actual.tables.storage_archive_control[0],capacity=actual.tables.storage_capacity[0];
 if(control.mode!=='closed'||control.legacy_status!=='unknown'||archive.mode!=='paused'||capacity.blocked!==1||capacity.trusted_until!==0||capacity.inventory_id!==null||capacity.reserved_bytes!==0)throw Error('TARGET_NOT_FAIL_CLOSED');
 if(db.prepare('PRAGMA foreign_key_check').all().length||db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('TARGET_INTEGRITY_FAILURE');
 return{identity:retainedDigests(actual),businessRows:0,gate:actual.tables.submission_settings[0].submissions_enabled,maintenance:'closed',legacy:'unknown',trusted_until:0};
}
