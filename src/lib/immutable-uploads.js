import {reserveStorage,putReservedStorage,StorageCapacityError,capacityAccountingOnly} from './storage-capacity.js';
import {UploadError,UPLOAD_LIMITS,validUploadedObject,MIME_EXTENSIONS} from '../api/upload-validation.js';
import {memberSession,memberCsrf,requestOrigin} from './auth-session.js';
import {newQueryKey,sha256,equalQueryHash} from './case-keys.js';
import {issueUploadGrant} from './upload-grant.js';
import {requireCaseCampaignRow} from './campaign-policy.js';
import {r2VerifiedSha256} from './r2-verified-checksum.js';
import {rememberCompletedUpload,COMPLETED_UPLOAD_TTL_SECONDS} from './completed-uploads.js';
import {CaseError} from '../api/case-validation.js';
import {resetSessionStatement,requireResetSession} from './prelaunch-reset-fence.js';
import {proofKey} from './proof-generation.js';

const fail=(code='UPLOAD_INTENT_INVALID',status=409)=>{throw new UploadError(status,code,'Upload authorization or state is invalid');};
export const uploadCapabilityHash=capability=>sha256('VoteProof/upload-capability/v2:'+capability);
export const finalReference=keys=>keys.some(key=>key.startsWith('proofs/final/'));
export const intentRow=(db,session)=>db.prepare('SELECT * FROM proof_upload_intents WHERE session_id=?').bind(session).first();
const matches=(intent,object)=>object && validUploadedObject(intent.object_key,object) && object.size===intent.size &&
  object.httpMetadata?.contentType===intent.content_type && r2VerifiedSha256(object)===intent.expected_sha256;

// Issuance and Intent share one permit/atomic batch. A replay may reuse only
// the exact persistent epoch/key issuance; a foreign/stale issuance cannot
// create an Intent, even when its first Prepare ACK was lost.
async function insertPreparedIntent(env,{sessionId,proofId,objectKey,input,member,guestCapabilityHash,file,now,expires,batch}){
 const kind=input.completionMode==='direct'?'direct':'v2';
 const issuance=resetSessionStatement(env,sessionId,[objectKey],kind,{ifMissing:!!batch});
 const issued=issuance?` AND EXISTS(SELECT 1 FROM prelaunch_reset_issuance WHERE session_id=? AND epoch=? AND kind=? AND keys_json=?)`:'';
 const statement=env.DB.prepare(`INSERT INTO proof_upload_intents(session_id,proof_id,object_key,campaign_id,member_id,guest_capability_hash,
   content_type,size,expected_sha256,created_at,expires_at,grant_expires,completion_mode)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM submission_settings WHERE id=1 AND submissions_enabled=1)${issued}
   ${batch?'ON CONFLICT(session_id) DO NOTHING':''}`)
  .bind(sessionId,proofId,objectKey,input.campaignId,member?.member_id??null,guestCapabilityHash,file.type,file.size,file.sha256,
   now.toISOString(),new Date(now.valueOf()+COMPLETED_UPLOAD_TTL_SECONDS*1000).toISOString(),expires,input.completionMode??'legacy',
   ...(issuance?[sessionId,env.PRELAUNCH_RESET_CONTEXT.epoch,kind,JSON.stringify([objectKey])]:[]));
 const result=issuance?(await env.DB.batch([issuance,statement]))[1]:await statement.run();
 if(!batch&&result.meta.changes!==1)fail('SUBMISSIONS_DISABLED',503);
}

