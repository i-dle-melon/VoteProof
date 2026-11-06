import {AdminError} from './admin-identity.js';
import {adminCase,applyReview} from './admin-store.js';
import {reviewInput} from './case-review.js';
import {batchReviewInput} from './review-batch.js';

// Explicit selections use the existing single-case review contract. The fast
// initial-review endpoint and its initialOnly guard remain unchanged.
export function manualReviewBatchInput(body,role){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['cases','action','reason','duplicate_of_case_id','review_risk_reason'].includes(k)))
  throw new AdminError(400,'INVALID_REVIEW_BATCH','請提供明確案件及審核操作。');
 const items=batchReviewInput({cases:body.cases});
 const {cases,...fields}=body;
 const input=reviewInput({...fields,expected_version:0},role);
 return {items,input};
}

async function acknowledgedReview(db,actor,item,input){
 const row=await db.prepare(`SELECT c.case_id,c.status,c.version,c.points_awarded,c.point_status,c.review_stage,c.review_risk_reason,
  a.action AS audit_action FROM cases c JOIN admin_audit_logs a ON a.id=c.last_review_id
  WHERE c.case_id=? AND c.version=? AND a.target_type='case' AND a.target_id=c.case_id
  AND a.target_version=c.version AND a.admin_member_id=?
  AND ((a.action=? AND a.reason IS ?
    AND (? IS NULL OR json_extract(a.after_json,'$.duplicate_of_case_id')=?)
    AND (? IS NULL OR json_extract(a.after_json,'$.review_risk_reason')=?))
   OR (?='approve' AND a.action='mark_duplicate' AND c.status='duplicate'
    AND json_extract(a.after_json,'$.automatic_exact_review')=1
    AND json_extract(a.after_json,'$.requested_action')='approve'))`)
 .bind(item.case_id,item.expected_version+1,actor.member.member_id,input.action,input.reason,
  input.duplicateCaseId,input.duplicateCaseId,input.riskReason,input.riskReason,input.action).first();
 if(!row)return null;
 if(row.status!==input.transition.to&&!(input.action==='approve'&&row.audit_action==='mark_duplicate'&&row.status==='duplicate'))return null;
 const {audit_action,...result}=row;
 return {...result,outcome:row.status==='duplicate'&&input.action==='approve'?'already_duplicate':'already_reviewed'};
}

export async function manualReviewBatch(db,actor,items,input,{statusOnly=false,exactClassification=false}={}){
 const results=[];let halted=false;
 for(const item of items){
  if(halted){results.push({ok:false,case_id:item.case_id,code:'REVIEW_NOT_SUBMITTED',status:409});continue;}
  try{
   if(statusOnly){
    const prior=await acknowledgedReview(db,actor,item,input);
    results.push(prior?{ok:true,...prior}:{ok:false,unknown:true,case_id:item.case_id,code:'REVIEW_RESULT_UNCONFIRMED',status:409});continue;
   }
   const row=await adminCase(db,item.case_id);
   if(!row)throw new AdminError(404,'CASE_NOT_FOUND','案件不存在。');
   // A still-current version cannot already contain this review. Read its
   // audit only on replay/conflict or uncertainty, not on every fresh item.
   if(row.version!==item.expected_version){const prior=await acknowledgedReview(db,actor,item,input);if(prior){results.push({ok:true,...prior});continue;}}
   const result=await applyReview(db,actor,row,{...input,expectedVersion:item.expected_version,exactClassification});
   results.push({ok:true,...result,outcome:result.review_outcome==='auto_duplicate'?'duplicate':'reviewed'});
  }catch(error){
   const unknown=!(error instanceof AdminError)||error.status>=500;
   try{const prior=await acknowledgedReview(db,actor,item,input);if(prior){results.push({ok:true,...prior});halted=unknown;continue;}}catch{}
   results.push({ok:false,unknown,case_id:item.case_id,code:unknown?'REVIEW_RESULT_UNCONFIRMED':error.code,status:unknown?503:error.status});
   if(unknown||error.status===401||error.status===403)halted=true;
  }
 }
 return {results,succeeded:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok&&!r.unknown&&r.code!=='REVIEW_NOT_SUBMITTED').length,unknown:results.filter(r=>r.unknown).length};
}
