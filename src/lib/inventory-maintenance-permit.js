// Narrow reuse of the installed per-PK maintenance permit. No Schema changes,
// normal admission, Reset Manifest, image mutations, or control-mode changes.
import {CaseError} from '../api/case-validation.js';
import {readReviewJson} from '../api/admin-validation.js';
import {jsonSuccess} from '../api/response.js';
import {authenticateRelay} from './drive-backup-relay.js';
import {scanInventoryPage,finalizeInventory} from './storage-inventory.js';

const tick='/api/internal/drive-backup/storage/tick';
const finish='/api/internal/drive-backup/storage/inventory/finalize';
const statement=Symbol('inventory-maintenance-statement');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const denied=(code='INVENTORY_MAINTENANCE_CONFLICT',status=409)=>new CaseError(status,code,'Inventory maintenance unavailable');
const stamp=()=>new Date().toISOString();
const normalize=sql=>sql.trim().replace(/\s+/g,' ');
const isRead=sql=>/^SELECT\b/.test(normalize(sql));
const currentSQL=`SELECT epoch,mode,version,run_id,
 EXISTS(SELECT 1 FROM prelaunch_reset_operations WHERE state IN('active','unknown') AND id<>?) AS busy
 FROM prelaunch_reset_control WHERE id=1`;
export const isMaintenanceInventory=(request,url)=>request.method==='POST'&&[tick,finish].includes(url.pathname);