export async function prepareFinalUpload(env,request,config,input) {
  requestOrigin(request,env);
  const member=await memberSession(request,env,false);
  if(member)await memberCsrf(request,env,member);
  const campaign=await env.DB.prepare('SELECT * FROM campaigns WHERE campaign_id=?').bind(input.campaignId).first();
  requireCaseCampaignRow(campaign,{voteType:campaign?.category,voteDate:campaign?.vote_start_date});
  const batch=input.batch??null;
  if(batch&&batch.member_id!==(member?.member_id??null))fail('UPLOAD_OWNER_MISMATCH',403);
  const sessionId=batch?.session_id??crypto.randomUUID(),proofId=batch?.proof_id??crypto.randomUUID(),
    file=input.files[0],now=new Date();
  const capability=member?null:(batch?.capability??newQueryKey()),
    guestCapabilityHash=capability?await uploadCapabilityHash(capability):null;
  const expires=batch?.expires??Math.floor(now.valueOf()/1000)+UPLOAD_LIMITS.expiresSeconds;
  if(expires<=Math.floor(now.valueOf()/1000))fail('BATCH_AUTH_INVALID',403);
  const objectKey=proofKey(env,'final',`${sessionId}/${proofId}.${MIME_EXTENSIONS[file.type]}`);
  if(batch){
    // Retry a lost prepare response using exactly the original intent identity.
    // A ticket never creates a second intent or changes an existing proof.
    let existing=await intentRow(env.DB,sessionId);
    if(!existing){
      await insertPreparedIntent(env,{sessionId,proofId,objectKey,input,member,guestCapabilityHash,file,now,expires,batch});
      existing=await intentRow(env.DB,sessionId);
    }
    if(!existing||existing.proof_id!==proofId||existing.object_key!==objectKey||
      existing.campaign_id!==input.campaignId||existing.member_id!==(member?.member_id??null)||
      existing.guest_capability_hash!==guestCapabilityHash||existing.content_type!==file.type||
      existing.size!==file.size||existing.expected_sha256!==file.sha256||
      existing.grant_expires!==expires||existing.completion_mode!==(input.completionMode??'legacy')||
      existing.state!=='prepared'||existing.write_token!==null||existing.consumed_case_id!==null)
      fail('BATCH_AUTH_REPLAY',409);
    await requireResetSession(env,sessionId,[objectKey]);
  }else{
    await insertPreparedIntent(env,{sessionId,proofId,objectKey,input,member,guestCapabilityHash,file,now,expires,batch});
  }
  const upload=await issueUploadGrant(config,`/api/uploads/put/${sessionId}/${proofId}`,objectKey,file,
    {sessionId,proofId,campaignId:input.campaignId,memberId:member?.member_id??null,guestCapabilityHash,expires});
  return {storage_version:2,session_id:sessionId,proof_id:proofId,expires_in:Math.max(1,expires-Math.floor(Date.now()/1000)),uploads:[upload],...(capability?{capability}:{}),
    ...(input.completionMode==='direct'?{completion_mode:'direct'}:{})};
}

async function ownIntent(env,request,intent,capability,{csrf=true}={}) {
  requestOrigin(request,env);
  if(intent.member_id) {
    const member=await memberSession(request,env,true);
    if(member.member_id!==intent.member_id)fail('UPLOAD_OWNER_MISMATCH',403);
    if(csrf)await memberCsrf(request,env,member);
  } else if(!capability || !equalQueryHash(await uploadCapabilityHash(capability),intent.guest_capability_hash))fail('UPLOAD_OWNER_MISMATCH',403);
}

