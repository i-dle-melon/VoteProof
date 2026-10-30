// Single, size-bounded expired Direct writer. This never settles its PUT,
// releases its reservation/pin, or exempts growth from the existing alarm.
import {AdminError} from './admin-identity.js';
import {authAtomic} from './auth-store.js';
import {capacityRow,nowSeconds,STORAGE,StorageCapacityError} from './storage-capacity.js';
import {UPLOAD_LIMITS} from '../api/upload-validation.js';

const fail=code=>new AdminError(409,code,'未決寫入或盤點狀態已變更，保留原狀。');
const columns={rid:'r.id',key:'r.object_key',bytes:'r.bytes',state:'r.state',created:'r.created_at',etag:'r.etag',version:'r.object_version',
  session:'i.session_id',proof:'i.proof_id',pin:'i.write_token',size:'i.size',mime:'i.content_type',sha:'i.expected_sha256',
  intent_state:'i.state',mode:'i.completion_mode',grant_expires:'i.grant_expires',expires:'i.expires_at',consumed:'i.consumed_case_id'};
const join='storage_reservations r JOIN proof_upload_intents i ON i.object_key=r.object_key';
const unreferenced=`NOT EXISTS(SELECT 1 FROM cases WHERE upload_session_id=i.session_id OR upload_intent_id=i.session_id)
 AND NOT EXISTS(SELECT 1 FROM case_files WHERE object_key=r.object_key OR upload_object_key=r.object_key)`;
const sourceSQL=`SELECT ${Object.entries(columns).map(([alias,col])=>`${col} AS ${alias}`).join(',')} FROM ${join} WHERE r.id=? AND ${unreferenced}`;
const capFields=['used_bytes','reserved_bytes','blocked','anomaly','observed_at','episode'];
// Existing scans use random v4 UUIDs. A server-issued custom v8 UUID marks the
// pending mode durably without adding a column or a lookup to normal scans.
const pendingId=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const capData=row=>Object.fromEntries(capFields.map(k=>[k,row[k]]));
const controlSQL='SELECT epoch,mode,version,run_id FROM prelaunch_reset_control WHERE id=1';
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
const progress=(row,s)=>({complete:false,phase:row.inventory_phase==='ready'?'finalize':'scan',inventory_id:row.inventory_id,
  inventory_version:row.inventory_version,scanned:row.inventory_count,conservative:true,pending_bytes:s.bytes});
