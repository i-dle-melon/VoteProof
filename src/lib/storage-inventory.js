import {AdminError} from './admin-identity.js';
import {authAtomic} from './auth-store.js';
import {capacityRow,evaluateCapacity,nowSeconds,STORAGE,StorageCapacityError} from './storage-capacity.js';

const conflict=code=>new AdminError(409,code,'盤點狀態已變更，請從持久進度續跑。');
function writer(env){if(env.R2_EXCLUSIVE_WRITER_CONFIRMED!=='true')throw conflict('STORAGE_WRITER_UNVERIFIED');}
const progress=row=>({complete:false,phase:row.inventory_phase==='ready'?'finalize':'scan',
  inventory_id:row.inventory_id,inventory_version:row.inventory_version,scanned:row.inventory_count});
const guard=row=>({sql:"EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND inventory_id=? AND inventory_version=? AND inventory_phase=? AND reserved_bytes=0)",
  args:[row.inventory_id,row.inventory_version,row.inventory_phase]});

// One invocation scans at most one page. It never publishes trusted capacity.
export async function scanInventoryPage(env){
  writer(env);const db=env.DB;let row=await capacityRow(db);
  await evaluateCapacity(db,row);
  if(!row.inventory_id){
    row=await db.prepare(`UPDATE storage_capacity SET inventory_id=?,inventory_phase='scan',
      inventory_cursor=NULL,inventory_bytes=0,inventory_count=0,inventory_staging=0,inventory_other=0,
      inventory_version=inventory_version+1,trusted_until=0
      WHERE id=1 AND inventory_id IS NULL AND inventory_phase IS NULL AND reserved_bytes=0 RETURNING *`)
      .bind(crypto.randomUUID()).first();
    if(!row)throw conflict('STORAGE_WRITER_BUSY');
  }
  if(row.inventory_phase==='ready')return progress(row);
  // Do not adopt a legacy in-flight scan or override an ambiguous reservation.
  if(row.inventory_phase!=='scan'||row.reserved_bytes)throw conflict('STORAGE_WRITER_BUSY');
  const page=await env.PROOFS_BUCKET.list({limit:50,...(row.inventory_cursor?{cursor:row.inventory_cursor}:{})});
  if(page.truncated&&!page.cursor)throw new StorageCapacityError();
  let bytes=0,staging=0,other=0;
  for(const object of page.objects){
    if(!Number.isSafeInteger(object.size)||object.size<0)throw new StorageCapacityError();
    bytes+=object.size;if(object.key.startsWith('proofs/staging/'))staging+=object.size;
    if(!object.key.startsWith('proofs/'))other+=object.size;
  }
  if(!Number.isSafeInteger(row.inventory_bytes+bytes)||!Number.isSafeInteger(row.inventory_count+page.objects.length))throw new StorageCapacityError();
  const phase=page.truncated?'scan':'ready';
  try{
    // One row is the entire page commit: keep all CAS predicates in this
    // atomic statement instead of inserting/deleting a generic batch guard.
    const saved=await db.prepare(`UPDATE storage_capacity SET
      inventory_bytes=inventory_bytes+?,inventory_count=inventory_count+?,inventory_staging=inventory_staging+?,
      inventory_other=inventory_other+?,inventory_cursor=?,inventory_phase=?,inventory_version=inventory_version+1
      WHERE id=1 AND inventory_id=? AND inventory_version=? AND inventory_phase='scan' AND reserved_bytes=0
      RETURNING inventory_version`)
      .bind(bytes,page.objects.length,staging,other,page.truncated?page.cursor:null,phase,
        row.inventory_id,row.inventory_version).first();
    if(!saved)throw conflict('STORAGE_SCAN_CONFLICT');
  }catch{throw conflict('STORAGE_SCAN_CONFLICT');}
  return progress({...row,inventory_phase:phase,inventory_version:row.inventory_version+1,
    inventory_count:row.inventory_count+page.objects.length});
}