export async function putFinalUpload(env,request,grant,diagnostic) {
  if(diagnostic)diagnostic.stage='intent_read';
  const intent=await intentRow(env.DB,grant.session_id);
  if(diagnostic)diagnostic.stage='intent_validation';
  if(!intent || intent.object_key!==grant.key || intent.proof_id!==grant.proof_id || intent.campaign_id!==grant.campaign_id ||
    intent.member_id!==grant.member_id || intent.guest_capability_hash!==grant.guest_capability_hash ||
    intent.size!==grant.size || intent.content_type!==grant.type || intent.expected_sha256!==grant.sha256 || intent.grant_expires!==grant.expires ||
    intent.expires_at<=new Date().toISOString() || ['deleting','deleted'].includes(intent.state))fail();
  // A private authenticated grant is itself the PUT capability. Member grants
  // additionally require the current member session; no auth state is cached.
  if(diagnostic)diagnostic.stage='intent_owner';
  if(intent.member_id)await ownIntent(env,request,intent,null,{csrf:false});
  if(['sealed','consumed'].includes(intent.state)) {
    if(diagnostic)diagnostic.stage='replay_head';
    if(!matches(intent,await env.PROOFS_BUCKET.head(intent.object_key)))fail('UPLOAD_CHANGED');
    await request.body.cancel();fail('UPLOAD_ALREADY_UPLOADED');
  }
  const token=crypto.randomUUID();
  const reservation=await reserveStorage(env,intent.object_key,intent.size,{sessionId:intent.session_id,token},diagnostic);
  if(!reservation) {
    if(diagnostic)diagnostic.stage='replay_head';
    // Never reclaim an unknown writer by a wall-clock lease. Its native PUT
    // might still be running. Existing completed bytes can be safely replayed.
    if(matches(intent,await env.PROOFS_BUCKET.head(intent.object_key))){await request.body.cancel();fail('UPLOAD_ALREADY_UPLOADED');}
    fail('UPLOAD_REPREPARE_REQUIRED');
  }
  let object,existing=false,settled=false;
  // Enforced mode retains its original pin until capacity-alert work finishes.
  const settle=capacityAccountingOnly(env)?async object=>{
    if(!matches(intent,object))fail('UPLOAD_CHECKSUM_FAILED',502);
    await env.DB.batch([
      env.DB.prepare(`UPDATE storage_reservations SET state='committed',etag=?,object_version=?
        WHERE id=? AND state='reserved' AND object_key=? AND bytes=? AND EXISTS(
        SELECT 1 FROM proof_upload_intents i WHERE i.session_id=? AND i.object_key=storage_reservations.object_key
        AND i.size=storage_reservations.bytes AND i.write_token=?) RETURNING id`)
        .bind(object.etag,object.version??null,reservation,intent.object_key,intent.size,intent.session_id,token),
      env.DB.prepare(`UPDATE proof_upload_intents SET write_token=NULL,
        uploaded_at=CASE WHEN completion_mode='legacy' THEN coalesce(uploaded_at,?) ELSE uploaded_at END,
        state=CASE WHEN state='prepared' AND completion_mode='legacy' THEN 'uploaded' ELSE state END
        WHERE session_id=? AND write_token=? AND EXISTS(SELECT 1 FROM storage_reservations r
        WHERE r.id=? AND r.object_key=proof_upload_intents.object_key AND r.state='committed'
        AND r.etag=? AND r.object_version IS ?) RETURNING session_id`)
        .bind(new Date().toISOString(),intent.session_id,token,reservation,object.etag,object.version??null),
      // Zero writes on success; any mismatched/zero-row settlement aborts in SQL.
      env.DB.prepare(`INSERT INTO auth_atomic_guards(id,valid) SELECT ?,0 WHERE changes()<>1
        OR NOT EXISTS(SELECT 1 FROM storage_reservations r JOIN proof_upload_intents i ON i.object_key=r.object_key
        WHERE r.id=? AND r.state='committed' AND r.etag=? AND r.object_version IS ?
        AND i.session_id=? AND i.write_token IS NULL AND i.size=r.bytes)`)
        .bind(crypto.randomUUID(),reservation,object.etag,object.version??null,intent.session_id)
    ]);
    settled=true;
  }:null;
  try {
    // Storage-enforced create-only, including simultaneous PUTs. The SHA is
    // verified by R2 against the native request stream, never by JS buffering.
    object=await putReservedStorage(env,intent.object_key,request.body,{onlyIf:new Headers({'If-None-Match':'*'}),
      sha256:intent.expected_sha256,httpMetadata:{contentType:intent.content_type},
      customMetadata:{voteproof_upload:intent.session_id,voteproof_write:token}},intent.size,reservation,diagnostic,settle);
    if(diagnostic)diagnostic.stage='r2_verify';
    if(!object){existing=true;object=await env.PROOFS_BUCKET.head(intent.object_key);}
    if(!matches(intent,object))fail('UPLOAD_CHECKSUM_FAILED',502);
  } catch(error) {
    if(error instanceof StorageCapacityError)throw error;
    // Ambiguous native write: retain the durable pin. A fresh prepare is safe;
    // timeouts must never allow cleanup to race an unacknowledged PUT.
    fail('UPLOAD_REPREPARE_REQUIRED',502);
  }
  if(diagnostic)diagnostic.stage='intent_receipt';
  if(!settled)await env.DB.prepare(`UPDATE proof_upload_intents SET write_token=NULL,
    uploaded_at=CASE WHEN completion_mode='legacy' THEN coalesce(uploaded_at,?) ELSE uploaded_at END,
    state=CASE WHEN state='prepared' AND completion_mode='legacy' THEN 'uploaded' ELSE state END WHERE session_id=? AND write_token=?`)
    .bind(new Date().toISOString(),intent.session_id,token).run();
  // Do not attest to bytes of a replay body that R2 did not consume. The client
  // can use complete's authoritative checksum verification to recover safely.
  if(existing)fail('UPLOAD_ALREADY_UPLOADED');
  return {uploaded:true};
}