async function control(env){
 if(env.PRELAUNCH_RESET_FENCE_ENABLED!=='true'||!env.PRELAUNCH_RESET_CONTEXT)throw fail('STORAGE_PENDING_FENCE_REQUIRED');
 const c=await env.DB.prepare(controlSQL).first();
 if(c?.mode!=='open'||c.epoch!==env.PRELAUNCH_RESET_CONTEXT.epoch)throw fail('STORAGE_PENDING_CONTROL_CONFLICT');
 return c;
}
function eligible(entry){
 return entry&&entry.state==='reserved'&&entry.intent_state==='prepared'&&entry.mode==='direct'&&entry.pin&&entry.consumed===null&&
  Number.isSafeInteger(entry.bytes)&&entry.bytes>0&&entry.bytes<=UPLOAD_LIMITS.maxFileBytes&&entry.size===entry.bytes&&
  Number.isSafeInteger(entry.grant_expires)&&entry.grant_expires<=nowSeconds()&&/^[a-f0-9]{64}$/.test(entry.sha);
}
function guard(row,s,entry,{claim=false,detail}={}){
 const predicates=[`EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND inventory_id IS ? AND inventory_phase IS ? AND inventory_version=? AND ${capFields.map(k=>`${k} IS ?`).join(' AND ')})`,
  `EXISTS(SELECT 1 FROM ${join} WHERE ${Object.entries(columns).map(([,c])=>`${c} IS ?`).join(' AND ')} AND ${unreferenced})`,
  "NOT EXISTS(SELECT 1 FROM storage_reservations WHERE state='reserved' AND id<>?)",
  'EXISTS(SELECT 1 FROM prelaunch_reset_control WHERE id=1 AND epoch=? AND mode=? AND version=? AND run_id IS ?)'];
 const args=[row.inventory_id,row.inventory_phase,row.inventory_version,...capFields.map(k=>s.capacity[k]),
  ...Object.keys(columns).map(k=>entry[k]),entry.rid,s.control.epoch,s.control.mode,s.control.version,s.control.run_id];
 if(!claim){predicates.push("EXISTS(SELECT 1 FROM storage_audit WHERE id=? AND target=? AND action='inventory_pending_snapshot' AND detail=?)");args.push('pending:'+row.inventory_id,row.inventory_id,detail)}
 return{sql:predicates.map(p=>`(${p})`).join(' AND '),args};
}
async function load(env,row){
 const record=await env.DB.prepare("SELECT detail FROM storage_audit WHERE id=? AND target=? AND action='inventory_pending_snapshot'")
  .bind('pending:'+row.inventory_id,row.inventory_id).first();
 if(!record){if(pendingId(row.inventory_id))throw fail('STORAGE_PENDING_SNAPSHOT_INVALID');return null}
 let s;try{s=JSON.parse(record.detail)}catch{throw fail('STORAGE_PENDING_SNAPSHOT_INVALID')}
 if(s.v!==1||s.inventory_id!==row.inventory_id||!Number.isSafeInteger(s.bytes)||s.bytes<=0||s.capacity?.reserved_bytes!==s.bytes)throw fail('STORAGE_PENDING_SNAPSHOT_INVALID');
 const entry=await env.DB.prepare(sourceSQL).bind(s.reservation_id).first(),c=await control(env);
 if(!eligible(entry)||await digest({entry,capacity:capData(row),control:c})!==s.source_sha256)throw fail('STORAGE_PENDING_SOURCE_CHANGED');
 return{s,entry,detail:record.detail};
}
async function claim(env){
 const db=env.DB,row=await capacityRow(db),c=await control(env);
 if(row.inventory_id||row.inventory_phase||row.anomaly)throw fail('STORAGE_WRITER_BUSY');
 const rows=(await db.prepare("SELECT id FROM storage_reservations WHERE state='reserved' LIMIT 2").all()).results;
 if(rows.length!==1)throw fail('STORAGE_PENDING_SCOPE');
 const entry=await db.prepare(sourceSQL).bind(rows[0].id).first();
 if(!eligible(entry)||entry.bytes!==row.reserved_bytes)throw fail('STORAGE_PENDING_SCOPE');
 const uuid=crypto.randomUUID(),id=uuid.slice(0,14)+'8'+uuid.slice(15),s={v:1,inventory_id:id,reservation_id:entry.rid,bytes:entry.bytes,capacity:capData(row),control:c,
  source_sha256:await digest({entry,capacity:capData(row),control:c})};
 const detail=JSON.stringify(s);
 // Both the inventory pin and its private, immutable source snapshot commit
 // together. An unknown batch ACK must never lead to another claim attempt.
 try{await authAtomic(db,[guard(row,s,entry,{claim:true})],[
  db.prepare(`UPDATE storage_capacity SET inventory_id=?,inventory_phase='scan',inventory_cursor=NULL,inventory_bytes=0,
   inventory_count=0,inventory_staging=0,inventory_other=0,inventory_version=inventory_version+1,trusted_until=0 WHERE id=1`).bind(id),
  db.prepare("INSERT INTO storage_audit VALUES(?,?,'inventory_pending_snapshot',?,?)").bind('pending:'+id,nowSeconds(),id,detail),
 ])}catch{throw fail('STORAGE_PENDING_CLAIM_UNKNOWN')}
 const claimed=await capacityRow(db);
 if(claimed.inventory_id!==id)throw fail('STORAGE_SCAN_CONFLICT');
 return{row:claimed,s,entry,detail};
}

export async function pendingInventoryPage(env,row){
 if(row.inventory_id&&!pendingId(row.inventory_id))return null;
 if(!row.inventory_id&&!row.reserved_bytes)return null;
 let ctx;
 if(row.inventory_id){ctx=await load(env,row);if(!ctx)return null}
 else{ctx=await claim(env);row=ctx.row}
 const{s,entry,detail}=ctx;
 if(row.inventory_phase==='ready')return progress(row,s);
 if(row.inventory_phase!=='scan')throw fail('STORAGE_WRITER_BUSY');
 const page=await env.PROOFS_BUCKET.list({limit:50,...(row.inventory_cursor?{cursor:row.inventory_cursor}:{})});
 if(page.truncated&&!page.cursor)throw new StorageCapacityError();
 let bytes=0,staging=0,other=0;
 for(const object of page.objects){
  if(!Number.isSafeInteger(object.size)||object.size<0)throw new StorageCapacityError();
  if(object.key===entry.key&&object.size>entry.bytes)throw fail('STORAGE_PENDING_SIZE_MISMATCH');
  bytes+=object.size;if(object.key.startsWith('proofs/staging/'))staging+=object.size;
  if(!object.key.startsWith('proofs/'))other+=object.size;
 }
 if(!Number.isSafeInteger(row.inventory_bytes+bytes)||!Number.isSafeInteger(row.inventory_count+page.objects.length))throw new StorageCapacityError();
 const phase=page.truncated?'scan':'ready';
 try{await authAtomic(env.DB,[guard(row,s,entry,{detail})],[env.DB.prepare(`UPDATE storage_capacity SET
  inventory_bytes=inventory_bytes+?,inventory_count=inventory_count+?,inventory_staging=inventory_staging+?,inventory_other=inventory_other+?,
  inventory_cursor=?,inventory_phase=?,inventory_version=inventory_version+1 WHERE id=1`)
  .bind(bytes,page.objects.length,staging,other,page.truncated?page.cursor:null,phase)])}
 catch{throw fail('STORAGE_SCAN_CONFLICT')}
 return progress({...row,inventory_phase:phase,inventory_version:row.inventory_version+1,inventory_count:row.inventory_count+page.objects.length},s);
}

