// Prepared atomic reset executor. No network client and no automatic retry.
// A Cloudflare adapter is deliberately not selected by this module: its atomic
// semantics must be proved in the isolated D1 before Production is eligible.
import fs from 'node:fs';
import {digest,stable,ident}from'./prelaunch-reset-snapshot.mjs';
import {TARGET19}from'./prelaunch-selective-reset.mjs';
const EXCEPTIONS=['points_no_delete','leaderboard_runs_no_delete','leaderboard_results_no_delete','export_items_no_delete','export_completed_no_delete','final_intent_no_delete','admin_audit_no_delete','leaderboards_policy'];
const ORDER=['export_completed_files','export_job_items','export_packages','export_jobs','proof_duplicate_requests','proof_duplicate_groups','proof_duplicate_jobs','proof_exact_hashes','proof_backups','cold_proofs','case_idempotency','leaderboard_results','leaderboard_runs','point_transactions','case_files','cases','proof_upload_checksums','completed_upload_files','completed_uploads','proof_upload_intents','admin_audit_logs'];
const clone=x=>JSON.parse(JSON.stringify(x)),key=(s,n,r)=>JSON.stringify(s.primaryKeys[n].map(k=>r[k]));
const assertSQL=condition=>`SELECT CASE WHEN (${condition}) THEN 'ok' ELSE json_extract('RESET_PRECONDITION_FAILED','$') END AS reset_check`;
// D1 limits expression depth to 100. Preserve every predicate while avoiding
// a left-deep AND chain across all 72 tables plus each table's full row fields.
const and=xs=>xs.length===1?xs[0]:'('+and(xs.slice(0,Math.floor(xs.length/2)))+' AND '+and(xs.slice(Math.floor(xs.length/2)))+')';
function tablesCondition(tables,param){
 return and(Object.entries(tables).map(([name,rows])=>{
  const table=ident(name),jsonPath='$.'+name;
  if(!rows.length)return`NOT EXISTS(SELECT 1 FROM ${table})`;
  const fields=Object.keys(rows[0]);fields.forEach(ident);
  const equal=and(fields.map(k=>`a.${ident(k)} IS json_extract(j.value,'$.${k}')`));
  return`(SELECT COUNT(*) FROM ${table})=${rows.length} AND NOT EXISTS(SELECT 1 FROM json_each(${param},'${jsonPath}') j WHERE NOT EXISTS(SELECT 1 FROM ${table} a WHERE ${equal}))`;
 }).map(x=>'('+x+')'));
}
function schemaCondition(schema,param){
 const where="sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name<>'_cf_KV'";
 return`(SELECT COUNT(*) FROM sqlite_schema WHERE ${where})=${schema.length} AND NOT EXISTS(SELECT 1 FROM json_each(${param}) j WHERE NOT EXISTS(SELECT 1 FROM sqlite_schema s WHERE s.type=json_extract(j.value,'$.type') AND s.name=json_extract(j.value,'$.name') AND s.tbl_name=json_extract(j.value,'$.tbl_name') AND s.sql IS json_extract(j.value,'$.sql')))`;
}
function safeJSON(x){JSON.stringify(x,(_k,v)=>{if(typeof v==='number'&&!Number.isSafeInteger(v)||typeof v==='bigint'||v instanceof Uint8Array)throw Error('UNSUPPORTED_SNAPSHOT_VALUE');return v;});}
export function verifyRecoveryPoint(snapshot,record){
 if(!record||!record.artifact_path||!fs.existsSync(record.artifact_path))throw Error('PRIVATE_RESTORE_ARTIFACT_REQUIRED');
 const bytes=fs.readFileSync(record.artifact_path);
 if(record.artifact_sha256!==digest(bytes)||record.source_hash!==snapshot.hash||record.restored_source_hash!==snapshot.hash)throw Error('RESTORE_POINT_HASH_OR_RESTORE_PROOF_MISMATCH');
 if(!record.created_utc||!Number.isFinite(Date.parse(record.created_utc))||Date.now()-Date.parse(record.created_utc)>300000||Date.parse(record.created_utc)>Date.now()+1000)throw Error('RESTORE_POINT_NOT_FRESH');
 if(!record.source_database||!record.account||!record.restore_receipt_sha256||!/^[a-f0-9]{64}$/.test(record.restore_receipt_sha256))throw Error('RESTORE_POINT_IDENTITY_REQUIRED');
 if(record.platform!=='native-synthetic'&&(!record.time_travel_bookmark_sha256||!/^[a-f0-9]{64}$/.test(record.time_travel_bookmark_sha256)))throw Error('PRIVATE_FRESH_TIME_TRAVEL_EVIDENCE_REQUIRED');
 return{platform:record.platform,artifact_sha256:record.artifact_sha256,source_hash:record.source_hash,source_database:record.source_database,account:record.account,created_utc:record.created_utc,restore_receipt_sha256:record.restore_receipt_sha256};
}
export function prepareAtomicReset(snapshot,manifest,{approvedManifestHash,recovery,now=new Date().toISOString()}={}){
 const{sha256,status,...body}=manifest;
 if(sha256!==approvedManifestHash||digest(body)!==sha256)throw Error('EXACT_APPROVED_MANIFEST_HASH_REQUIRED');
 if(manifest.blockers?.length||manifest.source_hash!==snapshot.hash||!manifest.run_id)throw Error('MANIFEST_HOLD_OR_STALE_SOURCE');
 if(!Number.isFinite(Date.parse(now)))throw Error('INVALID_EXECUTION_TIME');
 safeJSON(snapshot.tables);const restore=verifyRecoveryPoint(snapshot,recovery),c=snapshot.tables.prelaunch_reset_control?.[0];
 if(c?.mode!=='maintenance'||c.run_id!==manifest.run_id||c.epoch!==manifest.epoch||c.version!==manifest.control_version||snapshot.tables.submission_settings[0]?.submissions_enabled!==0)throw Error('EXACT_MAINTENANCE_CAS_REQUIRED');
 if(snapshot.tables.prelaunch_reset_operations.some(r=>r.state!=='completed'||r.pending_r2)||snapshot.tables.prelaunch_reset_permit.length)throw Error('UNKNOWN_OR_ACTIVE_OPERATION');
 for(const name of TARGET19)if(manifest.selected[name].length!==snapshot.tables[name].length)throw Error('MIXED_TARGET_TABLE_OUTSIDE_MANIFEST');
 const exceptions=EXCEPTIONS.map(n=>snapshot.schema.find(s=>s.type==='trigger'&&s.name===n));if(exceptions.some(x=>!x))throw Error('GUARD_DEFINITION_MISSING');
 const expected=clone(snapshot.tables),permitScope={};for(const[n,rows]of Object.entries(manifest.selected)){
  const keys=new Set(rows.map(r=>key(snapshot,n,r)));if(keys.size!==rows.length)throw Error('DUPLICATE_MANIFEST_PK');
  permitScope[n]={delete:[...keys]};expected[n]=expected[n].filter(r=>!keys.has(key(snapshot,n,r)));
 }
 permitScope.leaderboards={update:snapshot.tables.leaderboards.map(r=>key(snapshot,'leaderboards',r))};
 const storageId='selective-reset:'+manifest.run_id;permitScope.storage_audit={insert:[JSON.stringify([storageId])]};
 expected.leaderboards=expected.leaderboards.map(r=>({...r,current_run_id:null,version:r.version+1}));
 expected.prelaunch_reset_control=[{...c,epoch:c.epoch+1,version:c.version+1}];
 for(const objectKey of manifest.keys)expected.prelaunch_reset_retired_keys.push({object_key:objectKey,epoch:c.epoch,run_id:c.run_id});
 const storageAudit={id:storageId,created_at:Math.floor(Date.parse(now)/1000),action:'prelaunch_selective_reset',target:c.run_id,detail:stable({manifest:sha256,counts:manifest.counts,r2_deleted:false,old_delete:'UNKNOWN',dispatch9:'HOLD'})};
 const resetAudit={id:c.run_id,created_at:now,action:'reset_commit',detail:stable({manifest:sha256,old_epoch:c.epoch,next_epoch:c.epoch+1})};
 expected.storage_audit.push(storageAudit);expected.prelaunch_reset_audit.push(resetAudit);
 const statements=[],add=(sql,params=[])=>statements.push({sql,params});
 add('PRAGMA defer_foreign_keys=ON');
 add(assertSQL(tablesCondition(snapshot.tables,'?1')+' AND '+schemaCondition(snapshot.schema,'?2')),[JSON.stringify(snapshot.tables),JSON.stringify(snapshot.schema)]);
 add("INSERT INTO prelaunch_reset_permit(id,epoch,operation_id,purpose,scope_json,run_id) VALUES(1,?,NULL,'reset',?,?)",[c.epoch,JSON.stringify(permitScope),c.run_id]);
 for(const t of exceptions)add('DROP TRIGGER '+ident(t.name));
 add('UPDATE leaderboards SET current_run_id=NULL,version=version+1 WHERE EXISTS(SELECT 1 FROM json_each(?) j WHERE leaderboards.leaderboard_id=json_extract(j.value,\'$[0]\'))',[JSON.stringify(snapshot.tables.leaderboards.map(r=>[r.leaderboard_id]))]);
 add('INSERT INTO prelaunch_reset_retired_keys(object_key,epoch,run_id) SELECT value,?,? FROM json_each(?)',[c.epoch,c.run_id,JSON.stringify(manifest.keys)]);
 for(const n of ORDER){const fields=snapshot.primaryKeys[n];if(!fields.length)throw Error('MISSING_PK');
  const match=fields.map((f,i)=>`${ident(n)}.${ident(f)} IS json_extract(j.value,'$[${i}]')`).join(' AND ');
  add(`DELETE FROM ${ident(n)} WHERE EXISTS(SELECT 1 FROM json_each(?) j WHERE ${match})`,[JSON.stringify(manifest.selected[n].map(r=>fields.map(f=>r[f])))]);
 }
 for(const t of exceptions)add(t.sql);
 add('INSERT INTO storage_audit(id,created_at,action,target,detail) VALUES(?,?,?,?,?)',Object.values(storageAudit));
 add('INSERT INTO prelaunch_reset_audit(id,created_at,action,detail) VALUES(?,?,?,?)',Object.values(resetAudit));
 add("UPDATE prelaunch_reset_control SET epoch=epoch+1,version=version+1 WHERE id=1 AND epoch=? AND version=? AND mode='maintenance' AND run_id=?",[c.epoch,c.version,c.run_id]);
 add('DELETE FROM prelaunch_reset_permit WHERE id=1 AND epoch=? AND run_id=?',[c.epoch,c.run_id]);
 add(assertSQL(tablesCondition(expected,'?1')+' AND '+schemaCondition(snapshot.schema,'?2')),[JSON.stringify(expected),JSON.stringify(snapshot.schema)]);
 add(assertSQL('NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)'));
 if(statements.length>50||statements.some(s=>Buffer.byteLength(s.sql)>100000)||Buffer.byteLength(JSON.stringify(statements))>2000000)throw Error('ATOMIC_REQUEST_EXCEEDS_PLANNED_BOUNDS');
 const holds=[];if(recovery.platform==='native-synthetic'||manifest.evidence?.legacy_io==='LOCAL_SYNTHETIC_ALL_INVOCATIONS_ENDED')holds.push('SYNTHETIC_EVIDENCE_IS_NOT_PRODUCTION_AUTHORITY');
 holds.push('CLOUD_D1_ATOMIC_DDL_ROLLBACK_NOT_PROVEN','OLD_DELETE_KEYSPACE_ISOLATION_NOT_PROVEN','NEW_RELEASE_CI_AND_DEPLOYMENT_NOT_APPROVED');
 const prepared={format:'prepared-atomic-reset-v1',manifest_sha256:sha256,source_hash:snapshot.hash,run_id:c.run_id,epoch:c.epoch,database:restore.source_database,account:restore.account,restore,statements,statement_count:statements.length,transaction_count:1,split_batches:false,postcondition_expected_sha256:digest(expected),holds};
 return{...prepared,sha256:digest(prepared)};
}
export async function executePreparedReset(prepared,{mode='dry-run',transport,journalFile,authority}={}){
 const{sha256,...body}=prepared;if(digest(body)!==sha256)throw Error('PREPARED_PAYLOAD_HASH_MISMATCH');
 if(mode==='dry-run')return{status:'DRY_RUN',manifest_sha256:prepared.manifest_sha256,prepared_sha256:sha256,statements:prepared.statement_count,transactions:1,holds:prepared.holds};
 const native=mode==='execute-native-synthetic'&&authority==='LOCAL_SYNTHETIC_ONLY'&&transport?.kind==='native-synthetic';
 const isolated=mode==='execute-isolated-cloud'&&authority==='AUTHORIZED_ISOLATED_TEST'&&transport?.kind==='cloudflare-isolated';
 if(isolated){const r=transport.creationReceipt,denied=new Set(['9e2b885d-66e2-4e4d-b768-4bded261296a','8ecaa409-1548-4670-a3e0-7b430882a9e8','e27caf07-c5d7-4acf-8472-cca2a945349f']);if(!r||r.account!==prepared.account||r.database_uuid!==prepared.database||denied.has(r.database_uuid)||!/^voteproof-(?:archive-canary-)?test-/.test(r.database_name)||!/^voteproof-(?:archive-canary-)?test-/.test(r.worker_name)||!r.created_utc)throw Error('ISOLATED_CREATION_RECEIPT_REQUIRED');}
 if(!native&&!isolated)throw Error('PRODUCTION_EXECUTION_HOLD_CLOUD_PROOF_AND_AUTHORITY_REQUIRED');
 if(!journalFile||fs.existsSync(journalFile))throw Error('EXISTING_JOURNAL_REQUIRES_READONLY_RECONCILIATION');
 const write=(data,initial=false)=>{const fd=fs.openSync(journalFile,initial?'wx':'w');try{fs.writeFileSync(fd,stable(data)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 const state={prepared_sha256:sha256,manifest_sha256:prepared.manifest_sha256,status:'DISPATCHED',sent_at:new Date().toISOString(),attempts:1};
 // Persist before dispatch; an unknown response can never cause automatic resend.
 write(state,true);
 try{const result=await transport.batch(prepared.statements);write({...state,status:'COMMITTED',response_sha256:digest(result)});return{status:native?'NATIVE_COMMITTED':'ISOLATED_CLOUD_COMMITTED',statements:prepared.statement_count,cloud:native?'UNKNOWN':'ISOLATED_ONLY'};}
 catch(error){write({...state,status:'UNKNOWN',automatic_retry:false});throw Error('RESET_ACK_UNKNOWN_STOP_AND_RECONCILE');}
}
