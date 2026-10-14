import {CaseError} from '../api/case-validation.js';
import {requireSubmissionsEnabled,requireSubmissionRow} from './submission-gate.js';
import {requireCaseCampaign,requireCaseCampaignRow} from './campaign-policy.js';
import {requireCompletedUploadSnapshot} from './completed-uploads.js';

// One authoritative request-local snapshot, never a cross-request cache. Commit
// guards still recheck gate/campaign/session/consumption after R2 archival.
export const CASE_POLICY_SQL=`SELECT s.submissions_enabled,s.submissions_message,
  p.campaign_id,p.category,p.solo_target,p.status,p.start_at,p.end_at,p.vote_start_date,p.vote_end_date,p.version,
  u.session_id,u.manifest_hash,u.consumed_case_id,u.expires_at,
  f.object_key AS key,f.content_type AS type,f.size,f.etag,h.sha256
  FROM (SELECT 1) anchor LEFT JOIN submission_settings s ON s.id=1
  LEFT JOIN campaigns p ON p.campaign_id=? LEFT JOIN completed_uploads u ON u.session_id=?
  LEFT JOIN completed_upload_files f ON f.session_id=u.session_id
  LEFT JOIN proof_upload_checksums h ON h.object_key=f.object_key ORDER BY f.object_key`;
export async function casePreflight(db,input) {
  let results;
  try { results=(await db.prepare(CASE_POLICY_SQL).bind(input.campaignId,input.sessionId).all()).results; }
  catch {
    // Preserve fail-closed priority and sanitized errors when the snapshot read fails.
    await requireSubmissionsEnabled(db);await requireCaseCampaign(db,input);
    throw new CaseError(500,'DATABASE_ERROR','Case storage is unavailable');
  }
  const policy=results[0];
  requireSubmissionRow(policy?.submissions_enabled==null?null:policy);
  const campaign=requireCaseCampaignRow(policy?.campaign_id?policy:null,input);
  const files=results.filter(row=>row.key!=null).map(({key,type,size,etag,sha256})=>({key,type,size,etag,sha256}));
  const completed=await requireCompletedUploadSnapshot(policy?.session_id?policy:null,files,input.keys);
  return {campaign,completed};
}
