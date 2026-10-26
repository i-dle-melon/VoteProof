// LOCAL synthetic fixtures only. Never emit operation IDs, keys or credentials.
export async function imageMaintenanceSnapshot(db) {
  const rows = async sql => (await db.prepare(sql).all()).results;
  return {
    control: await db.prepare('SELECT mode,version,generation,legacy_status FROM image_maintenance_control WHERE id=1').first(),
    capacity: await db.prepare(`SELECT inventory_id IS NOT NULL AS pinned,inventory_phase,
      reserved_bytes,blocked,anomaly FROM storage_capacity WHERE id=1`).first(),
    operations: await rows('SELECT kind,state,COUNT(*) AS count FROM image_mutation_operations GROUP BY kind,state ORDER BY kind,state'),
    dispatches: await rows('SELECT state,COUNT(*) AS count FROM storage_archive_dispatches GROUP BY state ORDER BY state'),
    deleting: (await db.prepare("SELECT COUNT(*) AS count FROM cold_proofs WHERE state='deleting'").first()).count,
    write_tokens: (await db.prepare('SELECT COUNT(*) AS count FROM proof_upload_intents WHERE write_token IS NOT NULL').first()).count,
  };
}