async function receipt(db,id,version){
  // The audit row is the durable commit receipt, keyed by the server scan UUID.
  const row=await db.prepare(`SELECT h.bytes,h.anomaly,a.detail FROM storage_history h
    JOIN storage_audit a ON a.id=h.id AND a.target=h.id AND a.action='inventory' WHERE h.id=?`).bind(id).first();
  if(!row)return null;
  let detail;try{detail=JSON.parse(row.detail);}catch{throw new StorageCapacityError();}
  if(detail.inventory_version!==version)throw conflict('STORAGE_FINALIZE_CONFLICT');
  return{complete:true,phase:'finalize',inventory_id:id,inventory_version:version,
    bytes:row.bytes,anomaly:row.anomaly,replayed:true};
}

// Separate HTTP invocation: no R2 LIST, no archive, no mail delivery.
export async function finalizeInventory(env,id,version){
  writer(env);const db=env.DB,row=await capacityRow(db);
  if(row.inventory_id!==id){
    const saved=await receipt(db,id,version);if(saved)return saved;
    throw conflict('STORAGE_FINALIZE_NOT_READY');
  }
  if(row.inventory_phase!=='ready'||row.inventory_cursor!==null||row.inventory_version!==version||row.reserved_bytes)
    throw conflict('STORAGE_FINALIZE_NOT_READY');
  const total=row.inventory_bytes,at=nowSeconds();
  if(!Number.isSafeInteger(total)||total<0)throw new StorageCapacityError();
  const anomaly=row.anomaly??(row.observed_at!==null&&total>row.used_bytes?'UNACCOUNTED_GROWTH':null);
  const recovered=row.observed_at!==null&&row.blocked&&total<STORAGE.resume&&!anomaly;
  const writes=[
    db.prepare(`INSERT INTO storage_history(id,created_at,bytes,reserved_bytes,object_count,staging_bytes,other_bytes,anomaly)
      SELECT inventory_id,?,inventory_bytes,0,inventory_count,inventory_staging,inventory_other,? FROM storage_capacity WHERE id=1`).bind(at,anomaly),
    db.prepare(`INSERT INTO storage_audit VALUES(?,?,'inventory',?,?)`).bind(id,at,id,
      JSON.stringify({bytes:total,objects:row.inventory_count,anomaly,inventory_version:version})),
    db.prepare(`UPDATE storage_capacity SET used_bytes=inventory_bytes,observed_at=?,trusted_until=?,
      inventory_id=NULL,inventory_cursor=NULL,inventory_phase=NULL,inventory_version=inventory_version+1,anomaly=?,
      blocked=CASE WHEN ? IS NOT NULL OR inventory_bytes>=9500000000 THEN 1 WHEN inventory_bytes<9000000000 THEN 0 ELSE blocked END,
      cleanup_requested=CASE WHEN inventory_bytes<=8500000000 THEN 0 WHEN inventory_bytes>=9000000000 THEN 1 ELSE cleanup_requested END WHERE id=1`)
      .bind(at,at+STORAGE.freshSeconds,anomaly,anomaly),
  ];
  for(const kind of [...(total>=STORAGE.cleanupStart?['90']:[]),...(total>=STORAGE.stop?['95']:[]),...(recovered?['recovered']:[])])
    writes.push(db.prepare("INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,?,?,?) ON CONFLICT(episode,kind) DO NOTHING")
      .bind(crypto.randomUUID(),row.episode,kind,at));
  if(recovered)writes.push(db.prepare('UPDATE storage_capacity SET episode=episode+1 WHERE id=1'));
  try{await authAtomic(db,[guard(row)],writes);}
  catch{
    const saved=await receipt(db,id,version);if(saved)return saved;
    throw conflict('STORAGE_FINALIZE_CONFLICT');
  }
  return{complete:true,phase:'finalize',inventory_id:id,inventory_version:version,bytes:total,anomaly,replayed:false};
}