export async function pendingInventoryFinalize(env,row,id,version,replay){
 if(row.inventory_id!==id||!pendingId(id))return null;
 const ctx=await load(env,row);if(!ctx)return null;
 if(row.inventory_phase!=='ready'||row.inventory_cursor!==null||row.inventory_version!==version)throw fail('STORAGE_FINALIZE_NOT_READY');
 const total=row.inventory_bytes,effective=total+ctx.s.bytes,at=nowSeconds();
 if(!Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(effective))throw new StorageCapacityError();
 const anomaly=row.anomaly??(row.observed_at!==null&&total>row.used_bytes?'UNACCOUNTED_GROWTH':null);
 const recovered=row.observed_at!==null&&row.blocked&&effective<STORAGE.resume&&!anomaly;
 const detail={bytes:total,objects:row.inventory_count,anomaly,inventory_version:version,conservative:true,
  pending_bytes:ctx.s.bytes,admission_bytes:effective,pending_terminal:'UNKNOWN',coverage:'CONSERVATIVE_WITH_PENDING'};
 const writes=[
  env.DB.prepare(`INSERT INTO storage_history(id,created_at,bytes,reserved_bytes,object_count,staging_bytes,other_bytes,anomaly)
   SELECT inventory_id,?,inventory_bytes,reserved_bytes,inventory_count,inventory_staging,inventory_other,? FROM storage_capacity WHERE id=1`).bind(at,anomaly),
  env.DB.prepare("INSERT INTO storage_audit VALUES(?,?,'inventory',?,?)").bind(id,at,id,JSON.stringify(detail)),
  env.DB.prepare(`UPDATE storage_capacity SET used_bytes=inventory_bytes,observed_at=?,trusted_until=?,inventory_id=NULL,inventory_cursor=NULL,
   inventory_phase=NULL,inventory_version=inventory_version+1,anomaly=?,
   blocked=CASE WHEN ? IS NOT NULL OR inventory_bytes+reserved_bytes>=9500000000 THEN 1 WHEN inventory_bytes+reserved_bytes<9000000000 THEN 0 ELSE blocked END,
   cleanup_requested=CASE WHEN inventory_bytes+reserved_bytes<=8500000000 THEN 0 WHEN inventory_bytes+reserved_bytes>=9000000000 THEN 1 ELSE cleanup_requested END WHERE id=1`)
   .bind(at,at+STORAGE.freshSeconds,anomaly,anomaly),
 ];
 for(const kind of [...(effective>=STORAGE.cleanupStart?['90']:[]),...(effective>=STORAGE.stop?['95']:[]),...(recovered?['recovered']:[])])
  writes.push(env.DB.prepare("INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,?,?,?) ON CONFLICT(episode,kind) DO NOTHING").bind(crypto.randomUUID(),row.episode,kind,at));
 if(recovered)writes.push(env.DB.prepare('UPDATE storage_capacity SET episode=episode+1 WHERE id=1'));
 try{await authAtomic(env.DB,[guard(row,ctx.s,ctx.entry,{detail:ctx.detail})],writes)}
 catch{const saved=await replay(env.DB,id,version);if(saved)return saved;throw fail('STORAGE_FINALIZE_CONFLICT')}
 return{complete:true,phase:'finalize',inventory_id:id,inventory_version:version,bytes:total,anomaly,...pendingReceipt(detail)};
}

export function pendingReceipt(detail){
 if(detail.conservative!==true)return{};
 if(!Number.isSafeInteger(detail.pending_bytes)||detail.pending_bytes<=0||detail.admission_bytes!==detail.bytes+detail.pending_bytes||detail.pending_terminal!=='UNKNOWN'||detail.coverage!=='CONSERVATIVE_WITH_PENDING')throw new StorageCapacityError();
 return{conservative:true,pending_bytes:detail.pending_bytes,admission_bytes:detail.admission_bytes,pending_terminal:'UNKNOWN',coverage:detail.coverage};
}
