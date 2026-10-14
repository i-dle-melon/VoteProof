export const DUPLICATE_LEASE_SECONDS = 120;
export const MAX_DUPLICATE_ATTEMPTS = 5;
const timestamp = seconds => new Date(seconds * 1000).toISOString();
export const duplicateNow = () => Math.floor(Date.now() / 1000);
export const CANONICAL_SQL = `SELECT file_id,case_internal_id FROM proof_duplicate_jobs
  WHERE member_id=? AND campaign_id=? AND sha256=?
  ORDER BY case_created_at,case_internal_id,file_id LIMIT 1`;
const eligible = `member_id IS NOT NULL AND attempts<5 AND
  ((state IN('pending','failed') AND next_attempt_at<=?) OR (state='processing' AND lease_until<=?))`;
// One group / one proof per invocation. Group generation CAS protects a new
// earlier original from a concurrent reconciliation advancing an old cursor.
export async function reconcileDuplicateGroup(db,now=duplicateNow()) {
  const group=await db.prepare('SELECT * FROM proof_duplicate_groups WHERE dirty=1 ORDER BY member_id,campaign_id,sha256 LIMIT 1').first();
  if(!group)return;
  const job=await db.prepare('SELECT file_id,state,analyzed_canonical_file_id FROM proof_duplicate_jobs WHERE member_id=? AND campaign_id=? AND sha256=? AND file_id>? ORDER BY file_id LIMIT 1')
    .bind(group.member_id,group.campaign_id,group.sha256,group.after_file_id).first();
  const guard='EXISTS(SELECT 1 FROM proof_duplicate_groups WHERE member_id=? AND campaign_id=? AND sha256=? AND generation=? AND after_file_id=?)';
  const args=[group.member_id,group.campaign_id,group.sha256,group.generation,group.after_file_id];
  await db.batch([
    ...(job?[db.prepare(`UPDATE proof_duplicate_jobs SET state='pending',attempts=0,next_attempt_at=0,
      lease_token=NULL,lease_until=NULL,claimed_at=NULL,canonical_file_id=NULL,canonical_case_id=NULL,
      analyzed_canonical_file_id=NULL,completed_at=NULL,last_error=NULL,updated_at=?
      WHERE file_id=? AND state IN('clear','exact_duplicate') AND analyzed_canonical_file_id!=? AND ${guard}`)
      .bind(timestamp(now),job.file_id,group.canonical_file_id,...args)]:[]),
    db.prepare('UPDATE proof_duplicate_groups SET after_file_id=?,dirty=? WHERE member_id=? AND campaign_id=? AND sha256=? AND generation=? AND after_file_id=?')
      .bind(job?.file_id??group.after_file_id,job?1:0,...args),
  ]);
}
export async function claimDuplicateJob(db, requestId, now = duplicateNow()) {
  await reconcileDuplicateGroup(db,now);
  // Bounded crash recovery: terminalize one exhausted lease per invocation.
  await db.prepare(`UPDATE proof_duplicate_jobs SET state='failed',lease_until=NULL,
    next_attempt_at=NULL,last_error='ATTEMPTS_EXHAUSTED',updated_at=? WHERE file_id IN
    (SELECT file_id FROM proof_duplicate_jobs WHERE state='processing' AND lease_until<=? AND attempts>=5
     ORDER BY lease_until,file_id LIMIT 1)`).bind(timestamp(now), now).run();
  // Mapping and claim commit together. A lost ACK reuses the mapping; a request
  // ID can never migrate to a different job. Distinct claims serialize in D1.
  const results = await db.batch([
    db.prepare(`INSERT INTO proof_duplicate_requests(request_id,file_id,created_at)
      SELECT ?,file_id,? FROM proof_duplicate_jobs WHERE ${eligible}
      ORDER BY case_created_at,case_internal_id,file_id LIMIT 1 ON CONFLICT(request_id) DO NOTHING`)
      .bind(requestId, now, now, now),
    db.prepare(`UPDATE proof_duplicate_jobs SET state='processing',attempts=attempts+1,
      lease_token=?,lease_until=?,claimed_at=?,next_attempt_at=NULL,last_error=NULL,updated_at=?
      WHERE file_id=(SELECT file_id FROM proof_duplicate_requests WHERE request_id=?) AND ${eligible}
      AND NOT EXISTS(SELECT 1 FROM proof_duplicate_requests WHERE request_id=? AND created_at<?)
      RETURNING *`).bind(requestId, now + DUPLICATE_LEASE_SECONDS, now, timestamp(now), requestId, now, now, requestId, now),
  ]);
  if (results[1].results?.[0]) return results[1].results[0];
  return db.prepare(`SELECT j.* FROM proof_duplicate_requests r JOIN proof_duplicate_jobs j ON j.file_id=r.file_id WHERE r.request_id=?`)
    .bind(requestId).first();
}
export async function failDuplicateJob(db, job, code = 'PROCESSOR_UNAVAILABLE', now = duplicateNow()) {
  const safeCode = ['SOURCE_CHANGED','PROCESSOR_UNAVAILABLE'].includes(code) ? code : 'PROCESSOR_UNAVAILABLE';
  await db.prepare(`UPDATE proof_duplicate_jobs SET state='failed',last_error=?,lease_until=NULL,
    next_attempt_at=?,updated_at=? WHERE file_id=? AND state='processing' AND lease_token=? AND attempts=? AND lease_until>?`)
    .bind(safeCode, safeCode==='SOURCE_CHANGED'||job.attempts>=5 ? null : now+Math.min(3600,30*2**(job.attempts-1)),
      timestamp(now), job.file_id, job.lease_token, job.attempts, now).run();
}
async function receiptState(db,fileId) {
  const row=await db.prepare(`SELECT j.state,j.lease_token,j.analyzed_canonical_file_id,g.canonical_file_id current_canonical
    FROM proof_duplicate_jobs j LEFT JOIN proof_duplicate_groups g
    ON g.member_id=j.member_id AND g.campaign_id=j.campaign_id AND g.sha256=j.sha256 WHERE j.file_id=?`).bind(fileId).first();
  if(row && ['clear','exact_duplicate'].includes(row.state) && row.analyzed_canonical_file_id!==row.current_canonical)row.state='pending';
  return row;
}
export async function processDuplicateJob(db, job, now = duplicateNow()) {
  if (!job) return {state:'idle'};
  if (job.state !== 'processing') return {state:(await receiptState(db,job.file_id))?.state??'lease_conflict',file_id:job.file_id};
  if (job.lease_until <= now) return {state:'lease_expired',file_id:job.file_id};
  try {
    const source = await db.prepare(`SELECT h.sha256,h.source_etag,h.source_size,f.etag,f.size,
      c.id,c.created_at,c.member_id,c.campaign_id FROM proof_exact_hashes h
      JOIN case_files f ON f.id=h.file_id JOIN cases c ON c.id=f.case_id WHERE h.file_id=?`).bind(job.file_id).first();
    if (!source || source.sha256!==job.sha256 || source.source_etag!==source.etag || source.source_size!==source.size ||
      source.id!==job.case_internal_id || source.created_at!==job.case_created_at || source.member_id!==job.member_id || source.campaign_id!==job.campaign_id) {
      await failDuplicateJob(db,job,'SOURCE_CHANGED',now);
    } else {
      // Canonical selection and result are ONE SQL statement. It includes every
      // accepted trusted proof, regardless of job state or processing order.
      await db.prepare(`WITH original AS (${CANONICAL_SQL}) UPDATE proof_duplicate_jobs
        SET state=CASE WHEN file_id=(SELECT file_id FROM original) THEN 'clear' ELSE 'exact_duplicate' END,
          canonical_file_id=CASE WHEN file_id=(SELECT file_id FROM original) THEN NULL ELSE (SELECT file_id FROM original) END,
          canonical_case_id=CASE WHEN file_id=(SELECT file_id FROM original) THEN NULL ELSE (SELECT case_internal_id FROM original) END,
          analyzed_canonical_file_id=(SELECT file_id FROM original),
          lease_until=NULL,next_attempt_at=NULL,last_error=NULL,completed_at=?,updated_at=?
        WHERE file_id=? AND state='processing' AND lease_token=? AND attempts=? AND lease_until>?
        AND EXISTS(SELECT 1 FROM proof_exact_hashes h JOIN case_files f ON f.id=h.file_id JOIN cases c ON c.id=f.case_id
          WHERE h.file_id=proof_duplicate_jobs.file_id AND h.sha256=proof_duplicate_jobs.sha256
          AND h.source_etag=f.etag AND h.source_size=f.size AND c.id=proof_duplicate_jobs.case_internal_id
          AND c.member_id=proof_duplicate_jobs.member_id AND c.campaign_id=proof_duplicate_jobs.campaign_id
          AND c.created_at=proof_duplicate_jobs.case_created_at)`)
        .bind(job.member_id,job.campaign_id,job.sha256,timestamp(now),timestamp(now),job.file_id,job.lease_token,job.attempts,now).run();
    }
  } catch {
    // Never affect submission/review/points/backup. If the failure ACK also
    // fails, the durable active lease remains reclaimable after expiry.
    try { await failDuplicateJob(db,job,'PROCESSOR_UNAVAILABLE',now); } catch {}
  }
  const row = await receiptState(db,job.file_id);
  return {state:row?.lease_token===job.lease_token ? row.state : 'lease_conflict',file_id:job.file_id};
}
