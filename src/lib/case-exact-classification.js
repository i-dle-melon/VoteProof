import {CaseError} from '../api/case-validation.js';
export const exactClassificationEnabled=env=>env.EXACT_DUPLICATE_CLASSIFICATION_ENABLED==='true';
export async function requireExactPolicy(env){
 if(!exactClassificationEnabled(env))return false;
 if(env.PRELAUNCH_RESET_FENCE_ENABLED!=='true')throw new CaseError(503,'EXACT_POLICY_UNAVAILABLE','檔案比對尚未就緒');
 let row;try{row=await env.DB.prepare('SELECT schema_version,enabled FROM case_sha256_control WHERE id=1').first();}catch{}
 if(row?.schema_version!==1||row.enabled!==1)throw new CaseError(503,'EXACT_POLICY_UNAVAILABLE','檔案比對尚未就緒');
 return true;
}
export function exactDecisionStatement(db,input,record,file){
 return db.prepare(`WITH current AS (SELECT * FROM proof_upload_intents WHERE session_id=? AND proof_id=? AND object_key=?
 AND expected_sha256=? AND size=? AND member_id=? AND campaign_id=? AND state='prepared' AND consumed_case_id IS NULL),
 matched AS MATERIALIZED (SELECT v.case_internal_id,v.status,v.version FROM case_verified_sha256_sources v JOIN current i
 ON v.member_id=i.member_id AND v.campaign_id=i.campaign_id AND v.sha256=i.expected_sha256
 WHERE v.status IN('approved','completed','pending')
 ORDER BY CASE WHEN v.status IN('approved','completed') THEN 0 ELSE 1 END,v.created_at,v.case_internal_id LIMIT 1)
 INSERT INTO case_sha256_decisions(case_internal_id,intent_id,decision,sha256,reference_case_id,reference_version,created_at)
 SELECT ?,i.session_id,CASE WHEN m.status IN('approved','completed') THEN 'exact_duplicate'
 WHEN m.status='pending' THEN 'pending_match'
 WHEN EXISTS(SELECT 1 FROM cases old INDEXED BY idx_case_sha_legacy_scope
 WHERE old.member_id IS NOT NULL AND old.upload_intent_id IS NULL
 AND old.member_id=i.member_id AND old.campaign_id=i.campaign_id AND NOT EXISTS(
 SELECT 1 FROM case_verified_sha256_sources v WHERE v.case_internal_id=old.id)) THEN 'unknown' ELSE 'clear' END,
 i.expected_sha256,m.case_internal_id,m.version,? FROM current i LEFT JOIN matched m ON 1=1
 WHERE EXISTS(SELECT 1 FROM case_sha256_control WHERE id=1 AND schema_version=1 AND enabled=1) RETURNING decision`)
 .bind(input.sessionId,file.id,file.key,file.sha256,file.size,input.memberId,input.campaignId,record.id,record.now);
}
export async function exactDecision(db,id){
 const row=await db.prepare(`SELECT d.decision,d.created_at,d.reference_version,c.case_id AS reference_case_id,
 c.version AS current_reference_version,c.status AS current_reference_status
 FROM case_sha256_decisions d LEFT JOIN cases c ON c.id=d.reference_case_id WHERE d.case_internal_id=?`).bind(id).first();
 return row?{...row,algorithm:'sha256',scope:'same_member_same_campaign',source_changed:row.reference_version!==null&&row.reference_version!==row.current_reference_version}:null;
}
export async function exactSubmissionResult(db,id){
 return exactSubmissionResponse(await db.prepare('SELECT decision FROM case_sha256_decisions WHERE case_internal_id=?').bind(id).first());
}
export const exactSubmissionResponse=row=>row?{status:row.decision==='exact_duplicate'?'duplicate':'pending',exact_classification:{decision:row.decision}}:{status:'pending'};
