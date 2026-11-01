// Only pre-0025 databases can lack cold metadata. A partial/damaged current
// schema or any other D1 error must fail closed, before a private object read.
export const COLD_SCHEMA_MARKERS="SELECT name FROM sqlite_master WHERE name IN('storage_capacity','storage_reservations','storage_audit','cold_proofs','prelaunch_reset_control','manual_cleanup_cold_owner')";
export async function legacyProofMetadata(db,read,legacyRead){
 try{return await read();}catch(error){
  let at=error,missing=false;
  for(let n=0;at&&n<4;n++,at=at.cause)if(/no such table:\s*(?:main\.)?cold_proofs(?:\b|$)/i.test(String(at.message)))missing=true;
  if(!missing)throw error;
  const current=await db.prepare(COLD_SCHEMA_MARKERS+' LIMIT 1').first();
  if(current)throw error;
  return legacyRead();
 }
}
export const proofStorageState=(db,key)=>legacyProofMetadata(db,
 ()=>db.prepare('SELECT p.state FROM case_files f JOIN cold_proofs p ON p.file_id=f.id WHERE f.object_key=?').bind(key).first(),()=>null);
