import { sha256 } from '@noble/hashes/sha2.js';
import { UPLOAD_LIMITS } from '../api/upload-validation.js';

export class ProofHashError extends Error {
  constructor(code) { super(code); this.code=code; }
}
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export function proofHashStream(body, expectedSize) {
  if(!body || !Number.isSafeInteger(expectedSize) || expectedSize<1 || expectedSize>UPLOAD_LIMITS.maxFileBytes) throw new ProofHashError('PROOF_HASH_SOURCE_CHANGED');
  let finished=false,result;
  // Deterministic fallback for stream-only test doubles. Real R2 objects use
  // their native read method in verifiedProofObject below.
  const hash=sha256.create();let read=0;
  const stream=body.pipeThrough(new TransformStream({
    transform(chunk,controller){
      if(!(chunk instanceof Uint8Array))throw new ProofHashError('PROOF_HASH_SOURCE_CHANGED');
      read+=chunk.byteLength;if(read>expectedSize)throw new ProofHashError('PROOF_HASH_SOURCE_CHANGED');
      hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush(){
      if(read!==expectedSize)throw new ProofHashError('PROOF_HASH_SOURCE_CHANGED');
      result=hex(hash.digest());
      finished=true;
    },
  }));
  return {stream,digest(){if(!finished)throw new ProofHashError('PROOF_HASH_INCOMPLETE');return result;}};
}
export async function verifiedProofObject(object,expectedSize){
  // This accepts a server-provided R2ObjectBody, never a browser digest or a
  // client-declared content length. Callers already verified ETag/MIME and the
  // provider's actual object size. R2's full-object read is bounded by that size.
  if(!object?.body||object.size!==expectedSize||!Number.isSafeInteger(expectedSize)||expectedSize<1||expectedSize>UPLOAD_LIMITS.maxFileBytes)throw new ProofHashError('PROOF_HASH_SOURCE_CHANGED');
  // Miniflare's host-side RPC body accessor transfers the stream. Once accessed,
  // read that local stream instead of invoking another remote body read method.
  const bytes=typeof FixedLengthStream==='function'&&typeof object.arrayBuffer==='function'?await object.arrayBuffer():await new Response(proofHashStream(object.body,expectedSize).stream).arrayBuffer();
  if(bytes.byteLength!==expectedSize)throw new ProofHashError('PROOF_HASH_SOURCE_CHANGED');
  const digest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
  return {bytes,digest};
}
export function exactHashInsert(db,file,now) {
  return db.prepare(`INSERT INTO proof_exact_hashes(file_id,sha256,verified_at,source_etag,source_size,case_created_at,case_internal_id)
    SELECT ?,?,?,?,?,c.created_at,c.id FROM case_files f JOIN cases c ON c.id=f.case_id
    WHERE f.id=? AND f.etag=? AND f.size=? ON CONFLICT(file_id) DO NOTHING`)
    .bind(file.id,file.sha256,now,file.etag,file.size,file.id,file.etag,file.size);
}

export function exactRelationship(current,previous) {
  const same_campaign=current.campaign_id===previous.campaign_id;
  const known=!!current.member_id&&!!previous.member_id,same_member=known?current.member_id===previous.member_id:null;
  return {same_campaign,same_member,relationship:!known?'guest_exact_unknown':same_member?(same_campaign?'same_member_same_campaign':'same_member_other_campaign'):'cross_member_exact'};
}
// Each proof performs one indexed historical range seek capped at 101 entries.
// json_each joins only those candidates, so the final sort cannot scan an entire
// popular digest group. Current cases contain at most five uploaded proofs.
export const EXACT_EVIDENCE_SQL=`WITH current AS (
  SELECT f.id file_id,h.sha256,c.id case_internal_id,c.created_at,c.member_id,c.campaign_id
  FROM cases c JOIN case_files f ON f.case_id=c.id JOIN proof_exact_hashes h ON h.file_id=f.id WHERE c.id=?
), bounded AS (
  SELECT c.*,candidate.value prior_file_id FROM current c,json_each((
    SELECT json_group_array(file_id) FROM (
      SELECT prior.file_id FROM proof_exact_hashes prior
      WHERE prior.sha256=c.sha256 AND (prior.case_created_at,prior.case_internal_id)<(c.created_at,c.case_internal_id)
      ORDER BY prior.case_created_at DESC,prior.case_internal_id DESC,prior.file_id LIMIT 101
    )
  )) candidate
)
SELECT b.file_id,p.case_id previous_case_id,p.status previous_status,
  p.created_at previous_submitted_at,b.member_id current_member_id,p.member_id previous_member_id,
  b.campaign_id current_campaign_id,p.campaign_id previous_campaign_id
FROM bounded b JOIN case_files pf ON pf.id=b.prior_file_id JOIN cases p ON p.id=pf.case_id
ORDER BY p.created_at DESC,p.id DESC,b.file_id LIMIT 101`;
export async function adminExactEvidence(db,caseInternalId) {
  // Prior means earlier created_at; UUID breaks ties without treating replay as a new event.
  const coverage=await db.prepare(`SELECT COUNT(f.id) files,COUNT(h.file_id) verified FROM case_files f
    LEFT JOIN proof_exact_hashes h ON h.file_id=f.id WHERE f.case_id=?`).bind(caseInternalId).first();
  const rows=(await db.prepare(EXACT_EVIDENCE_SQL).bind(caseInternalId).all()).results;
  const matches=rows.slice(0,100).map(r=>({file_id:r.file_id,previous_case_id:r.previous_case_id,
    previous_status:r.previous_status,previous_submitted_at:r.previous_submitted_at,
    ...exactRelationship({member_id:r.current_member_id,campaign_id:r.current_campaign_id},{member_id:r.previous_member_id,campaign_id:r.previous_campaign_id})}));
  return {algorithm:'sha256',version:1,hash_state:coverage.verified>0?(coverage.verified===coverage.files?'verified':'partial'):'not_verified',exact_match_detected:matches.length>0,matches,truncated:rows.length>100,
    policy:'review_evidence_only',limitations:'Exact bytes only; equal size and visual similarity are not matches'};
}

export async function backfillExactHashes({db,bucket},{dryRun=true,limit=10,after=''}={}) {
  if(typeof dryRun!=='boolean'||!Number.isSafeInteger(limit)||limit<1||limit>20||typeof after!=='string'||after.length>100)throw new ProofHashError('INVALID_PROOF_HASH_BATCH');
  const rows=(await db.prepare(`SELECT f.id,f.object_key,f.etag,f.size,f.content_type FROM case_files f
    WHERE f.id>? AND NOT EXISTS(SELECT 1 FROM proof_exact_hashes h WHERE h.file_id=f.id) ORDER BY f.id LIMIT ?`).bind(after,limit+1).all()).results;
  const selected=rows.slice(0,limit),results=[];
  for(const file of selected){
    try{
      const object=await bucket.get(file.object_key,{onlyIf:{etagMatches:file.etag}});
      if(!object)throw new ProofHashError('PROOF_HASH_SOURCE_MISSING');
      if(!object?.body||object.etag!==file.etag||object.size!==file.size||object.httpMetadata?.contentType!==file.content_type){await object?.body?.cancel();throw new ProofHashError('PROOF_HASH_SOURCE_CHANGED');}
      const {digest}=await verifiedProofObject(object,file.size);let written=0;
      if(!dryRun){const result=await exactHashInsert(db,{...file,sha256:digest},new Date().toISOString()).run();written=result.meta.changes;
        const saved=await db.prepare('SELECT sha256,source_etag,source_size FROM proof_exact_hashes WHERE file_id=?').bind(file.id).first();
        if(saved?.sha256!==digest||saved.source_etag!==file.etag||saved.source_size!==file.size)throw new ProofHashError('PROOF_HASH_SOURCE_CHANGED');}
      results.push({file_id:file.id,state:dryRun?'would_hash':'verified',written});
    }catch(error){results.push({file_id:file.id,state:'failed',code:error instanceof ProofHashError?error.code:'PROOF_HASH_UNAVAILABLE'});}
  }
  return {dry_run:dryRun,scanned:selected.length,written:results.reduce((s,r)=>s+(r.written??0),0),results,next_cursor:rows.length>limit?selected.at(-1).id:null};
}