export async function maintenanceInventory(request,env,initial){
 const url=new URL(request.url),finalizing=url.pathname===finish;
 // Authenticate the existing server-only Relay before admitting any operation.
 await authenticateRelay(request,env);
 if(url.search||!isMaintenanceInventory(request,url))throw denied('INVALID_INVENTORY_REQUEST',400);
 const body=await readReviewJson(request);
 if(!body||Array.isArray(body)||typeof body!=='object'||(finalizing
  ?Object.keys(body).sort().join(',')!=='inventory_id,inventory_version'||!uuid(body.inventory_id)||!Number.isSafeInteger(body.inventory_version)||body.inventory_version<1
  :Object.keys(body).length!==1||body.inventory_only!==true))throw denied('INVALID_INVENTORY_REQUEST',400);
 if(!uuid(initial.run_id)||initial.epoch<1||!Number.isSafeInteger(initial.version))throw denied();
 const db=env.DB;let operation=null;
 const matches=c=>c?.mode==='maintenance'&&c.epoch===initial.epoch&&c.version===initial.version&&c.run_id===initial.run_id&&!c.busy;
 const assertFrozen=async()=>{if(!matches(await db.prepare(currentSQL).bind(operation??'').first()))throw denied();};
 async function admit(){
  if(operation)return;
  const id=crypto.randomUUID();
  const r=await db.prepare(`INSERT INTO prelaunch_reset_operations(id,epoch,state,started_at)
   SELECT ?,epoch,'active',? FROM prelaunch_reset_control WHERE id=1 AND mode='maintenance'
   AND epoch=? AND version=? AND run_id=?
   AND NOT EXISTS(SELECT 1 FROM prelaunch_reset_operations WHERE state IN('active','unknown'))`)
   .bind(id,stamp(),initial.epoch,initial.version,initial.run_id).run();
  if(r.meta.changes!==1)throw denied('INVENTORY_MAINTENANCE_BUSY');
  operation=id;
 }
 async function unknown(){
  if(operation)try{await db.prepare("UPDATE prelaunch_reset_operations SET state='unknown' WHERE id=?").bind(operation).run();}catch{/* Keep durable active evidence when the terminal ACK is unknown. */}
 }
 function scopeFor(statements){
  const scope={};
  const allow=(table,action,key)=>{
   const list=(scope[table]??={})[action]??=[];
   if(!list.some(x=>JSON.stringify(x)===JSON.stringify([key])))list.push([key]);
  };
  let insertedGuard=null,deletedGuard=null,history=0,audit=0;
  for(const s of statements){
   const q=normalize(s.sql),v=s.values;
   if(q.includes(';')||q.includes('--')||q.includes('/*'))throw denied('INVENTORY_STATEMENT_SCOPE');
   if(/^UPDATE storage_capacity SET /.test(q)&&/ WHERE id=1\b/.test(q))allow('storage_capacity','update',1);
   else if(/^INSERT INTO storage_alerts\(id,episode,kind,created_at\) VALUES\(\?,\?,\?,\?\) ON CONFLICT\(episode,kind\) DO NOTHING$/.test(q)&&uuid(v[0]))allow('storage_alerts','insert',v[0]);
   else if(finalizing&&q==='INSERT INTO auth_atomic_guards(id,valid) SELECT ?,CASE WHEN (EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND inventory_id=? AND inventory_version=? AND inventory_phase=? AND reserved_bytes=0)) THEN 1 ELSE 0 END'
    &&uuid(v[0])&&v[1]===body.inventory_id&&v[2]===body.inventory_version&&v[3]==='ready'){
    if(insertedGuard)throw denied('INVENTORY_STATEMENT_SCOPE');
    insertedGuard=v[0];allow('auth_atomic_guards','insert',v[0]);
   }else if(finalizing&&q==='DELETE FROM auth_atomic_guards WHERE id=?'&&uuid(v[0])){
    if(deletedGuard)throw denied('INVENTORY_STATEMENT_SCOPE');
    deletedGuard=v[0];allow('auth_atomic_guards','delete',v[0]);
   }else if(finalizing&&q==='INSERT INTO storage_history(id,created_at,bytes,reserved_bytes,object_count,staging_bytes,other_bytes,anomaly) SELECT inventory_id,?,inventory_bytes,0,inventory_count,inventory_staging,inventory_other,? FROM storage_capacity WHERE id=1'){
    history++;allow('storage_history','insert',body.inventory_id);
   }else if(finalizing&&q==='INSERT INTO storage_audit VALUES(?,?,\'inventory\',?,?)'&&v[0]===body.inventory_id&&v[2]===body.inventory_id){
    audit++;allow('storage_audit','insert',body.inventory_id);
   }else throw denied('INVENTORY_STATEMENT_SCOPE');
  }
  if((insertedGuard||deletedGuard||history||audit)&&(!insertedGuard||insertedGuard!==deletedGuard||history!==1||audit!==1))throw denied('INVENTORY_STATEMENT_SCOPE');
  return JSON.stringify(scope);
 }
 async function batch(statements){
  const scope=scopeFor(statements);
  await admit();
  try{
   // "reset" is the existing Schema's per-PK maintenance purpose. Its scope
   // comes only from these inventory statements, never a client or reset plan.
   const r=await db.batch([
    db.prepare(`INSERT INTO prelaunch_reset_permit(id,epoch,operation_id,purpose,scope_json,run_id)
     SELECT 1,epoch,?,'reset',?,run_id FROM prelaunch_reset_control
     WHERE id=1 AND mode='maintenance' AND epoch=? AND version=? AND run_id=?
     AND EXISTS(SELECT 1 FROM prelaunch_reset_operations WHERE id=? AND epoch=? AND state='active')`)
     .bind(operation,scope,initial.epoch,initial.version,initial.run_id,operation,initial.epoch),
    ...statements.map(s=>s.raw),
    db.prepare('DELETE FROM prelaunch_reset_permit WHERE id=1 AND operation_id=?').bind(operation),
   ]);
   if(r[0].meta.changes!==1)throw denied();
   return r.slice(1,-1);
  }catch(e){await unknown();throw e;}
 }
 const scopedDB={prepare(sql){
  const create=(values=[])=>{
   const s={sql,values,raw:db.prepare(sql).bind(...values)};
   return{[statement]:s,bind:(...v)=>create(v),
    all:()=>isRead(sql)?s.raw.all():batch([s]).then(r=>r[0]),
    async first(column){if(isRead(sql))return s.raw.first(column);const row=(await batch([s]))[0].results?.[0]??null;return column?row?.[column]??null:row;},
    run:()=>isRead(sql)?s.raw.run():batch([s]).then(r=>r[0])};
  };return create();
 },batch(statements){
  if(statements.some(s=>!s[statement]))throw denied('INVENTORY_STATEMENT_SCOPE');
  const rows=statements.map(s=>s[statement]);return rows.every(s=>isRead(s.sql))?db.batch(rows.map(s=>s.raw)):batch(rows);
 }};
 const bucket={async list(options){
  if(!options||options.limit!==50||Object.keys(options).some(k=>!['limit','cursor'].includes(k)))throw denied('INVENTORY_BUCKET_SCOPE');
  await admit();await assertFrozen();
  const page=await env.PROOFS_BUCKET.list(options);
  await assertFrozen();return page;
 }};
 try{
  await assertFrozen();
  const scoped={...env,DB:scopedDB,PROOFS_BUCKET:bucket};
  const result=finalizing?await finalizeInventory(scoped,body.inventory_id,body.inventory_version):await scanInventoryPage(scoped);
  await assertFrozen();
  if(operation){
   const r=await db.prepare(`UPDATE prelaunch_reset_operations SET state='completed',ended_at=?
    WHERE id=? AND state='active' AND pending_r2=0
    AND EXISTS(SELECT 1 FROM prelaunch_reset_control WHERE id=1 AND mode='maintenance' AND epoch=? AND version=? AND run_id=?)`)
    .bind(stamp(),operation,initial.epoch,initial.version,initial.run_id).run();
   if(r.meta.changes!==1)throw denied();
  }
  return jsonSuccess({inventory:result,cleanup:null,alerts:{state:'skipped_inventory_only',sent:0},inventory_only:true});
 }catch(e){await unknown();throw e;}
}
