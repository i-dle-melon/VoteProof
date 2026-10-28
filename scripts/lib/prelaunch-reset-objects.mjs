import {DatabaseSync} from 'node:sqlite';import {randomUUID} from 'node:crypto';
import {digest,stable,assertReady} from './prelaunch-reset-snapshot.mjs';import {SUBMISSION_PREFIXES} from './prelaunch-reset-policy.mjs';
// Filesystem/SQLite synthetic object adapter ONLY. No network endpoints or
// credentials. Its local fence is NOT evidence that Cloudflare/Drive is fenced.
export class LocalResetObjects {
 constructor(file,kind){
  if(!['r2','drive','recovery'].includes(kind)||file.startsWith('\\\\')||file.includes('://'))throw Error('LOCAL_OBJECT_STORE_ONLY');
  this.db=new DatabaseSync(file);this.kind=kind;
  this.db.exec('CREATE TABLE IF NOT EXISTS fixture(kind TEXT PRIMARY KEY,frozen_run TEXT); CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,version TEXT,mime TEXT,bytes BLOB,meta TEXT);');
  const row=this.db.prepare('SELECT * FROM fixture').get();if(row&&row.kind!==kind)throw Error('STORE_KIND_MISMATCH');
  if(!row)this.db.prepare('INSERT INTO fixture(kind) VALUES(?)').run(kind);
  this.deleteCalls=0;
 }
 put(id,bytes,mime='image/png',meta={}){if(this.db.prepare('SELECT frozen_run FROM fixture').get().frozen_run)throw Error('LOCAL_WRITER_FENCED');this.db.prepare('INSERT INTO objects VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,mime=excluded.mime,bytes=excluded.bytes,meta=excluded.meta').run(id,randomUUID(),mime,bytes,stable(meta));}
 head(id){const row=this.db.prepare('SELECT * FROM objects WHERE id=?').get(id);return row?{id:row.id,version:row.version,mime:row.mime,size:row.bytes.length,sha256:digest(row.bytes),meta:JSON.parse(row.meta)}:null;}
 bytes(id){return this.db.prepare('SELECT bytes FROM objects WHERE id=?').get(id)?.bytes??null;}
 list(){return this.db.prepare('SELECT id FROM objects ORDER BY id').all().map(r=>this.head(r.id));}
 freeze(run){const prior=this.db.prepare('SELECT frozen_run FROM fixture').get().frozen_run;if(prior&&prior!==run)throw Error('OTHER_RESET_FENCE');this.db.prepare('UPDATE fixture SET frozen_run=?').run(run);}
 assertFrozen(run){if(this.db.prepare('SELECT frozen_run FROM fixture').get().frozen_run!==run)throw Error('WRITER_FENCE_LOST');}
 removeForReset(item,run,{loseAck=false,failBefore=false}={}){
  this.assertFrozen(run);if(stable(this.head(item.id))!==stable(item))throw Error('OBJECT_VERSION_CHANGED');
  this.deleteCalls++;if(failBefore)throw Error('LOCAL_DELETE_RESULT_UNKNOWN');
  this.db.prepare('DELETE FROM objects WHERE id=? AND version=?').run(item.id,item.version);
  if(loseAck)throw Error('LOCAL_DELETE_ACK_UNKNOWN');
 }
 close(){this.db.close();}
}
export function resetPlan(snapshot,{r2,drive,rootFolder,window,runId}){
 assertReady(snapshot,window);
 if(r2.kind!=='r2'||drive.kind!=='drive'||!rootFolder||!runId)throw Error('LOCAL_PLAN_INPUT');
 const files=snapshot.tables.case_files,byFile=new Map(files.map(f=>[f.id,f])),byCase=new Map(snapshot.tables.cases.map(c=>[c.id,c]));
 const references=new Set([...files,...snapshot.tables.completed_upload_files,...snapshot.tables.proof_upload_intents].map(r=>r.object_key));
 const assets=new Set(snapshot.tables.campaign_example_assets.map(a=>a.object_key));
 const r2All=r2.list(),driveAll=drive.list(),targets=[],preserve=[];
 for(const item of r2All){
  const proof=references.has(item.id)||SUBMISSION_PREFIXES.some(prefix=>item.id.startsWith(prefix));
  if(item.id.startsWith('proofs/')&&!proof)throw Error('UNKNOWN_PROOF_NAMESPACE');
  if(assets.has(item.id)&&proof)throw Error('ASSET_SUBMISSION_SCOPE_COLLISION');
  (proof?targets:preserve).push({store:'r2',object:item});
 }
 for(const id of assets)if(!r2All.some(i=>i.id===id))throw Error('PRESERVED_ASSET_MISSING');
 for(const file of files)if(!r2All.some(i=>i.id===file.object_key)&&!snapshot.tables.cold_proofs.some(c=>c.file_id===file.id&&c.state==='cold'))throw Error('MISSING_CASE_SOURCE_REQUIRES_RECONCILIATION');
 const backupIds=new Set(snapshot.tables.proof_backups.map(b=>b.drive_file_id).filter(Boolean));
 for(const item of driveAll){
  const m=item.meta;
  if(!backupIds.has(item.id)&&!(m.source==='voteproof'&&m.root_folder_id===rootFolder)){preserve.push({store:'drive',object:item});continue;}
  const file=byFile.get(m.voteproof_proof_id),c=file&&byCase.get(file.case_id);
  const backup=snapshot.tables.proof_backups.find(b=>b.drive_file_id===item.id);
  if(backup&&(!file||backup.file_id!==file.id||backup.source_object_key!==file.object_key||backup.source_size!==file.size||backup.source_mime!==file.content_type))throw Error('DRIVE_BACKUP_MAPPING_CHANGED');
  const sha=file&&(r2All.find(i=>i.id===file.object_key)?.sha256??snapshot.tables.cold_proofs.find(p=>p.file_id===file.id)?.sha256);
  if(!file||!c||m.source!=='voteproof'||m.storage_source!=='r2'||m.voteproof_case_id!==c.case_id||m.root_folder_id!==rootFolder||item.sha256!==sha||item.size!==file.size||item.mime!==file.content_type)throw Error('DRIVE_IDENTITY_OR_CONTENT_UNVERIFIED');
  targets.push({store:'drive',object:item});
 }
 for(const id of backupIds)if(!driveAll.some(i=>i.id===id))throw Error('DRIVE_FILE_MISSING_REQUIRES_RECONCILIATION');
 const core={version:1,environment:'local-synthetic',runId,sourceHash:snapshot.hash,rootFolder,targets,preserve};
 return{...core,hash:digest(core)};
}
export function assertPlan(plan){const {hash,...core}=plan;if(hash!==digest(core)||plan.environment!=='local-synthetic')throw Error('MANIFEST_CHANGED');}
export function copyRecovery(plan,stores,vault){
 assertPlan(plan);if(vault.kind!=='recovery')throw Error('RECOVERY_STORE_REQUIRED');
 for(const item of plan.targets){
  const source=stores[item.store];source.assertFrozen(plan.runId);
  if(stable(source.head(item.object.id))!==stable(item.object))throw Error('RECOVERY_SOURCE_CHANGED');
  const key=digest(item),prior=vault.head(key);
  if(!prior)vault.put(key,source.bytes(item.object.id),item.object.mime,{original:item});
  const saved=vault.head(key);if(saved.sha256!==item.object.sha256||saved.size!==item.object.size||stable(saved.meta.original)!==stable(item))throw Error('RECOVERY_COPY_UNVERIFIED');
 }
}
