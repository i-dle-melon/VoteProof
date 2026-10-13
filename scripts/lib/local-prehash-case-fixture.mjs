// Explicit old-schema fixture only. New candidate APIs intentionally require 0012.
import {guestBody} from './local-case-runtime.mjs';
import {validateCase} from '../../src/api/case-validation.js';
import {manifestHash} from '../../src/lib/completed-uploads.js';
import {cleanPrivateCopies} from '../../src/lib/case-files.js';
import {insertCase} from '../../src/lib/case-store.js';
import {newCaseId,sha256} from '../../src/lib/case-keys.js';
export async function localPrehashCase(local){
 const session=crypto.randomUUID(),objectKey=`proofs/staging/2026/10/13/${session}/${crypto.randomUUID()}.png`,bytes=new Uint8Array([1,2,3]);
 const stage=await local.bucket.put(objectKey,bytes,{httpMetadata:{contentType:'image/png'}}),files=[{key:objectKey,type:'image/png',size:3,etag:stage.etag}];
 const manifest=await manifestHash(files),now=new Date().toISOString();
 await local.db.batch([local.db.prepare('INSERT INTO completed_uploads(session_id,manifest_hash,completed_at,expires_at) VALUES(?,?,?,?)').bind(session,manifest,now,new Date(Date.now()+86400000).toISOString()),
   local.db.prepare('INSERT INTO completed_upload_files(session_id,object_key,content_type,size,etag) VALUES(?,?,?,?,?)').bind(session,objectKey,'image/png',3,stage.etag)]);
 const reference={session_id:session,keys:[objectKey]},input=validateCase(guestBody(reference)),id=crypto.randomUUID();
 input.campaignVersion=(await local.db.prepare('SELECT version FROM campaigns WHERE campaign_id=?').bind(input.campaignId).first()).version;
 const archiveId=crypto.randomUUID(),archiveKey=`proofs/cases/${id}/${archiveId}.png`,copy=await local.bucket.put(archiveKey,bytes,{httpMetadata:{contentType:'image/png'}});
 const archived=[{id:archiveId,key:archiveKey,sourceKey:objectKey,type:'image/png',size:3,etag:copy.etag}];
 const case_id=newCaseId(),record={id,caseId:case_id,now,queryHash:await sha256(crypto.randomUUID())};
 await insertCase(local.db,input,record,archived.map(({sha256:_hash,...file})=>file),await manifestHash(files));
 await cleanPrivateCopies(local.bucket,reference.keys);return {id,case_id};
}
