import {AdminError,ELEVATED_AUTH_GUARD,actorBindings} from './admin-identity.js';
import {authAtomic} from './auth-store.js';

const seconds=()=>Math.floor(Date.now()/1000);
const blocked=()=>new AdminError(409,'IMAGE_MAINTENANCE_HOLD','圖片作業維護中或結果尚未確認，請保留現有紀錄。');
const unresolved="NOT EXISTS(SELECT 1 FROM image_mutation_operations WHERE state IN('active','unknown')) AND NOT EXISTS(SELECT 1 FROM storage_reservations WHERE state='reserved') AND NOT EXISTS(SELECT 1 FROM proof_upload_intents WHERE write_token IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed') AND NOT EXISTS(SELECT 1 FROM cold_proofs WHERE state='deleting')";
const audit=(db,id,action,target,detail)=>db.prepare('INSERT INTO storage_audit VALUES(?,?,?,?,?)').bind(id,seconds(),action,target,JSON.stringify(detail));
const actorGuard=actor=>({sql:ELEVATED_AUTH_GUARD,args:actorBindings(actor)});
async function admit(env,kind,actor=null,key=null){
 const id=crypto.randomUUID(),parent=env.IMAGE_MUTATION_PARENT??null;
 try{await authAtomic(env.DB,[{sql:'EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1)',args:[]},...(actor?[actorGuard(actor)]:[])],[
  env.DB.prepare(`INSERT INTO image_mutation_operations(id,kind,parent_id,actor_member_id,object_key,generation,state,created_at)
   SELECT ?,?,?,?,?,generation,'active',? FROM image_maintenance_control WHERE id=1`)
   .bind(id,kind,parent,actor?.member.member_id??null,key,seconds()),
  audit(env.DB,id+':admit','image_mutation_admitted',id,{kind,parent}),
 ]);}catch{throw blocked();}
 return id;
}
async function terminal(env,id,state,outcome){
 await authAtomic(env.DB,[{sql:"EXISTS(SELECT 1 FROM image_mutation_operations WHERE id=? AND state='active')",args:[id]}],[
  env.DB.prepare("UPDATE image_mutation_operations SET state=?,finished_at=?,outcome=? WHERE id=? AND state='active'").bind(state,seconds(),outcome,id),
  audit(env.DB,id+':terminal','image_mutation_'+state,id,{outcome}),
 ]);
}
async function unknown(env,id,outcome){
 // If this write/ACK is lost, ACTIVE remains just as blocking. Never expire it.
 try{await terminal(env,id,'unknown',outcome);}catch{}
}
export async function deleteImage(env,key){
 const id=await admit(env,'delete',null,key);
 try{await env.PROOFS_BUCKET.delete(key);}
 catch{await unknown(env,id,'native_delete_ack_unknown');throw blocked();}
 try{await terminal(env,id,'completed','native_delete_acknowledged');}
 catch{await unknown(env,id,'terminal_ack_unknown');throw blocked();}
}
export async function adminImageOperation(env,actor,kind,action){
 const id=await admit(env,kind,actor),scoped={...env,IMAGE_MUTATION_PARENT:id};
 try{
  const result=await action(scoped);
  const pending=await env.DB.prepare("SELECT id FROM image_mutation_operations WHERE parent_id=? AND state IN('active','unknown') LIMIT 1").bind(id).first();
  if(pending||result?.asset_cleanup_pending){await unknown(env,id,'cleanup_pending');return result;}
  await terminal(env,id,'completed','admin_workflow_acknowledged');return result;
 }catch(error){
  const pending=await env.DB.prepare("SELECT id FROM image_mutation_operations WHERE parent_id=? AND state IN('active','unknown') LIMIT 1").bind(id).first().catch(()=>({id:'unknown'}));
  if(error instanceof AdminError&&error.status>=400&&error.status<500&&!pending){
   try{await terminal(env,id,'aborted','known_admin_rejection');}catch{await unknown(env,id,'terminal_ack_unknown');}
  }else await unknown(env,id,'admin_workflow_unknown');
  throw error;
 }
}
export async function imageMaintenanceStatus(db){
 const control=await db.prepare('SELECT mode,version,generation,legacy_status FROM image_maintenance_control WHERE id=1').first();
 if(!control)throw blocked();
 const pending=await db.prepare("SELECT kind,state,COUNT(*) count FROM image_mutation_operations WHERE state IN('active','unknown') GROUP BY kind,state").all();
 return {...control,pending:pending.results,legacy_proof:'operator evidence required; new Runtime cannot verify old cohort',ready:control.mode==='closed'&&pending.results.length===0};
}
export async function changeImageMaintenance(env,actor,input){
 const {action,expected_version,confirmed}=input??{};
 const allowed=['pause','settle','resume','attest_legacy','abort_inventory'];
 if(!allowed.includes(action)||confirmed!==true||!Number.isSafeInteger(expected_version)||expected_version<1||
   Object.keys(input).some(k=>!['action','expected_version','confirmed','evidence_sha256','inventory_id','inventory_version'].includes(k)))throw blocked();
 const db=env.DB,id=crypto.randomUUID();const guards=[actorGuard(actor),{sql:'EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1 AND version=?)',args:[expected_version]}];
 const writes=[];
 if(action==='pause'){
  guards.push({sql:"EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1 AND mode='open')",args:[]});
  writes.push(db.prepare("UPDATE image_maintenance_control SET mode='draining',legacy_status='unknown',legacy_evidence_hash=NULL,version=version+1,updated_at=? WHERE id=1").bind(seconds()),
   db.prepare('UPDATE storage_capacity SET blocked=1,trusted_until=0 WHERE id=1'),
   db.prepare("UPDATE storage_archive_control SET mode=CASE WHEN EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed') OR EXISTS(SELECT 1 FROM cold_proofs WHERE state='deleting') THEN 'draining' ELSE 'paused' END,epoch=epoch+1,updated_at=? WHERE id=1").bind(seconds()));
 }else if(action==='abort_inventory'){
  if(!/^[a-f0-9-]{36}$/.test(input.inventory_id??'')||!Number.isSafeInteger(input.inventory_version))throw blocked();
  guards.push({sql:"EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1 AND mode IN('draining','closed')) AND EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND inventory_id=? AND inventory_version=? AND reserved_bytes=0)",args:[input.inventory_id,input.inventory_version]});
  writes.push(db.prepare(`UPDATE storage_capacity SET blocked=1,trusted_until=0,inventory_id=NULL,inventory_phase=NULL,
   inventory_cursor=NULL,inventory_bytes=0,inventory_count=0,inventory_staging=0,inventory_other=0,inventory_version=inventory_version+1 WHERE id=1`),
   db.prepare('UPDATE image_maintenance_control SET version=version+1,updated_at=? WHERE id=1').bind(seconds()));
 }else{
  guards.push({sql:unresolved+" AND EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND inventory_id IS NULL AND reserved_bytes=0)",args:[]});
  if(action==='attest_legacy'){
   if(!/^[a-f0-9]{64}$/.test(input.evidence_sha256??''))throw blocked();
   guards.push({sql:"EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1 AND mode='draining')",args:[]});
   writes.push(db.prepare("UPDATE image_maintenance_control SET legacy_status='operator_attested',legacy_evidence_hash=?,version=version+1,updated_at=? WHERE id=1").bind(input.evidence_sha256,seconds()));
  }else{
   guards.push({sql:"EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1 AND legacy_status='operator_attested' AND mode=?) AND EXISTS(SELECT 1 FROM submission_settings WHERE id=1 AND submissions_enabled=0)",args:[action==='settle'?'draining':'closed']});
   if(action==='resume')guards.push({sql:"EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND anomaly IS NULL AND trusted_until>CAST(strftime('%s','now') AS INTEGER))",args:[]});
   writes.push(db.prepare('UPDATE image_maintenance_control SET mode=?,version=version+1,updated_at=? WHERE id=1').bind(action==='settle'?'closed':'open',seconds()));
  }
 }
 writes.push(audit(db,id,'image_maintenance_'+action,'image-maintenance',{actor:actor.member.member_id,
  previous_version:expected_version,...(action==='attest_legacy'?{evidence_hash:input.evidence_sha256,proof:'operator_attestation_not_machine_drain'}:{}),
  ...(action==='abort_inventory'?{inventory_id:input.inventory_id,inventory_version:input.inventory_version}:{} )}));
 try{await authAtomic(db,guards,writes);}catch{throw blocked();}
 return imageMaintenanceStatus(db);
}
