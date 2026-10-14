import {CaseError} from '../api/case-validation.js';
import {requireSubmissionsEnabled,requireSubmissionRow} from './submission-gate.js';
import {requireCaseCampaign,requireCaseCampaignRow} from './campaign-policy.js';
import {requireCompletedUploadSnapshot} from './completed-uploads.js';

// One authoritative request-local snapshot, never a cross-request cache. Commit
// guards still recheck gate/campaign/session/consumption after R2 archival.
export const CASE_POLICY_SQL=`SELECT s.submissions_enabled,s.submissions_message,
  p.campaign_id,p.category,p.solo_target,p.status,p.start_at,p.end_at,p.vote_start_date,p.vote_end_date,p.version,
  u.session_id,u.manifest_hash,u.consumed_case_id,u.expires_at,
  f.object_key AS key,f.content_type AS type,f.size,f.etag,h.sha256,
  i.storage_version,i.proof_id,i.object_key,i.state AS intent_state,i.member_id AS intent_member_id,
  i.guest_capability_hash,i.campaign_id AS intent_campaign_id,i.expected_sha256,i.content_type AS intent_type,i.size AS intent_size
  FROM (SELECT 1) anchor LEFT JOIN submission_settings s ON s.id=1
  LEFT JOIN campaigns p ON p.campaign_id=? LEFT JOIN completed_uploads u ON u.session_id=?
  LEFT JOIN completed_upload_files f ON f.session_id=u.session_id
  LEFT JOIN proof_upload_checksums h ON h.object_key=f.object_key
  LEFT JOIN proof_upload_intents i ON i.session_id=u.session_id ORDER BY f.object_key`;
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
  if(policy?.storage_version===2) {
    if(policy.intent_state!=='sealed'||policy.intent_campaign_id!==input.campaignId||
      policy.intent_member_id!==(input.memberId??null)||(!input.memberId&&policy.guest_capability_hash!==input.guestCapabilityHash))
      throw new CaseError(403,'UPLOAD_OWNER_MISMATCH','Proof does not belong to this submission');
    if(files.length!==1||files[0].key!==policy.object_key||files[0].sha256!==policy.expected_sha256||files[0].size!==policy.intent_size||files[0].type!==policy.intent_type)
      throw new CaseError(409,'UPLOAD_CHANGED','Sealed proof metadata changed');
    completed.intent={proof_id:policy.proof_id,object_key:policy.object_key,size:policy.intent_size,content_type:policy.intent_type,expected_sha256:policy.expected_sha256};
  } else if(files.some(f=>f.key.startsWith('proofs/final/')))throw new CaseError(409,'UPLOAD_INTENT_INVALID','Final proof intent is missing');
  return {campaign,completed};
}
