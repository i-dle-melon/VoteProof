// LOCAL SYNTHETIC SHADOW PREPARATION ONLY. No cloud client, source DELETE,
// Production activation or substitute for the original 68-table guards.
import fs from 'node:fs';import p from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {capture,digest,ident,stable} from './prelaunch-reset-snapshot.mjs';
export const KEEP64=new Set(['members','member_credentials','auth_transactions','auth_sessions','trusted_devices','recovery_codes','auth_rate_limits','auth_atomic_guards','auth_identities','auth_email_challenges','auth_email_sends','auth_enrollments','auth_password_operations','auth_google_flows','auth_method_setups','auth_identity_events','admin_memberships','member_status_events','admin_member_contact_audit','admin_member_mail_requests','campaigns','campaign_content','campaign_example_assets','site_announcements','solo_targets','member_tiers','submission_settings','submission_settings_audit','admin_content_audit']);
export const CLEAR64=new Set(['backup_admin_audit','backup_processor_lock','case_files','case_idempotency','cases','cold_proofs','completed_upload_files','completed_uploads','drive_backup_folders','drive_quota_snapshots','export_completed_files','export_file_claims','export_job_items','export_jobs','export_operation_audit','export_packages','export_scope_locks','leaderboard_results','leaderboard_runs','point_transactions','proof_backups','proof_duplicate_groups','proof_duplicate_jobs','proof_duplicate_requests','proof_exact_hashes','proof_upload_checksums','proof_upload_intents','storage_alert_deliveries','storage_alerts','storage_audit','storage_history','storage_reservations']);
export const REBUILD64=new Set(['leaderboards','storage_capacity']);
export const APP64=new Set([...KEEP64,...CLEAR64,...REBUILD64,'admin_audit_logs']);
export function policy64(name){if(KEEP64.has(name)||name==='d1_migrations')return 'KEEP_EXACT';if(CLEAR64.has(name))return 'EMPTY_NEW_DATABASE_KEEP_SOURCE';if(REBUILD64.has(name))return 'REBUILD_SAFE_STATE';if(name==='admin_audit_logs')return 'KEEP_CONFIG_ROLE_AUDIT_ONLY_IN_NEW_DB';throw Error('UNCLASSIFIED_0028_TABLE');}
const schemaKey=rows=>digest(rows.map(x=>({...x,sql:x.sql?.replace(/\r\n/g,'\n').trim()})));
export function capture64(db){
 const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
 const apps=names.filter(n=>n!=='d1_migrations');if(apps.length!==64||apps.some(n=>!APP64.has(n)))throw Error('SCHEMA_NOT_EXACT_0028');names.forEach(policy64);return capture(db);
}
export function inventory64(db){return [...APP64].sort().map(name=>({name,policy:policy64(name),columns:db.prepare('PRAGMA table_xinfo('+ident(name)+')').all(),foreign_keys:db.prepare('PRAGMA foreign_key_list('+ident(name)+')').all(),indexes:db.prepare('PRAGMA index_list('+ident(name)+')').all().map(i=>({...i,columns:db.prepare('PRAGMA index_xinfo('+ident(i.name)+')').all()})),triggers:db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(name)}));}
export function auditPolicy64(row){
 if(['case','point_transaction'].includes(row.target_type))return 'ARCHIVE_SOURCE_ONLY';
 if(!['admin_membership','campaign','member_tier','leaderboard'].includes(row.target_type))throw Error('AUDIT_SCOPE_REVIEW_REQUIRED');
 let values;try{values=[row.before_json,row.after_json].map(x=>x==null?{}:JSON.parse(x));if(values.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw Error();}catch{throw Error('AUDIT_JSON_REVIEW_REQUIRED');}
 if(row.action==='leaderboard_rebuild')return 'ARCHIVE_SOURCE_ONLY';
 const derived=['run_id','source_last_transaction_id','row_count','source_count','rankings','points','proof_count','case_id','transaction_id','object_key','file_id','upload_session_id'];
 if(values.some(x=>derived.some(k=>Object.hasOwn(x,k)&&x[k]!==null)))return 'ARCHIVE_SOURCE_ONLY';
 return 'KEEP_EXACT_CONFIG_ROLE_ROW';
}
const retained=(n,rows)=>KEEP64.has(n)||n==='d1_migrations'?rows:n==='admin_audit_logs'?rows.filter(r=>auditPolicy64(r)==='KEEP_EXACT_CONFIG_ROLE_ROW'):[];
export function retained64(snapshot){return Object.fromEntries(Object.entries(snapshot.tables).filter(([n])=>KEEP64.has(n)||['d1_migrations','admin_audit_logs'].includes(n)).map(([n,r])=>[n,{count:retained(n,r).length,hash:digest(retained(n,r))}]));}
export function assertShadow(snapshot,context){
 if(context?.environment!=='local-synthetic'||context.phase!=='unbound-shadow-only'||context.targetExposed!==false||context.identityFreezeModel!==true)throw Error('LOCAL_SHADOW_ONLY');
 if(context.oldDeleteStatus!=='UNKNOWN'||context.dispatch9!=='HOLD'||context.fakeLegacyAttestation)throw Error('UNKNOWN_MUST_REMAIN_UNKNOWN');
 if(!context.sourceBucket||!context.targetBucket||context.sourceBucket===context.targetBucket||context.sourceDriveRoot===context.targetDriveRoot)throw Error('NAMESPACE_ISOLATION_REQUIRED');
 if(context.sourceBucket!=='local-source-r2'||context.targetBucket!=='local-clean-r2'||context.targetDriveRoot!=='local-clean-drive')throw Error('SYNTHETIC_RESOURCE_IDENTITIES_REQUIRED');
 if(snapshot.tables.submission_settings[0]?.submissions_enabled!==0)throw Error('LOCAL_IDENTITY_FREEZE_REQUIRED');
}
export function productionActivation(){throw Error('PRODUCTION_NO_GO_NO_ADAPTER_OR_FENCE_PROOF');}
export function rebuild64({source,snapshot,targetPath,context,runId,manifestHash,remainingBytes=0,failBeforeCommit=false}){
 assertShadow(snapshot,context);if(!/^[a-f0-9]{64}$/.test(manifestHash)||!Number.isSafeInteger(remainingBytes)||remainingBytes<0)throw Error('INVALID_SHADOW_INPUT');
 if(targetPath===':memory:'||fs.existsSync(targetPath)||targetPath.includes('://')||targetPath.startsWith('\\\\'))throw Error('NEW_LOCAL_TARGET_REQUIRED');
 // Actual local SQLite write lock, NOT a claim of Cloudflare ingress fencing.
 source.exec('BEGIN IMMEDIATE');let db;
 try{if(capture64(source).hash!==snapshot.hash)throw Error('SOURCE_CHANGED');db=new DatabaseSync(targetPath);db.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE;PRAGMA defer_foreign_keys=ON');
 const insert=(n,row)=>{const c=Object.keys(row);db.prepare('INSERT INTO '+ident(n)+'('+c.map(ident)+') VALUES('+c.map(()=>'?')+')').run(...c.map(k=>row[k]));};
 for(const x of snapshot.schema.filter(x=>x.type==='table'))db.exec(x.sql);
 for(const x of snapshot.schema.filter(x=>x.type==='index'))db.exec(x.sql);
 for(const[n,rows]of Object.entries(snapshot.tables)){policy64(n);for(const row of retained(n,rows))insert(n,row);if(n==='leaderboards')for(const row of rows){if(!Number.isSafeInteger(row.version+1))throw Error('VERSION_OVERFLOW');insert(n,{...row,current_run_id:null,version:row.version+1});}}
 const cap=snapshot.tables.storage_capacity[0];insert('storage_capacity',{...cap,used_bytes:remainingBytes,reserved_bytes:0,blocked:1,observed_at:null,trusted_until:0,inventory_id:null,inventory_phase:null,inventory_cursor:null,inventory_version:cap.inventory_version+1,inventory_bytes:0,inventory_count:0,inventory_staging:0,inventory_other:0,cleanup_requested:0,episode:cap.episode+1});
 for(const row of snapshot.sequence.filter(x=>KEEP64.has(x.name)||['d1_migrations','admin_audit_logs'].includes(x.name))){const r=db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(row.seq,row.name);if(!r.changes)db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);}
 for(const x of snapshot.schema.filter(x=>x.type==='view'))db.exec(x.sql);
 for(const x of snapshot.schema.filter(x=>x.type==='trigger'))db.exec(x.sql);
 insert('storage_audit',{id:runId,created_at:Math.floor(Date.now()/1000),action:'prelaunch_reset_shadow_0028',target:runId,detail:JSON.stringify({source_hash:snapshot.hash,manifest_hash:manifestHash,phase:'UNBOUND_ONLY',old_delete:'UNKNOWN',dispatch9:'HOLD'})});
 const proof=verify64(db,snapshot,{runId,manifestHash});if(capture64(source).hash!==snapshot.hash)throw Error('SOURCE_CHANGED');if(failBeforeCommit)throw Error('LOCAL_BUILD_FAILURE');db.exec('COMMIT');return{db,proof};
 }catch(e){if(db){try{db.exec('ROLLBACK');}catch{}db.close();}throw e;}finally{source.exec('ROLLBACK');}
}
export function verify64(db,snapshot,{runId,manifestHash}){
 const actual=capture64(db);if(schemaKey(actual.schema)!==schemaKey(snapshot.schema))throw Error('SCHEMA_CHANGED');if(stable(retained64(actual))!==stable(retained64(snapshot)))throw Error('IDENTITY_CONFIG_CHANGED');
 for(const n of CLEAR64){const r=actual.tables[n];if(n==='storage_audit'){if(r.length!==1||r[0].id!==runId||JSON.parse(r[0].detail).manifest_hash!==manifestHash||r[0].action!=='prelaunch_reset_shadow_0028')throw Error('SHADOW_AUDIT_CHANGED');}else if(r.length)throw Error('BUSINESS_DATA_REMAINS');}
 if(actual.tables.leaderboards.length!==snapshot.tables.leaderboards.length)throw Error('DEFINITION_CHANGED');for(const b of snapshot.tables.leaderboards){if(stable(actual.tables.leaderboards.find(x=>x.leaderboard_id===b.leaderboard_id))!==stable({...b,current_run_id:null,version:b.version+1}))throw Error('DEFINITION_CHANGED');}
 const cap=actual.tables.storage_capacity[0];if(actual.tables.submission_settings[0].submissions_enabled!==0||cap.blocked!==1||cap.trusted_until!==0||cap.inventory_id!==null||cap.cleanup_requested!==0||cap.reserved_bytes!==0)throw Error('TARGET_NOT_FAIL_CLOSED');
 if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('TARGET_INTEGRITY_FAILURE');
 return{application_tables:64,identity_digests:retained64(actual),schema_hash:schemaKey(actual.schema),target_hash:actual.hash,gate:0,cleanup:'OFF',capacity:'UNTRUSTED_BLOCKED',old_delete:'UNKNOWN',dispatch9:'HOLD',binding:'UNBOUND'};
}
const storeFile=s=>p.resolve(s.db.prepare('PRAGMA database_list').get().file);
export function isolationPlan(snapshot,context,{r2,drive,next}){
 assertShadow(snapshot,context);snapshot.tables.admin_audit_logs.forEach(auditPolicy64);if(r2===next||storeFile(r2)===storeFile(next))throw Error('SAME_BUCKET_FORBIDDEN');if(next.list().length)throw Error('NEW_BUCKET_NOT_EMPTY');
 const oldR2=r2.list(),oldDrive=drive.list(),refs=new Set([...snapshot.tables.case_files,...snapshot.tables.completed_upload_files,...snapshot.tables.proof_upload_intents].map(x=>x.object_key));
 if(!Array.isArray(context.siteAssetKeys)||context.siteAssetKeys.some(k=>typeof k!=='string'||!k))throw Error('EXPLICIT_SITE_ASSET_SCOPE_REQUIRED');
 const assets=new Set([...snapshot.tables.campaign_example_assets.map(x=>x.object_key),...context.siteAssetKeys]);for(const k of assets){if(k.startsWith('proofs/')||refs.has(k))throw Error('ASSET_SCOPE_CONFLICT');if(!oldR2.some(x=>x.id===k))throw Error('RETAINED_ASSET_MISSING');}
 for(const object of oldR2){const proof=refs.has(object.id)||['proofs/staging/','proofs/final/','proofs/cases/'].some(k=>object.id.startsWith(k));if(!proof&&!assets.has(object.id))throw Error('UNKNOWN_OBJECT_SCOPE_HOLD');}
 for(const file of snapshot.tables.case_files)if(!oldR2.some(x=>x.id===file.object_key)&&!snapshot.tables.cold_proofs.some(x=>x.file_id===file.id&&x.state==='cold'))throw Error('MISSING_SOURCE_REQUIRES_RECONCILIATION');
 const ownedDrive=[],unrelatedDrive=[];
 for(const object of oldDrive){const m=object.meta,backup=snapshot.tables.proof_backups.find(x=>x.drive_file_id===object.id);if(!backup&&!(m.source==='voteproof'&&m.root_folder_id===context.sourceDriveRoot)){unrelatedDrive.push(object.id);continue;}const file=snapshot.tables.case_files.find(x=>x.id===m.voteproof_proof_id),c=file&&snapshot.tables.cases.find(x=>x.id===file.case_id),sha=file&&(oldR2.find(x=>x.id===file.object_key)?.sha256??snapshot.tables.cold_proofs.find(x=>x.file_id===file.id)?.sha256);
 if(!backup||!file||!c||backup.file_id!==file.id||backup.source_object_key!==file.object_key||backup.source_size!==file.size||backup.source_mime!==file.content_type||m.source!=='voteproof'||m.storage_source!=='r2'||m.root_folder_id!==context.sourceDriveRoot||m.voteproof_case_id!==c.case_id||object.sha256!==sha||object.size!==file.size||object.mime!==file.content_type)throw Error('DRIVE_RECOVERY_IDENTITY_UNVERIFIED');ownedDrive.push(object);}
 for(const b of snapshot.tables.proof_backups.filter(x=>x.drive_file_id))if(!ownedDrive.some(x=>x.id===b.drive_file_id))throw Error('DRIVE_SOURCE_MISSING_HOLD');
 const body={environment:'local-synthetic',phase:'unbound-shadow-only',sourceHash:snapshot.hash,sourceBucket:context.sourceBucket,targetBucket:context.targetBucket,oldDeleteStatus:'UNKNOWN',sourceDriveRoot:context.sourceDriveRoot,targetDriveRoot:context.targetDriveRoot,copyAssets:oldR2.filter(x=>assets.has(x.id)),unrelatedDrivePreservedInSource:unrelatedDrive,archive:[...oldR2.map(object=>({store:'r2',object})),...ownedDrive.map(object=>({store:'drive',object}))]};return{...body,hash:digest(body)};
}
const checkPlan=plan=>{const{hash,...body}=plan;if(digest(body)!==hash||plan.environment!=='local-synthetic'||plan.phase!=='unbound-shadow-only')throw Error('MANIFEST_CHANGED');};
const sameContent=(a,b)=>a&&a.size===b.size&&a.sha256===b.sha256&&a.mime===b.mime;
const sameCopy=(a,b)=>sameContent(a,b)&&stable(a.meta)===stable(b.meta);
function readCopy(file,manifest){
 if(!fs.existsSync(file))return{manifest,items:{},events:[]};const s=JSON.parse(fs.readFileSync(file));if(s.manifest!==manifest)throw Error('JOURNAL_MANIFEST_CHANGED');let previous='';for(const e of s.events??[]){const{hash,...body}=e;if(body.previous!==previous||digest(body)!==hash)throw Error('JOURNAL_TAMPERED');previous=hash;}if(!s.events?.length||s.events.at(-1).itemsHash!==digest(s.items))throw Error('JOURNAL_TAMPERED');return s;
}
function saveCopy(file,state){const e={at:new Date().toISOString(),itemsHash:digest(state.items),previous:state.events.at(-1)?.hash??''};state.events.push({...e,hash:digest(e)});fs.writeFileSync(file+'.tmp',JSON.stringify(state));fs.renameSync(file+'.tmp',file);}
export function backupDatabase(db,file){if(fs.existsSync(file)||file.includes('://')||file.startsWith('\\\\'))throw Error('NEW_LOCAL_BACKUP_REQUIRED');const before=capture64(db).hash;db.prepare('VACUUM INTO ?').run(file);const copy=new DatabaseSync(file,{readOnly:true});try{if(capture64(copy).hash!==before||capture64(db).hash!==before)throw Error('DATABASE_BACKUP_UNVERIFIED');return{source_hash:before,backup_hash:capture64(copy).hash};}finally{copy.close();}}
export function backupObjects(plan,stores,vault){checkPlan(plan);let puts=0;for(const item of plan.archive){const source=stores[item.store],key=digest(item);if(stable(source.head(item.object.id))!==stable(item.object))throw Error('BACKUP_SOURCE_CHANGED');let saved=vault.head(key);if(!saved){vault.put(key,source.bytes(item.object.id),item.object.mime,{original:item});puts++;saved=vault.head(key);}if(!sameContent(saved,item.object)||stable(saved.meta.original)!==stable(item))throw Error('BACKUP_UNVERIFIED');}return{verified:plan.archive.length,puts};}
export function copyAssets(plan,source,next,file,{faultAfterPut=false,faultBeforePut=false}={}){
 checkPlan(plan);const lock=file+'.lock';let fd;try{fd=fs.openSync(lock,'wx');}catch{throw Error('COPY_LOCKED_NO_TTL_UNLOCK');}
 const save=state=>saveCopy(file,state);
 try{let state=readCopy(file,plan.hash);let puts=0;
 for(const item of plan.copyAssets){const k=digest(item),s=state.items[k];if(['UNKNOWN','INFLIGHT'].includes(s))throw Error('COPY_UNKNOWN_HOLD');if(s==='VERIFIED'){if(!sameCopy(next.head(item.id),item))throw Error('TARGET_ASSET_CHANGED');continue;}if(next.head(item.id))throw Error('TARGET_ALREADY_EXISTS_NO_OVERWRITE');if(stable(source.head(item.id))!==stable(item))throw Error('SOURCE_ASSET_CHANGED');state.items[k]='INFLIGHT';save(state);
 try{if(faultBeforePut)throw Error('COPY_RESULT_UNKNOWN');next.put(item.id,source.bytes(item.id),item.mime,item.meta);puts++;if(faultAfterPut)throw Error('COPY_RESULT_UNKNOWN');if(!sameCopy(next.head(item.id),item)||stable(source.head(item.id))!==stable(item))throw Error('COPY_UNVERIFIED');state.items[k]='VERIFIED';save(state);}catch(e){state.items[k]='UNKNOWN';save(state);throw e;}}
 return{verified:plan.copyAssets.length,puts};}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function reconcileCopyOnly(plan,source,next,file,item,{localInvocationEnded=false}={}){
 checkPlan(plan);if(!localInvocationEnded)throw Error('LOCAL_INVOCATION_EVIDENCE_REQUIRED');const lock=file+'.lock';let fd;try{fd=fs.openSync(lock,'wx');}catch{throw Error('COPY_LOCKED_NO_TTL_UNLOCK');}
 try{const s=readCopy(file,plan.hash),key=digest(item);if(!['UNKNOWN','INFLIGHT'].includes(s.items[key]))throw Error('COPY_RECONCILE_SCOPE');if(stable(source.head(item.id))!==stable(item)||!sameCopy(next.head(item.id),item))return{status:'HOLD',puts:0};s.items[key]='VERIFIED';saveCopy(file,s);return{status:'VERIFIED_EXISTING_COPY',puts:0};}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function restoreObjects(plan,vault,restored){checkPlan(plan);let puts=0;for(const item of plan.archive){const saved=vault.head(digest(item));if(!sameContent(saved,item.object)||stable(saved.meta.original)!==stable(item))throw Error('RECOVERY_COPY_CORRUPT');const target=restored[item.store];if(target.head(item.object.id))throw Error('RESTORE_OVERWRITE_FORBIDDEN');target.put(item.object.id,vault.bytes(digest(item)),item.object.mime,item.object.meta);if(!sameCopy(target.head(item.object.id),item.object))throw Error('RESTORE_UNVERIFIED');puts++;}return{puts,local_only:true,realDriveFileIdRestore:'UNVERIFIED'};}