export async function sealFinalUpload(env,request,reference) {
  const intent=await intentRow(env.DB,reference.sessionId);
  if(!intent || reference.keys.length!==1 || reference.keys[0]!==intent.object_key)fail();
  await ownIntent(env,request,intent,reference.capability);
  if(intent.completion_mode==='direct')fail('UPLOAD_COMPLETE_NOT_REQUIRED');
  if(['deleting','deleted'].includes(intent.state)||intent.expires_at<=new Date().toISOString())fail('UPLOAD_SESSION_EXPIRED');
  const object=await env.PROOFS_BUCKET.head(intent.object_key);
  if(!object)fail('UPLOAD_INCOMPLETE',400);
  if(!matches(intent,object))fail('UPLOAD_CHANGED');
  const file={key:intent.object_key,size:intent.size,type:intent.content_type,etag:object.etag,sha256:r2VerifiedSha256(object)};
  if(intent.state!=='consumed') {
    const state=await rememberCompletedUpload(env,intent.session_id,[file],intent);
    if(!['sealed','consumed'].includes(state))fail('UPLOAD_SESSION_EXPIRED');
  }
  return {session_id:intent.session_id,files:[{key:file.key,size:file.size,type:file.type,etag:file.etag}],storage_version:2};
}

export async function linkFinalProof(bucket,completed) {
  const file=completed.files[0],intent=completed.intent;
  const object=await bucket.head(file.key);
  if(!matches(intent,object)||object.etag!==file.etag)throw new CaseError(409,'UPLOAD_CHANGED','Sealed proof is missing or changed');
  return [{...file,id:intent.proof_id,sourceKey:file.key}];
}

// No route, Cron or remote runner is enabled. Operator/fixture callers only.
// Interrupted native writes are deliberately quarantined (write_token!=NULL),
// never expired into deletion. This favors retained storage over lost proofs.
export async function cleanupFinalUploads(env,{limit=10,now=new Date().toISOString()}={}) {
  // At most 42 binding calls even if ten pinned writes are recovered and all
  // ten objects are collected in one pass; no unbounded Free-tier sweep.
  if(!Number.isSafeInteger(limit)||limit<1||limit>10||typeof now!=='string'||new Date(now).toISOString()!==now)throw new TypeError('Invalid cleanup bounds');
  // Only a provider-persisted marker belonging to this exact native operation
  // proves its atomic PUT already linearized. A missing object or another
  // writer's marker is never treated as timeout/lease-based permission to delete.
  const pinned=(await env.DB.prepare(`SELECT * FROM proof_upload_intents WHERE write_token IS NOT NULL
    AND consumed_case_id IS NULL AND expires_at<=? ORDER BY expires_at,session_id LIMIT ?`).bind(now,limit).all()).results;
  for(const intent of pinned) {
    const object=await env.PROOFS_BUCKET.head(intent.object_key);
    if(matches(intent,object)&&object.customMetadata?.voteproof_upload===intent.session_id&&object.customMetadata?.voteproof_write===intent.write_token)
      await env.DB.prepare(`UPDATE proof_upload_intents SET write_token=NULL,
        uploaded_at=CASE WHEN completion_mode='legacy' THEN coalesce(uploaded_at,?) ELSE uploaded_at END,
        state=CASE WHEN state='prepared' AND completion_mode='legacy' THEN 'uploaded' ELSE state END WHERE session_id=? AND write_token=?`)
        .bind(now,intent.session_id,intent.write_token).run();
  }
  const rows=(await env.DB.prepare(`UPDATE proof_upload_intents SET state='deleting' WHERE session_id IN (
    SELECT i.session_id FROM proof_upload_intents i WHERE i.state IN ('prepared','uploaded','sealed','deleting')
      AND i.expires_at<=? AND i.write_token IS NULL AND i.consumed_case_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM cases c WHERE c.upload_session_id=i.session_id OR c.upload_intent_id=i.session_id)
      AND NOT EXISTS(SELECT 1 FROM case_files f WHERE f.object_key=i.object_key) ORDER BY i.expires_at,i.session_id LIMIT ?)
    RETURNING session_id,object_key`).bind(now,limit).all()).results;
  let deleted=0;
  for(const row of rows){await env.PROOFS_BUCKET.delete(row.object_key);await env.DB.prepare("UPDATE proof_upload_intents SET state='deleted' WHERE session_id=? AND state='deleting'").bind(row.session_id).run();deleted++;}
  return {claimed:rows.length,deleted};
}
