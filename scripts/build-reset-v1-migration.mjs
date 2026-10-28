// Offline versioned extension. Never changes main migrations 0001-0028.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {createHash} from 'node:crypto';
import { APP64 } from './lib/prelaunch-reset-0028.mjs';
const db=new DatabaseSync(':memory:');
for(const file of fs.readdirSync('migrations').filter(x=>/^\d+_.+\.sql$/.test(x)).sort())db.exec(fs.readFileSync('migrations/'+file,'utf8'));
const sql=[`-- reset-v1/0001: independent namespace, NOT main migration 0029/0030/0031.
CREATE TABLE prelaunch_reset_schema_versions(version INTEGER PRIMARY KEY,sql_sha256 TEXT NOT NULL,applied_at TEXT NOT NULL);
CREATE TABLE prelaunch_reset_control(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL CHECK(epoch>=0),mode TEXT NOT NULL CHECK(mode IN('open','maintenance')),version INTEGER NOT NULL,run_id TEXT);
INSERT INTO prelaunch_reset_control VALUES(1,0,'maintenance',0,NULL);
CREATE TABLE prelaunch_reset_operations(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('active','completed','unknown')),pending_r2 INTEGER NOT NULL DEFAULT 0 CHECK(pending_r2>=0),r2_writes INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,ended_at TEXT);
CREATE INDEX prelaunch_reset_operations_state ON prelaunch_reset_operations(state);
CREATE TABLE prelaunch_reset_permit(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,operation_id TEXT,purpose TEXT NOT NULL CHECK(purpose IN('normal','reset')),scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),run_id TEXT);
CREATE TABLE prelaunch_reset_issuance(session_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN('legacy','v2','direct')),keys_json TEXT NOT NULL CHECK(json_valid(keys_json)),created_at TEXT NOT NULL);
CREATE TABLE prelaunch_reset_retired_keys(object_key TEXT PRIMARY KEY,epoch INTEGER NOT NULL,run_id TEXT NOT NULL REFERENCES prelaunch_reset_audit(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE prelaunch_reset_audit(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL CHECK(json_valid(detail)));
CREATE TRIGGER prelaunch_reset_issuance_admission BEFORE INSERT ON prelaunch_reset_issuance
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch JOIN prelaunch_reset_operations o ON o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active' WHERE p.id=1 AND p.purpose='normal' AND c.mode='open' AND NEW.epoch=c.epoch)
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_ISSUANCE_FENCED');END;
CREATE TRIGGER prelaunch_reset_issuance_no_update BEFORE UPDATE ON prelaunch_reset_issuance BEGIN SELECT RAISE(ABORT,'RESET_ISSUANCE_IMMUTABLE');END;
CREATE TRIGGER prelaunch_reset_issuance_no_delete BEFORE DELETE ON prelaunch_reset_issuance BEGIN SELECT RAISE(ABORT,'RESET_ISSUANCE_IMMUTABLE');END;
CREATE TRIGGER prelaunch_reset_audit_no_update BEFORE UPDATE ON prelaunch_reset_audit BEGIN SELECT RAISE(ABORT,'RESET_AUDIT_IMMUTABLE');END;
CREATE TRIGGER prelaunch_reset_audit_no_delete BEFORE DELETE ON prelaunch_reset_audit BEGIN SELECT RAISE(ABORT,'RESET_AUDIT_IMMUTABLE');END;
CREATE TRIGGER prelaunch_reset_retired_no_update BEFORE UPDATE ON prelaunch_reset_retired_keys BEGIN SELECT RAISE(ABORT,'RESET_RETIREMENT_IMMUTABLE');END;
CREATE TRIGGER prelaunch_reset_retired_no_delete BEFORE DELETE ON prelaunch_reset_retired_keys BEGIN SELECT RAISE(ABORT,'RESET_RETIREMENT_IMMUTABLE');END;`];
for(const table of [...APP64].sort()){
 const pk=db.prepare('PRAGMA table_info("'+table+'")').all().filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
 if(!pk.length)throw Error('MISSING_PRIMARY_KEY_'+table);
 for(const op of ['INSERT','UPDATE','DELETE']){
  const ref=op==='INSERT'?'NEW':'OLD',key='json_array('+pk.map(k=>ref+'."'+k+'"').join(',')+')';
  sql.push(`CREATE TRIGGER prelaunch_fence_${table}_${op.toLowerCase()} BEFORE ${op} ON "${table}"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.${table}.${op.toLowerCase()}') s WHERE s.value=${key}))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;`);
 }
}
db.close();
const dir='migrations-reset-v1';fs.mkdirSync(dir,{recursive:true});
const file=dir+'/0001_reset_fence.sql';if(fs.existsSync(file))throw Error('VERSIONED_SQL_ALREADY_EXISTS');
const text=sql.join('\n')+'\n';fs.writeFileSync(file,text);fs.writeFileSync('src/lib/prelaunch-reset-schema.js',"// Generated from the independently versioned SQL.\nexport const RESET_V1_SQL_SHA256='"+createHash('sha256').update(text).digest('hex')+"';\n");console.log(JSON.stringify({file,application_tables:64,fence_triggers:192,remote_operations:0}));
