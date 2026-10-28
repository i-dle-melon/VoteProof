// Native/offline execution only; no remote write client. The same manifest is
// suitable for review, not authorization to execute against Cloudflare.
import fs from 'node:fs';
import { APP64,KEEP64 } from './prelaunch-reset-0028.mjs';
import { digest,stable,ident } from './prelaunch-reset-snapshot.mjs';
import {verifyProductionCutover}from'./prelaunch-reset-cutover-evidence.mjs';
export const TARGET19=['cases','case_files','case_idempotency','point_transactions','leaderboard_results','leaderboard_runs','completed_uploads','completed_upload_files','proof_upload_checksums','proof_upload_intents','proof_exact_hashes','proof_duplicate_requests','proof_duplicate_groups','proof_duplicate_jobs','proof_backups','export_completed_files','export_job_items','export_packages','export_jobs'];
export const EXTRA_KEEP=['backup_admin_audit','backup_processor_lock','drive_backup_folders','drive_quota_snapshots','export_file_claims','export_operation_audit','export_scope_locks','storage_alert_deliveries','storage_alerts','storage_audit','storage_history','storage_reservations','storage_capacity'];
const sorted=rows=>rows.map(r=>({...r})).sort((a,b)=>stable(a).localeCompare(stable(b)));
const shaSchema=rows=>digest(rows.map(r=>({...r,sql:r.sql?.replace(/\r\n/g,'\n')})));
export function installResetExtensionLocal(db,sql){
 // Git may check this versioned SQL out as CRLF on Windows. Fingerprint the
 // normalized source, matching the Runtime constant and the reviewed Git blob.
 const hash=digest(sql.replace(/\r\n/g,'\n'));db.exec('BEGIN IMMEDIATE');
 try{db.exec(sql);db.prepare('INSERT INTO prelaunch_reset_schema_versions VALUES(1,?,?)').run(hash,new Date().toISOString());db.exec('COMMIT');return{version:1,sql_sha256:hash,cloud:'UNKNOWN'};}catch(e){db.exec('ROLLBACK');throw e;}
}
export function snapshotReset(db){
 const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name<>'_cf_KV' ORDER BY type,name").all().map(r=>({...r}));
 const names=schema.filter(r=>r.type==='table').map(r=>r.name);
 const apps=names.filter(n=>n!=='d1_migrations'&&!n.startsWith('prelaunch_reset_'));
 if(apps.length!==64||apps.some(n=>!APP64.has(n)))throw Error('SCHEMA_NOT_0028_BASE');
 const tables={},primaryKeys={},foreignKeys={};
 for(const name of names){ident(name);tables[name]=sorted(db.prepare('SELECT * FROM '+ident(name)).all());primaryKeys[name]=db.prepare('PRAGMA table_info('+ident(name)+')').all().filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);foreignKeys[name]=db.prepare('PRAGMA foreign_key_list('+ident(name)+')').all().map(r=>({...r}));}
 const body={schema,tables,primaryKeys,foreignKeys};return{...body,hash:digest(body)};
}
const key=(snapshot,table,row)=>JSON.stringify(snapshot.primaryKeys[table].map(k=>row[k]));
export function candidateScope(snapshot){return{
 case_ids:snapshot.tables.cases.map(r=>r.id),session_ids:[...new Set([...snapshot.tables.completed_uploads,...snapshot.tables.proof_upload_intents].map(r=>r.session_id))],
 transaction_ids:snapshot.tables.point_transactions.map(r=>r.transaction_id),run_ids:snapshot.tables.leaderboard_runs.map(r=>r.run_id),export_job_ids:snapshot.tables.export_jobs.map(r=>r.id)
};}

