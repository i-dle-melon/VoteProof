// Explicit old-schema fixture only. New candidate APIs intentionally require 0012.
import {guestBody} from './local-case-runtime.mjs';
import {validateCase} from '../../src/api/case-validation.js';
import {completedFiles,manifestHash} from '../../src/lib/completed-uploads.js';
import {archiveCaseFiles,cleanPrivateCopies} from '../../src/lib/case-files.js';
import {insertCase} from '../../src/lib/case-store.js';
import {newCaseId,sha256} from '../../src/lib/case-keys.js';
export async function localPrehashCase(local){
 const reference=await local.upload(),input=validateCase(guestBody(reference)),id=crypto.randomUUID(),now=new Date().toISOString();
 input.campaignVersion=(await local.db.prepare('SELECT version FROM campaigns WHERE campaign_id=?').bind(input.campaignId).first()).version;
 const files=await completedFiles(local.db,reference.session_id),archived=await archiveCaseFiles(local.bucket,id,files,[]);
 const case_id=newCaseId(),record={id,caseId:case_id,now,queryHash:await sha256(crypto.randomUUID())};
 await insertCase(local.db,input,record,archived.map(({sha256:_hash,...file})=>file),await manifestHash(files));
 await cleanPrivateCopies(local.bucket,reference.keys);return {id,case_id};
}
