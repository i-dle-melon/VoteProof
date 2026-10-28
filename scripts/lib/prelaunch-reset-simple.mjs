// Operator-only CLI. Reuses the deployed fence, versioned schema and REST
// transport. Never imported by the website; no R2/Drive/deployment operations.
import fs from 'node:fs';
import {digest,stable,ident} from './prelaunch-reset-snapshot.mjs';
import {KEEP64} from './prelaunch-reset-0028.mjs';
import {planSelectiveReset,TARGET19} from './prelaunch-selective-reset.mjs';
import {verifyRecoveryPoint} from './prelaunch-reset-production.mjs';
export {createD1RestTransport} from './prelaunch-reset-rest.mjs';
export const WORKER_SHA='aab87e6dc596344cd346d9338be10e384230603e';
const PRODUCTION_ACCOUNT='7a1ae5a3d1e51008d0880ac526740717',PRODUCTION_D1='9e2b885d-66e2-4e4d-b768-4bded261296a';
const TRANSPORT_PROOF='aa9b5d12990d3031a8e42561bcdc2b201e7365ff094074053f136891813b5679';
const ORDER=['export_completed_files','export_job_items','export_packages','export_jobs','proof_duplicate_requests','proof_duplicate_groups','proof_duplicate_jobs','proof_exact_hashes','proof_backups','cold_proofs','case_idempotency','leaderboard_results','leaderboard_runs','point_transactions','case_files','cases','proof_upload_checksums','completed_upload_files','completed_uploads','proof_upload_intents','admin_audit_logs'];
const EXCEPTIONS={point_transactions:'points_no_delete',leaderboard_runs:'leaderboard_runs_no_delete',leaderboard_results:'leaderboard_results_no_delete',export_job_items:'export_items_no_delete',export_completed_files:'export_completed_no_delete',proof_upload_intents:'final_intent_no_delete',admin_audit_logs:'admin_audit_no_delete',leaderboards:'leaderboards_policy'};
const PROTECTED=[...KEEP64,'d1_migrations','storage_capacity'].sort();
const SCHEMA="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name<>'_cf_KV'";
const sorted=rows=>rows.map(r=>({...r})).sort((a,b)=>stable(a).localeCompare(stable(b)));
const key=(s,n,r)=>JSON.stringify(s.primaryKeys[n].map(k=>r[k]));
const bytes=x=>Buffer.byteLength(typeof x==='string'?x:JSON.stringify(x));
const and=xs=>xs.length===1?xs[0]:'('+and(xs.slice(0,Math.floor(xs.length/2)))+' AND '+and(xs.slice(Math.floor(xs.length/2)))+')';
const assertSQL=c=>`SELECT CASE WHEN (${c}) THEN 'ok' ELSE json_extract('SIMPLE_RESET_GUARD_FAILED','$') END AS reset_check`;
const stmt=(sql,params=[])=>({sql,params});
function safe(x){JSON.stringify(x,(_k,v)=>{if(v!==null&&typeof v==='object'&&v instanceof Uint8Array||typeof v==='number'&&!Number.isSafeInteger(v)||typeof v==='bigint')throw Error('UNSUPPORTED_SNAPSHOT_VALUE');return v;});}
export function simpleCLIIdentity(){const paths=['./prelaunch-reset-simple.mjs','../prelaunch-reset-simple.mjs','./prelaunch-reset-rest.mjs','./prelaunch-selective-reset.mjs'];return digest(Object.fromEntries(paths.map(p=>[p,digest(fs.readFileSync(new URL(p,import.meta.url),'utf8').replace(/\r\n/g,'\n'))])));}
function fingerprints(tables){return Object.fromEntries(PROTECTED.map(n=>{if(!tables[n])throw Error('PROTECTED_TABLE_MISSING');return[n,{count:tables[n].length,sha256:digest(sorted(tables[n]))}];}));}
// Set difference checks every original cell and exact cardinality. It avoids a
// correlated lookup for every historical row and needs no dictionary/JSONB.
function exactTables(tables,param){return and(Object.entries(tables).map(([n,rows])=>{
 if(!rows.length)return`NOT EXISTS(SELECT 1 FROM ${ident(n)})`;
 const fields=Object.keys(rows[0]);return`((SELECT COUNT(*) FROM ${ident(n)})=${rows.length} AND NOT EXISTS(SELECT ${fields.map(f=>ident(f)+' COLLATE BINARY').join(',')} FROM ${ident(n)} EXCEPT SELECT ${fields.map(f=>`json_extract(j.value,'$.${f}') COLLATE BINARY`).join(',')} FROM json_each(${param},'$.${n}') j))`;
}));}
function exactSchema(schema,param){return`((SELECT COUNT(*) FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name<>'_cf_KV')=${schema.length} AND NOT EXISTS(${SCHEMA} EXCEPT SELECT json_extract(value,'$.type'),json_extract(value,'$.name'),json_extract(value,'$.tbl_name'),json_extract(value,'$.sql') FROM json_each(${param})))`;}
const idle=[
 'NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit)',
 "NOT EXISTS(SELECT 1 FROM prelaunch_reset_operations WHERE state<>'completed' OR pending_r2<>0)",
 "NOT EXISTS(SELECT 1 FROM storage_reservations WHERE state='reserved')",
 'NOT EXISTS(SELECT 1 FROM backup_processor_lock)',
 'NOT EXISTS(SELECT 1 FROM export_file_claims)','NOT EXISTS(SELECT 1 FROM export_scope_locks)',
 "NOT EXISTS(SELECT 1 FROM cold_proofs WHERE state IN('verifying','deleting','cold') OR lease_token IS NOT NULL OR lease_until IS NOT NULL)",
 "NOT EXISTS(SELECT 1 FROM proof_upload_intents WHERE write_token IS NOT NULL OR state='deleting')",
 "NOT EXISTS(SELECT 1 FROM proof_backups WHERE status='processing' OR lease_until IS NOT NULL OR (lease_token IS NOT NULL AND status NOT IN('confirmed','failed')))",
 "NOT EXISTS(SELECT 1 FROM export_packages WHERE status='in_progress')",
 'NOT EXISTS(SELECT 1 FROM storage_capacity WHERE inventory_id IS NOT NULL OR inventory_phase IS NOT NULL OR anomaly IS NOT NULL OR reserved_bytes<>0)'
];
function compile(snapshot,manifest,now){
 const c=snapshot.tables.prelaunch_reset_control[0],t=snapshot.tables,selected=manifest.selected;
 if(Object.keys(selected).sort().join('|')!==[...ORDER].sort().join('|'))throw Error('WRITE_SCOPE_NOT_ALLOWLISTED');
 for(const n of [...ORDER,'leaderboards','prelaunch_reset_control','submission_settings','storage_capacity']){const pk=snapshot.primaryKeys[n];if(!pk?.length)throw Error('MISSING_PK');const seen=new Set();for(const row of t[n]){const k=key(snapshot,n,row);if(seen.has(k)||pk.some(f=>row[f]===null||row[f]===undefined))throw Error('NON_UNIQUE_PK');seen.add(k);}}
 const affected=Object.fromEntries([...ORDER,'leaderboards','prelaunch_reset_control','submission_settings','storage_capacity'].map(n=>[n,t[n]]));
 const after=structuredClone(affected),scope={};for(const n of ORDER){const keys=new Set(selected[n].map(r=>key(snapshot,n,r)));scope[n]={delete:[...keys]};after[n]=t[n].filter(r=>!keys.has(key(snapshot,n,r)));}
 after.leaderboards=t.leaderboards.map(r=>{if(!Number.isSafeInteger(r.version+1))throw Error('VERSION_OVERFLOW');return{...r,current_run_id:null,version:r.version+1};});
 if(!Number.isSafeInteger(c.epoch+1)||!Number.isSafeInteger(c.version+1))throw Error('VERSION_OVERFLOW');
 after.prelaunch_reset_control=[{...c,epoch:c.epoch+1,version:c.version+1}];
 scope.leaderboards={update:t.leaderboards.map(r=>key(snapshot,'leaderboards',r))};
 const id='selective-reset:'+c.run_id;scope.storage_audit={insert:[JSON.stringify([id])]};
 const preserved=fingerprints(t),cli=simpleCLIIdentity(),receipt={id:c.run_id,created_at:now,action:'reset_commit',detail:stable({manifest:manifest.sha256,source_hash:snapshot.hash,old_epoch:c.epoch,next_epoch:c.epoch+1,protected_sha256:digest(preserved),cli_sha256:cli,r2_deleted:false})};
 const audit={id,created_at:Math.floor(Date.parse(now)/1000),action:'prelaunch_selective_reset',target:c.run_id,detail:stable({manifest:manifest.sha256,counts:manifest.counts,r2_deleted:false,old_delete:'UNKNOWN',dispatch9:'HOLD'})};
 const ss=[],add=(sql,params=[])=>ss.push(stmt(sql,params)),checks=[];
 add('PRAGMA defer_foreign_keys=ON');checks.push(ss.length);add(assertSQL(and([exactTables(affected,'?1'),exactSchema(snapshot.schema,'?2'),...idle])),[JSON.stringify(affected),JSON.stringify(snapshot.schema)]);
 add("INSERT INTO prelaunch_reset_permit(id,epoch,operation_id,purpose,scope_json,run_id) VALUES(1,?,NULL,'reset',?,?)",[c.epoch,JSON.stringify(scope),c.run_id]);
 const guards=Object.entries(EXCEPTIONS).filter(([n])=>n==='leaderboards'?t[n].length:selected[n].length).map(([,name])=>snapshot.schema.find(s=>s.type==='trigger'&&s.name===name));if(guards.some(g=>!g))throw Error('GUARD_DEFINITION_MISSING');
 for(const g of guards)add('DROP TRIGGER '+ident(g.name));
 if(t.leaderboards.length)add('UPDATE leaderboards SET current_run_id=NULL,version=version+1 WHERE EXISTS(SELECT 1 FROM json_each(?) j WHERE leaderboards.leaderboard_id=json_extract(j.value,\'$[0]\'))',[JSON.stringify(t.leaderboards.map(r=>[r.leaderboard_id]))]);
 if(manifest.keys.length)add('INSERT INTO prelaunch_reset_retired_keys(object_key,epoch,run_id) SELECT value,?,? FROM json_each(?)',[c.epoch,c.run_id,JSON.stringify(manifest.keys)]);
 for(const n of ORDER)if(selected[n].length){const pk=snapshot.primaryKeys[n];add(`DELETE FROM ${ident(n)} WHERE EXISTS(SELECT 1 FROM json_each(?) j WHERE ${pk.map((f,i)=>`${ident(n)}.${ident(f)} IS json_extract(j.value,'$[${i}]')`).join(' AND ')})`,[JSON.stringify(selected[n].map(r=>pk.map(f=>r[f])))]);}
 for(const g of guards)add(g.sql);
 add('INSERT INTO storage_audit(id,created_at,action,target,detail) VALUES(?,?,?,?,?)',Object.values(audit));
 add('INSERT INTO prelaunch_reset_audit(id,created_at,action,detail) VALUES(?,?,?,?)',Object.values(receipt));
 add("UPDATE prelaunch_reset_control SET epoch=epoch+1,version=version+1 WHERE id=1 AND epoch=? AND version=? AND mode='maintenance' AND run_id=?",[c.epoch,c.version,c.run_id]);
 add('DELETE FROM prelaunch_reset_permit WHERE id=1 AND epoch=? AND run_id=?',[c.epoch,c.run_id]);
 const post=stmt(assertSQL(and([exactTables(after,'?1'),exactSchema(snapshot.schema,'?2'),'NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit)','NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)',
  `(SELECT COUNT(*) FROM prelaunch_reset_retired_keys)=${t.prelaunch_reset_retired_keys.length+manifest.keys.length}`,
  "NOT EXISTS(SELECT 1 FROM json_each(?3) j WHERE NOT EXISTS(SELECT 1 FROM prelaunch_reset_retired_keys r WHERE r.object_key=j.value AND r.epoch=?4 AND r.run_id=?5))",
  'EXISTS(SELECT 1 FROM prelaunch_reset_audit WHERE id=?5 AND created_at=?6 AND action=\'reset_commit\' AND detail=?7)',
  'EXISTS(SELECT 1 FROM storage_audit WHERE id=?8 AND detail=?9)'
 ])),[JSON.stringify(after),JSON.stringify(snapshot.schema),JSON.stringify(manifest.keys),c.epoch,c.run_id,now,receipt.detail,audit.id,audit.detail]);checks.push(ss.length);add(post.sql,post.params);
 const bodyBytes=bytes({batch:ss});if(bodyBytes>2000000||ss.some(s=>bytes(s.sql)>100000||s.params.length>100||s.params.some(p=>typeof p==='string'&&bytes(p)>2000000)))throw Error('SIMPLE_REST_D1_LIMIT_HOLD');
 return{format:'simple-selective-reset-v1',cli_sha256:cli,worker_sha:WORKER_SHA,source_hash:snapshot.hash,manifest_sha256:manifest.sha256,run_id:c.run_id,epoch:c.epoch,statements:ss,assertion_indices:checks,statement_count:ss.length,transaction_count:1,split_batches:false,body_bytes:bodyBytes,max_sql_bytes:Math.max(...ss.map(s=>bytes(s.sql))),protected_before:preserved,receipt,postcondition:post,restored_guard_names:guards.map(g=>g.name),physical_r2_delete:false};
}
export function prepareSimpleReset(snapshot,manifest,{approvedManifestHash,recovery,approvedCutoverHash,now=new Date().toISOString()}={}){
 const{hash,...source}=snapshot,{sha256,status,...m}=manifest;
 if(digest(source)!==hash)throw Error('SOURCE_HASH_MISMATCH');safe(snapshot.tables);
 if(sha256!==approvedManifestHash||digest(m)!==sha256||manifest.source_hash!==hash||manifest.blockers.length)throw Error('EXACT_MANIFEST_REQUIRED');
 const reviewed=planSelectiveReset(snapshot,manifest.scope,manifest.evidence,{approvedCutoverHash});if(reviewed.sha256!==sha256)throw Error('SCOPE_OR_FK_CLOSURE_CHANGED');
 if(TARGET19.some(n=>manifest.selected[n].length!==snapshot.tables[n].length))throw Error('MIXED_TARGET_TABLE');
 if(manifest.keys.some(k=>snapshot.tables.prelaunch_reset_retired_keys.some(r=>r.object_key===k)))throw Error('RETIRED_KEY_STILL_REFERENCED');
 if(!Number.isFinite(Date.parse(now)))throw Error('INVALID_EXECUTION_TIME');
 const restore=verifyRecoveryPoint(snapshot,recovery),p={...compile(snapshot,manifest,now),account:restore.account,database:restore.source_database,restore,synthetic:recovery.platform==='native-synthetic'};
 return{...p,sha256:digest(p)};
}
export function measureSimpleReset(snapshot,manifest){const p=compile(snapshot,manifest,'2000-01-01T00:00:00.000Z');return{scope:'OFFLINE_SIZING_NOT_EXECUTION_AUTHORITY',body_bytes:p.body_bytes,statements:p.statement_count,max_sql_bytes:p.max_sql_bytes,protected_tables:PROTECTED.length,historical_payload:false};}
function check(p,options){const{sha256,...body}=p;if(digest(body)!==sha256||options.approvedPreparedHash!==sha256||options.approvedManifestHash!==p.manifest_sha256||p.cli_sha256!==simpleCLIIdentity())throw Error('EXACT_SIMPLE_PLAN_AND_CLI_REQUIRED');}
async function protectedCheck(p,transport){const r=await transport.query(PROTECTED.map(n=>stmt('SELECT * FROM '+ident(n))));if(r.length!==PROTECTED.length||r.some(x=>x.success!==true||!Array.isArray(x.results)))throw Error('PROTECTED_READ_UNKNOWN');const actual=fingerprints(Object.fromEntries(PROTECTED.map((n,i)=>[n,r[i].results])));if(digest(actual)!==digest(p.protected_before))throw Error('PROTECTED_IDENTITY_OR_SETTINGS_CHANGED');return digest(actual);}
function authority(p,o,readonly=false){
 if(o.mode==='local-synthetic'&&o.transport?.kind==='local-synthetic-rest')return;
 const a=o.authority,scope=readonly?'production-simple-reset-reconcile':'production-simple-reset-once';
 if(o.mode!=='execute'||o.transport?.kind!=='cloudflare-rest'||p.synthetic||p.account!==PRODUCTION_ACCOUNT||p.database!==PRODUCTION_D1||a?.scope!==scope||a.prepared_sha256!==p.sha256||a.manifest_sha256!==p.manifest_sha256||a.cli_sha256!==p.cli_sha256||a.worker_sha!==WORKER_SHA||a.account!==p.account||a.database!==p.database||o.transport.account!==p.account||o.transport.database!==p.database||!a.operator_approval_reference||!(Date.parse(a.expires_utc)>Date.now()))throw Error('EXPLICIT_SIMPLE_PRODUCTION_AUTHORITY_REQUIRED');
 const prior=JSON.parse(fs.readFileSync(new URL('../../test/fixtures/reset-rest-atomic-proof.json',import.meta.url),'utf8'));if(digest(prior)!==TRANSPORT_PROOF)throw Error('VERIFIED_REST_TRANSPORT_PROOF_REQUIRED');
 const proof=o.simpleProof;if(!proof||digest(proof)!==a.simple_proof_sha256||proof.format!=='simple-reset-sql-cloud-proof-v1'||proof.cli_sha256!==p.cli_sha256||proof.transport_proof_sha256!==TRANSPORT_PROOF||proof.status!=='PASS'||proof.rollback!=='PASS'||proof.lost_ack!=='PASS'||!/^[-a-f0-9]{36}$/.test(proof.database??'')||proof.database===p.database)throw Error('SIMPLE_SQL_CLOUD_DELTA_PROOF_REQUIRED');
 const frozen=o.freeze;if(!frozen||digest(frozen)!==a.freeze_sha256||frozen.account!==p.account||frozen.database!==p.database||frozen.worker_sha!==WORKER_SHA||frozen.mode!=='maintenance'||frozen.gate!==0||frozen.scripts_paused!==true||frozen.unresolved_operations!==0||frozen.external_control_window!=='OPERATOR_EXCLUSIVE_NO_WRITES'||Date.now()-Date.parse(frozen.collected_utc)>300000||!(Date.parse(frozen.collected_utc)<=Date.now()))throw Error('FRESH_APPROVED_FREEZE_REQUIRED');
 if(!readonly){const r=verifyRecoveryPoint({hash:p.source_hash},o.recovery);if(r.account!==p.account||r.source_database!==p.database||r.artifact_sha256!==p.restore.artifact_sha256||r.platform==='native-synthetic')throw Error('FRESH_PRIVATE_RESTORE_REQUIRED');}
}
function journal(file,event,first=false){const fd=fs.openSync(file,first?'wx':'a');try{fs.writeFileSync(fd,stable(event)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function validateSimpleExecution(p,o,readonly=false){check(p,o);authority(p,o,readonly);}
export async function executeSimpleReset(p,o={}){
 check(p,o);if((o.mode??'dry-run')==='dry-run')return{status:'DRY_RUN',statement_count:p.statement_count,body_bytes:p.body_bytes,worker_sha:p.worker_sha,cli_sha256:p.cli_sha256,production_authorized:false};
 authority(p,o);if(!o.journalFile||fs.existsSync(o.journalFile))throw Error('EXISTING_JOURNAL_NO_RESEND');
 await protectedCheck(p,o.transport);const event={prepared_sha256:p.sha256,manifest_sha256:p.manifest_sha256,status:'DISPATCHED',utc:new Date().toISOString(),attempts:1};journal(o.journalFile,event,true);
 try{const r=await o.transport.query(p.statements);if(r.length!==p.statement_count||r.some(x=>x.success!==true)||p.assertion_indices.some(i=>r[i].results?.[0]?.reset_check!=='ok'))throw Error('ACK_UNKNOWN');const result=await verifyCommit(p,o);journal(o.journalFile,{...event,status:'COMMITTED',receipt_sha256:result.receipt_sha256});return result;}
 catch{journal(o.journalFile,{...event,status:'UNKNOWN',automatic_retry:false});throw Error('SIMPLE_RESET_UNKNOWN_STOP_NO_RETRY');}
}
export async function reconcileSimpleReset(p,o){check(p,o);authority(p,o,true);return verifyCommit(p,o);}
async function verifyCommit(p,o){
 check(p,o);
 if(!o.journalFile||!fs.existsSync(o.journalFile))throw Error('EXISTING_JOURNAL_REQUIRED');const events=fs.readFileSync(o.journalFile,'utf8').trim().split('\n').map(JSON.parse);if(events.some(e=>e.prepared_sha256!==p.sha256||e.manifest_sha256!==p.manifest_sha256))throw Error('JOURNAL_PLAN_MISMATCH');
 const r=await o.transport.query([p.postcondition,stmt('SELECT id,created_at,action,detail FROM prelaunch_reset_audit WHERE id=?',[p.run_id])]);if(r.some(x=>x.success!==true)||r[0]?.results?.[0]?.reset_check!=='ok'||r[1]?.results?.length!==1||stable(r[1].results[0])!==stable(p.receipt))throw Error('COMMIT_RECEIPT_OR_POSTCONDITION_UNKNOWN');
 const protectedHash=await protectedCheck(p,o.transport);return{status:'COMMIT_VERIFIED',receipt_sha256:digest(r[1].results[0]),protected_sha256:protectedHash,epoch:p.epoch+1,r2_deleted:false};
}