export function planSelectiveReset(snapshot,scope=candidateScope(snapshot),evidence={},options={}){
 const t=snapshot.tables,blockers=[],selected=Object.fromEntries([...TARGET19,'cold_proofs','admin_audit_logs'].map(n=>[n,[]]));
 const c=new Set(scope.case_ids),u=new Set(scope.session_ids),tx=new Set(scope.transaction_ids),runs=new Set(scope.run_ids),exports=new Set(scope.export_job_ids);
 selected.cases=t.cases.filter(r=>c.has(r.id));selected.cases.forEach(r=>u.add(r.upload_session_id));
 selected.case_files=t.case_files.filter(r=>c.has(r.case_id));const fileIds=new Set(selected.case_files.map(r=>r.id));
 selected.case_idempotency=t.case_idempotency.filter(r=>c.has(r.case_id));
 selected.point_transactions=t.point_transactions.filter(r=>tx.has(r.transaction_id));
 for(const r of selected.point_transactions)if(r.case_id&&!c.has(r.case_id))blockers.push('MIXED_LEDGER_CASE');
 selected.leaderboard_runs=t.leaderboard_runs.filter(r=>runs.has(r.run_id));selected.leaderboard_results=t.leaderboard_results.filter(r=>runs.has(r.run_id));
 selected.proof_upload_intents=t.proof_upload_intents.filter(r=>u.has(r.session_id)||c.has(r.consumed_case_id));selected.proof_upload_intents.forEach(r=>u.add(r.session_id));
 selected.completed_uploads=t.completed_uploads.filter(r=>u.has(r.session_id));
 selected.completed_upload_files=t.completed_upload_files.filter(r=>u.has(r.session_id));
 const keys=new Set([...selected.case_files.map(r=>r.object_key),...selected.case_files.map(r=>r.upload_object_key),...selected.completed_upload_files.map(r=>r.object_key),...selected.proof_upload_intents.map(r=>r.object_key)].filter(Boolean));
 selected.proof_upload_checksums=t.proof_upload_checksums.filter(r=>keys.has(r.object_key));
 for(const table of ['proof_exact_hashes','proof_duplicate_jobs','proof_duplicate_requests','proof_backups'])selected[table]=t[table].filter(r=>fileIds.has(r.file_id));
 selected.proof_duplicate_groups=t.proof_duplicate_groups.filter(r=>fileIds.has(r.canonical_file_id));
 selected.export_jobs=t.export_jobs.filter(r=>exports.has(r.id));
 for(const table of ['export_packages','export_job_items','export_completed_files'])selected[table]=t[table].filter(r=>exports.has(r.job_id));
 if(selected.export_job_items.some(r=>!fileIds.has(r.file_id)))blockers.push('MIXED_OR_UNRESOLVED_EXPORT_SNAPSHOT');
 selected.cold_proofs=t.cold_proofs.filter(r=>fileIds.has(r.file_id)&&['blocked','dry_run'].includes(r.state)&&!r.lease_token&&!r.lease_until);
 const auditCaseIds=new Set(selected.cases.flatMap(r=>[r.id,r.case_id]));
 const runBoards=new Map(selected.leaderboard_runs.map(r=>[r.run_id,r.leaderboard_id]));
 selected.admin_audit_logs=t.admin_audit_logs.filter(r=>{
  if(r.target_type==='case')return auditCaseIds.has(r.target_id);
  if(r.target_type==='point_transaction')return tx.has(r.target_id);
  if(r.action!=='leaderboard_rebuild')return false;
  let after;try{after=JSON.parse(r.after_json);}catch{blockers.push('MALFORMED_REBUILD_AUDIT');return false;}
  if(!runs.has(after?.run_id))return false;
  if(r.target_type!=='leaderboard'||runBoards.get(after.run_id)!==r.target_id){blockers.push('MIXED_REBUILD_AUDIT');return false;}
  return true;
 });
 const control=t.prelaunch_reset_control?.[0];
 if(!control||t.prelaunch_reset_schema_versions?.length!==1)blockers.push('RESET_EXTENSION_NOT_INSTALLED');
 if(control?.mode!=='maintenance'||!control.run_id)blockers.push('NOT_IN_REVIEWED_MAINTENANCE');
 if(t.submission_settings[0]?.submissions_enabled!==0)blockers.push('SUBMISSIONS_NOT_PAUSED');
 let productionEvidence=false;
 if(evidence.legacy_io==='UNKNOWN_ISOLATED_RETAINED_OLD_KEYS'){
  try{verifyProductionCutover(snapshot,evidence.cutover,options.approvedCutoverHash);productionEvidence=true;}catch(error){blockers.push(error.message);}
 }else if(evidence.legacy_io!=='LOCAL_SYNTHETIC_ALL_INVOCATIONS_ENDED')blockers.push('UNTRACKED_LEGACY_IO_REMAINS_UNKNOWN');
 if(evidence.image_bypass_closed!==true)blockers.push('PUBLIC_R2_BYPASS_UNVERIFIED');
 const unfinished=[];
 for(const [table,rows] of Object.entries(t))for(const row of rows){
  let why=null;
  if(table==='prelaunch_reset_operations'&&row.state!=='completed')why='operation_'+row.state;
  else if(table==='storage_reservations'&&row.state==='reserved')why='reserved';
  else if(table==='storage_capacity'&&(row.inventory_id||row.inventory_phase||row.anomaly||row.reserved_bytes))why='inventory_or_capacity_pending';
  else if(table==='backup_processor_lock')why='backup_lock';
  else if(['export_file_claims','export_scope_locks'].includes(table))why='export_claim_or_scope_lock';
  else if(table==='cold_proofs'&&(['verifying','deleting','cold'].includes(row.state)||row.lease_token||row.lease_until))why='cold_pin';
  else if(table==='proof_upload_intents'&&(row.write_token||row.state==='deleting'))why='intent_writer_or_delete';
  else if(table==='proof_backups'&&(row.status==='processing'||row.lease_until!=null||row.lease_token&&!['confirmed','failed'].includes(row.status)))why='backup_processing';
  else if(table==='export_packages'&&row.status==='in_progress')why='export_in_progress';
  else if(TARGET19.includes(table)&&Object.entries(row).some(([name,value])=>/state|status|error_code/.test(name)&&typeof value==='string'&&/unknown|ambiguous|lost.?ack|processing|leased|in_progress/i.test(value)))why='unknown_or_leased';
  if(why)unfinished.push({table,key:key(snapshot,table,row),reason:why});
 }
 if(unfinished.length)blockers.push('UNRESOLVED_WORK_OR_UNKNOWN_ACK');
 if(t.prelaunch_reset_permit?.length)blockers.push('UNEXPECTED_PERSISTENT_PERMIT');
 for(const n of ['cases','point_transactions','leaderboard_runs'])if(selected[n].length!==t[n].length)blockers.push('MIXED_OR_UNSELECTED_'+n.toUpperCase());
 if(t.campaign_example_assets.some(r=>keys.has(r.object_key)))blockers.push('WEBSITE_ASSET_SCOPE_COLLISION');
 const deletes=Object.fromEntries(Object.entries(selected).map(([n,rows])=>[n,new Set(rows.map(r=>key(snapshot,n,r)))]));
 const closure=[];
 for(const[table,rows]of Object.entries(t))for(const fk of snapshot.foreignKeys[table]){
  if(!deletes[fk.table]?.size)continue;
  const group=snapshot.foreignKeys[table].filter(x=>x.id===fk.id);if(fk.seq!==0)continue;
  for(const row of rows){if(deletes[table]?.has(key(snapshot,table,row)))continue;if(group.some(x=>row[x.from]===null))continue;
   const hit=selected[fk.table].find(parent=>group.every(x=>parent[x.to]===row[x.from]));
   if(hit&&!(table==='leaderboards'&&group.some(x=>x.from==='current_run_id'))){blockers.push('FK_MIXED_REFERENCE');closure.push({child_table:table,child_key:key(snapshot,table,row),parent_table:fk.table,parent_key:key(snapshot,fk.table,hit),on_delete:fk.on_delete});}
  }
 }
 const body={format:'prelaunch-selective-reset-v1',source_hash:snapshot.hash,schema_hash:shaSchema(snapshot.schema),epoch:control?.epoch??null,control_version:control?.version??null,run_id:control?.run_id??null,
  scope,selected,keys:[...keys].sort(),counts:Object.fromEntries(Object.entries(selected).map(([n,r])=>[n,r.length])),fk_closure:closure,unfinished,
  blockers:[...new Set(blockers)],evidence,physical_r2_delete:false,identity_tables_preserved:[...KEEP64],operational_tables_preserved:EXTRA_KEEP};
 return{...body,sha256:digest(body),status:body.blockers.length?'HOLD':productionEvidence?'PRODUCTION_REVIEW_REQUIRED':'LOCAL_EXECUTION_ELIGIBLE_ONLY'};
}

