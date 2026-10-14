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
    WHERE f.id=? AND f.etag=? AND f.size=? ON CONFLICT(file_id) DO NOTHING RETURNING file_id`)
    .bind(file.id,file.sha256,now,file.etag,file.size,file.id,file.etag,file.size);
}

// Admin reads durable results only; it never classifies or searches a digest.
export const EXACT_EVIDENCE_SQL=`SELECT f.id file_id,h.file_id verified_file_id,j.state stored_state,j.analyzed_canonical_file_id,g.canonical_file_id current_canonical_file_id,j.attempts,j.last_error,
  j.claimed_at,j.lease_until,j.completed_at,j.updated_at,j.canonical_file_id,
  p.case_id canonical_case_id,p.status previous_status,p.created_at previous_submitted_at
  FROM case_files f LEFT JOIN proof_exact_hashes h ON h.file_id=f.id
  LEFT JOIN proof_duplicate_jobs j ON j.file_id=f.id
  LEFT JOIN proof_duplicate_groups g ON g.member_id=j.member_id AND g.campaign_id=j.campaign_id AND g.sha256=j.sha256
  LEFT JOIN cases p ON p.id=j.canonical_case_id WHERE f.case_id=? ORDER BY f.id`;
export async function adminExactEvidence(db,caseInternalId) {
  const rows=(await db.prepare(EXACT_EVIDENCE_SQL).bind(caseInternalId).all()).results;
  const verified=rows.filter(r=>r.verified_file_id).length;
  const analyses=rows.map(({verified_file_id,stored_state,analyzed_canonical_file_id,current_canonical_file_id,...r})=>{
    const stale=['clear','exact_duplicate'].includes(stored_state)&&analyzed_canonical_file_id!==current_canonical_file_id;
    return {...r,state:stale?'pending':stored_state??'unknown',...(stale?{canonical_file_id:null,canonical_case_id:null,previous_status:null,previous_submitted_at:null,completed_at:null}: {})};
  });
  const matches=analyses.filter(r=>r.state==='exact_duplicate').map(r=>({file_id:r.file_id,
    canonical_file_id:r.canonical_file_id,previous_case_id:r.canonical_case_id,
    previous_status:r.previous_status,previous_submitted_at:r.previous_submitted_at,
    same_campaign:true,same_member:true,relationship:'same_member_same_campaign'}));
  return {algorithm:'sha256',version:1,scope:'member_campaign',
    hash_state:verified?(verified===rows.length?'verified':'partial'):'not_verified',
    analyses,exact_match_detected:matches.length>0,matches,truncated:false,policy:'review_evidence_only',
    limitations:'Exact verified bytes within the same member and Campaign only; historical missing hashes remain unknown'};
}

export async function backfillExactHashes({db,bucket},{dryRun=true,limit=10,after='',excludeCases=[]}={}) {
  if(typeof dryRun!=='boolean'||!Number.isSafeInteger(limit)||limit<1||limit>20||typeof after!=='string'||after.length>100||!Array.isArray(excludeCases)||excludeCases.length>20||excludeCases.some(x=>typeof x!=='string'||!/^VP-[0-9]{8}-[A-Z0-9]{16}$/.test(x)))throw new ProofHashError('INVALID_PROOF_HASH_BATCH');
  const rows=(await db.prepare(`SELECT f.id,f.object_key,f.etag,f.size,f.content_type FROM case_files f JOIN cases c ON c.id=f.case_id
    WHERE f.id>? AND ${excludeCases.length?`c.case_id NOT IN(${excludeCases.map(()=>'?').join(',')}) AND `:''}NOT EXISTS(SELECT 1 FROM proof_exact_hashes h WHERE h.file_id=f.id) ORDER BY f.id LIMIT ?`).bind(after,...excludeCases,limit+1).all()).results;
  const selected=rows.slice(0,limit),results=[];
  for(const file of selected){
    try{
      const object=await bucket.get(file.object_key,{onlyIf:{etagMatches:file.etag}});
      if(!object)throw new ProofHashError('PROOF_HASH_SOURCE_MISSING');
      if(!object?.body||object.etag!==file.etag||object.size!==file.size||object.httpMetadata?.contentType!==file.content_type){await object?.body?.cancel();throw new ProofHashError('PROOF_HASH_SOURCE_CHANGED');}
      const {digest}=await verifiedProofObject(object,file.size);let written=0;
      if(!dryRun){const result=await exactHashInsert(db,{...file,sha256:digest},new Date().toISOString()).all();written=result.results.length;
        const saved=await db.prepare('SELECT sha256,source_etag,source_size FROM proof_exact_hashes WHERE file_id=?').bind(file.id).first();
        if(saved?.sha256!==digest||saved.source_etag!==file.etag||saved.source_size!==file.size)throw new ProofHashError('PROOF_HASH_SOURCE_CHANGED');}
      results.push({file_id:file.id,state:dryRun?'would_hash':'verified',written});
    }catch(error){results.push({file_id:file.id,state:'failed',code:error instanceof ProofHashError?error.code:'PROOF_HASH_UNAVAILABLE'});}
  }
  return {dry_run:dryRun,scanned:selected.length,written:results.reduce((s,r)=>s+(r.written??0),0),results,next_cursor:rows.length>limit?selected.at(-1).id:null};
}
