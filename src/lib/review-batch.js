import {AdminError} from './admin-identity.js';
import {CASE_ID_PATTERN} from './case-keys.js';
import {adminCase,applyReview} from './admin-store.js';
import {reviewInput} from './case-review.js';
// Four independent transactions per request, bounded for Workers Free/D1.
// The browser sequences chunks; there is no filter-based or wildcard approval.
export const REVIEW_BATCH_LIMIT=4;
export function batchReviewInput(body){
 const invalid=()=>{throw new AdminError(400,'INVALID_REVIEW_BATCH','請提供最多四筆明確案件 ID 與版本。');};
 if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==1 || !Array.isArray(body.cases) || body.cases.length<1 || body.cases.length>REVIEW_BATCH_LIMIT)invalid();
 const seen=new Set();
 for(const row of body.cases){
  if(!row || typeof row!=='object' || Array.isArray(row) || Object.keys(row).length!==2 || typeof row.case_id!=='string' || !CASE_ID_PATTERN.test(row.case_id) || !Number.isSafeInteger(row.expected_version) || row.expected_version<0 || row.expected_version>=Number.MAX_SAFE_INTEGER || seen.has(row.case_id))invalid();
  seen.add(row.case_id);
 }
 return body.cases;
}
async function acknowledgedApproval(db,item){
 const row=await db.prepare(`SELECT c.case_id,c.status,c.version,c.points_awarded,c.point_status,c.review_stage,c.review_risk_reason
  FROM cases c JOIN admin_audit_logs a ON a.target_id=c.case_id AND a.target_type='case' AND a.action='approve' AND a.target_version=?
  WHERE c.case_id=? AND c.status IN ('approved','completed')`).bind(item.expected_version+1,item.case_id).first();
 return row?{...row,outcome:'already_approved'}:null;
}
export async function batchApprove(db,actor,items){
 const results=[];
 for(const item of items){
  try{
   const row=await adminCase(db,item.case_id);
   if(!row)throw new AdminError(404,'CASE_NOT_FOUND','案件不存在。');
   if(row.status==='approved'||row.status==='completed'){
    const prior=await acknowledgedApproval(db,item);if(prior){results.push({ok:true,...prior});continue;}
   }
   if(row.review_stage!=='initial'||row.review_risk_reason!==null)throw new AdminError(409,'DETAILED_REVIEW_REQUIRED','案件需要詳細審核。');
   const input={...reviewInput({action:'approve',expected_version:item.expected_version},actor.role),initialOnly:true};
   const result=await applyReview(db,actor,row,input);
   results.push({ok:true,...result,outcome:'approved'});
  }catch(error){
   // A lost acknowledgement is resolved only through the authoritative audit,
   // never by issuing a second award or inventing success from a stale snapshot.
   try{const prior=await acknowledgedApproval(db,item);if(prior){results.push({ok:true,...prior});continue;}}catch{}
   results.push({ok:false,case_id:item.case_id,code:error instanceof AdminError?error.code:'ADMIN_SERVICE_UNAVAILABLE',status:error instanceof AdminError?error.status:503});
  }
 }
 return {results,succeeded:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length};
}
// Stateless, bounded keyset pages. The confirmation cutoff excludes new cases
// and cases changed after the administrator saw the count. Every POST still
// carries exact IDs/versions and revalidates the existing review transaction.
export async function initialReviewPage(db,url){
 const p=url.searchParams,invalid=()=>{throw new AdminError(400,'INVALID_REVIEW_BATCH','Invalid review page');};
 if([...p.keys()].some(k=>!['cutoff','cursor'].includes(k))||['cutoff','cursor'].some(k=>p.getAll(k).length>1))invalid();
 const cutoff=p.get('cutoff')??new Date().toISOString();
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff)||!Number.isFinite(Date.parse(cutoff))||Date.parse(cutoff)>Date.now()+1000)invalid();
 let cursor=null;
 if(p.has('cursor')){try{cursor=JSON.parse(atob(p.get('cursor')));}catch{invalid();}
   if(!Array.isArray(cursor)||cursor.length!==2||typeof cursor[0]!=='string'||!Number.isFinite(Date.parse(cursor[0]))||typeof cursor[1]!=='string'||cursor[1].length>100)invalid();}
 const scope="status='pending' AND review_stage='initial' AND review_risk_reason IS NULL AND created_at<=? AND updated_at<=?";
 if(!p.has('cutoff')){
   const row=await db.prepare(`SELECT COUNT(*) total FROM cases WHERE ${scope}`).bind(cutoff,cutoff).first();
   return {total:row.total,cutoff,cases:[],next_cursor:null};
 }
 const rows=(await db.prepare(`SELECT case_id,version,created_at,id FROM cases WHERE ${scope}
   ${cursor?'AND (created_at>? OR (created_at=? AND id>?))':''} ORDER BY created_at,id LIMIT 21`)
   .bind(cutoff,cutoff,...(cursor?[cursor[0],cursor[0],cursor[1]]:[])).all()).results;
 const selected=rows.slice(0,20),last=selected.at(-1);
 return {cutoff,cases:selected.map(r=>({case_id:r.case_id,expected_version:r.version})),
   next_cursor:rows.length>20?btoa(JSON.stringify([last.created_at,last.id])):null};
}
export async function reviewBatchStatus(db,items){
 const results=[];
 for(const item of items){
   const prior=await acknowledgedApproval(db,item);
   results.push(prior?{ok:true,...prior}:{ok:false,case_id:item.case_id,code:'REVIEW_RESULT_UNCONFIRMED',status:409});
 }
 return {results,succeeded:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length};
}