export function executeSelectiveResetLocal(db,manifest,{authority,expectedManifestHash,fault}={}){
 if(authority!=='LOCAL_SYNTHETIC_ONLY'||expectedManifestHash!==manifest.sha256)throw Error('EXPLICIT_LOCAL_AUTHORITY_AND_HASH_REQUIRED');
 const {sha256,status,...body}=manifest;if(digest(body)!==sha256||manifest.blockers.length||status!=='LOCAL_EXECUTION_ELIGIBLE_ONLY')throw Error('MANIFEST_HOLD_OR_TAMPERED');
 db.exec('BEGIN IMMEDIATE;PRAGMA defer_foreign_keys=ON');
 try{
  const before=snapshotReset(db);if(before.hash!==manifest.source_hash)throw Error('SOURCE_CHANGED');
  if(fault==='trigger')db.exec("CREATE TEMP TRIGGER prelaunch_local_fault BEFORE INSERT ON main.prelaunch_reset_audit BEGIN SELECT RAISE(ABORT,'LOCAL_INJECTED_TRIGGER_FAILURE');END");
  const rows=manifest.selected,scope={};
  for(const[n,rs]of Object.entries(rows))scope[n]={delete:rs.map(r=>key(before,n,r))};
  scope.leaderboards={update:before.tables.leaderboards.map(r=>key(before,'leaderboards',r))};
  const resetAuditId='selective-reset:'+manifest.run_id;scope.storage_audit={insert:[JSON.stringify([resetAuditId])]};
  db.prepare("INSERT INTO prelaunch_reset_permit VALUES(1,?,NULL,'reset',?,?)").run(manifest.epoch,JSON.stringify(scope),manifest.run_id);
  const immutableNames=new Set(['points_no_delete','leaderboard_runs_no_delete','leaderboard_results_no_delete','export_items_no_delete','export_completed_no_delete','final_intent_no_delete','admin_audit_no_delete','leaderboards_policy']);
  const exceptions=before.schema.filter(r=>r.type==='trigger'&&immutableNames.has(r.name));
  if(exceptions.length!==8)throw Error('IMMUTABLE_GUARD_SCHEMA_MISMATCH');
  for(const trigger of exceptions)db.exec('DROP TRIGGER '+ident(trigger.name));
  for(const board of before.tables.leaderboards){
   if(board.current_run_id&&!new Set(manifest.scope.run_ids).has(board.current_run_id))throw Error('BOARD_RUN_OUTSIDE_SCOPE');
   if(!Number.isSafeInteger(board.version+1))throw Error('BOARD_VERSION_OVERFLOW');
   if(db.prepare('UPDATE leaderboards SET current_run_id=NULL,version=version+1 WHERE leaderboard_id=? AND version=?').run(board.leaderboard_id,board.version).changes!==1)throw Error('BOARD_CAS_FAILED');
  }
  for(const objectKey of manifest.keys)db.prepare('INSERT INTO prelaunch_reset_retired_keys VALUES(?,?,?)').run(objectKey,manifest.epoch,manifest.run_id);
  // Deferrable cycles: cases -> point_transactions -> cases and uploads -> cases.
  const order=['export_completed_files','export_job_items','export_packages','export_jobs','proof_duplicate_requests','proof_duplicate_groups','proof_duplicate_jobs','proof_exact_hashes','proof_backups','cold_proofs','case_idempotency','leaderboard_results','leaderboard_runs','point_transactions','case_files','cases','proof_upload_checksums','completed_upload_files','completed_uploads','proof_upload_intents','admin_audit_logs'];
  let removed=0;
  for(const table of order)for(const row of rows[table]){
   const pk=before.primaryKeys[table];if(!pk.length)throw Error('MISSING_PK');
   const changed=db.prepare('DELETE FROM '+ident(table)+' WHERE '+pk.map(k=>ident(k)+' IS ?').join(' AND ')).run(...pk.map(k=>row[k])).changes;
   if(changed!==1)throw Error('DELETE_CAS_OR_CASCADE_MISMATCH');removed++;
  }
  for(const trigger of exceptions)db.exec(trigger.sql);
  db.prepare('INSERT INTO storage_audit VALUES(?,?,?,?,?)').run(resetAuditId,Math.floor(Date.now()/1000),'prelaunch_selective_reset',manifest.run_id,stable({manifest:sha256,counts:manifest.counts,r2_deleted:false,old_delete:'UNKNOWN',dispatch9:'HOLD'}));
  db.prepare('INSERT INTO prelaunch_reset_audit VALUES(?,?,?,?)').run(manifest.run_id,new Date().toISOString(),'reset_commit',stable({manifest:sha256,old_epoch:manifest.epoch,next_epoch:manifest.epoch+1}));
  if(db.prepare("UPDATE prelaunch_reset_control SET epoch=epoch+1,version=version+1 WHERE id=1 AND epoch=? AND version=? AND mode='maintenance' AND run_id=?").run(manifest.epoch,manifest.control_version,manifest.run_id).changes!==1)throw Error('RESET_EPOCH_CAS_FAILED');
  db.prepare('DELETE FROM prelaunch_reset_permit WHERE id=1').run();
  if(fault==='foreign-key')db.prepare("INSERT INTO prelaunch_reset_retired_keys VALUES('synthetic-fk-fault',0,'absent-parent')").run();
  const after=snapshotReset(db);
  if(shaSchema(after.schema)!==manifest.schema_hash)throw Error('ORIGINAL_GUARDS_NOT_RESTORED');
  for(const name of [...KEEP64,...EXTRA_KEEP].filter(x=>x!=='storage_audit'))if(stable(before.tables[name])!==stable(after.tables[name]))throw Error('PROTECTED_DATA_CHANGED_'+name);
  if(before.tables.storage_audit.some(row=>!after.tables.storage_audit.some(r=>stable(r)===stable(row))))throw Error('AUDIT_REMOVED');
  if(['cases','point_transactions','leaderboard_runs','leaderboard_results'].some(n=>after.tables[n].length))throw Error('BUSINESS_NOT_ZERO');
  if(db.prepare('PRAGMA foreign_key_check').all().length||db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('FK_OR_QUICK_CHECK_FAILED');
  db.exec('COMMIT');return{status:'LOCAL_RESET_COMMITTED',removed,epoch:manifest.epoch+1,physical_r2_deleted:0,protected_data_unchanged:true,original_schema_guards_restored:true,cloud_transaction_ddl:'UNKNOWN'};
 }catch(error){db.exec('ROLLBACK');throw error;}
}

export function dryRunFile(db,out,evidence={},options={}){
 if(fs.existsSync(out))throw Error('DO_NOT_OVERWRITE_PRIVATE_MANIFEST');
 const snapshot=snapshotReset(db),manifest=planSelectiveReset(snapshot,undefined,evidence,options);fs.writeFileSync(out,stable(manifest)+'\n',{flag:'wx'});return{status:manifest.status,counts:manifest.counts,blockers:manifest.blockers,manifest_sha256:manifest.sha256};
}
