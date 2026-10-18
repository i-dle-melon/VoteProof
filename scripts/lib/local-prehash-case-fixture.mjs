// Historical schema fixture only. Current API writers require newer migrations.
import {guestBody} from './local-case-runtime.mjs';
import {validateCase} from '../../src/api/case-validation.js';
import {manifestHash} from '../../src/lib/completed-uploads.js';
import {cleanPrivateCopies} from '../../src/lib/case-files.js';
import {createHash} from 'node:crypto';
import {newCaseId,sha256} from '../../src/lib/case-keys.js';
export async function localPrehashCase(local,{member,verified=false,metadata={}}={}){
 const session=crypto.randomUUID(),objectKey=`proofs/staging/2026/10/13/${session}/${crypto.randomUUID()}.png`,bytes=new Uint8Array([1,2,3]);
 const stage=await local.bucket.put(objectKey,bytes,{httpMetadata:{contentType:'image/png'}}),files=[{key:objectKey,type:'image/png',size:3,etag:stage.etag}];
 const manifest=await manifestHash(files),now=new Date().toISOString();
 await local.db.batch([local.db.prepare('INSERT INTO completed_uploads(session_id,manifest_hash,completed_at,expires_at) VALUES(?,?,?,?)').bind(session,manifest,now,new Date(Date.now()+86400000).toISOString()),
   local.db.prepare('INSERT INTO completed_upload_files(session_id,object_key,content_type,size,etag) VALUES(?,?,?,?,?)').bind(session,objectKey,'image/png',3,stage.etag)]);
 const reference={session_id:session,keys:[objectKey]},input=validateCase({...guestBody(reference),...metadata}),id=crypto.randomUUID();
 const archiveId=crypto.randomUUID(),archiveKey=`proofs/cases/${id}/${archiveId}.png`,copy=await local.bucket.put(archiveKey,bytes,{httpMetadata:{contentType:'image/png'}});
 const case_id=newCaseId(),record={id,caseId:case_id,now,queryHash:await sha256(crypto.randomUUID())};
 // Seed the historical contract directly, rather than running current writers
 // against a schema that intentionally lacks Campaign targets and intents.
 await local.db.batch([
  local.db.prepare(`INSERT INTO cases(id,case_id,created_at,updated_at,nickname,player_id,campaign_id,vote_type,vote_date,query_key_hash,upload_session_id,member_id,source)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,record.caseId,now,now,'Historical fixture','historical-fixture',input.campaignId,input.voteType,input.voteDate,record.queryHash,session,member?.memberId??null,member?'member':'guest'),
  local.db.prepare(`INSERT INTO case_files(id,case_id,object_key,content_type,size,etag,created_at,upload_object_key) VALUES(?,?,?,'image/png',3,?,?,?)`).bind(archiveId,id,archiveKey,copy.etag,now,objectKey),
  local.db.prepare('UPDATE completed_uploads SET consumed_case_id=?,consumed_at=? WHERE session_id=?').bind(id,now,session),
  ...(verified?[local.db.prepare(`INSERT INTO proof_exact_hashes(file_id,sha256,verified_at,source_etag,source_size,case_created_at,case_internal_id) VALUES(?,?,?,?,3,?,?)`).bind(archiveId,createHash('sha256').update(bytes).digest('hex'),now,copy.etag,now,id)]:[]),
 ]);
 await cleanPrivateCopies(local.bucket,reference.keys);return {id,case_id};
}
