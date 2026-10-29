// Server-built admission only: known capacity rejection is a zero-row commit,
// not an exception. The existing reservation Trigger remains authoritative.
export const capacityAdmissionSQL=`EXISTS(SELECT 1 FROM storage_capacity WHERE id=1
 AND blocked=0 AND anomaly IS NULL AND inventory_id IS NULL
 AND trusted_until>CAST(strftime('%s','now') AS INTEGER)
 AND used_bytes+reserved_bytes+?<9500000000)`;

export function storageAdmissionStatements(db,{id,key,size,createdAt,claim}){
 if(!claim)return [db.prepare(`INSERT INTO storage_reservations(id,object_key,bytes,state,created_at)
  SELECT ?,?,?,'reserved',? WHERE ${capacityAdmissionSQL} RETURNING id`).bind(id,key,size,createdAt,size)];
 return [
  db.prepare(`UPDATE proof_upload_intents SET write_token=? WHERE session_id=? AND object_key=? AND size=?
   AND write_token IS NULL AND state IN ('prepared','uploaded')
   AND grant_expires>CAST(strftime('%s','now') AS INTEGER)
   AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${capacityAdmissionSQL}
   RETURNING session_id`).bind(claim.token,claim.sessionId,key,size,size),
  db.prepare(`INSERT INTO storage_reservations(id,object_key,bytes,state,created_at)
   SELECT ?,?,?,'reserved',? WHERE changes()=1 AND EXISTS(
    SELECT 1 FROM proof_upload_intents WHERE session_id=? AND object_key=? AND write_token=?) RETURNING id`)
   .bind(id,key,size,createdAt,claim.sessionId,key,claim.token),
  db.prepare(`SELECT ${capacityAdmissionSQL} AS capacity_allowed`).bind(size),
 ];
}

// Only acknowledged zero-row results from the above statements are a known
// no-op. Missing metadata, partial/mismatched results and thrown ACKs are not.
export function emptyStorageAdmission(results,claim){
 return Array.isArray(results)&&results.length===(claim?3:1)&&
  results.every(r=>r?.success===true)&&
  results.slice(0,claim?2:1).every(r=>r.meta?.changes===0&&r.results?.length===0)&&
  (!claim||results[2].results?.length===1&&[0,1].includes(results[2].results[0].capacity_allowed));
}
