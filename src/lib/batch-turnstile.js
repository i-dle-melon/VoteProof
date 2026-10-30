// A Turnstile result authorizes one fixed, bounded set of independent proofs.
// Each ticket has a fixed session/proof identity; replay can only address that
// same intent, never mint additional cases. No new table or global bypass.
import {UploadError, UPLOAD_LIMITS} from '../api/upload-validation.js';
import {newQueryKey} from './case-keys.js';

export const MAX_BATCH_PROOFS = 20;
const aad = new TextEncoder().encode('VoteProof/batch-turnstile/v1');
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const denied = () => { throw new UploadError(403,'BATCH_AUTH_INVALID','Batch verification is invalid or expired'); };
const uuid = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export async function issueBatchTickets(config,{files,campaignId,completionMode,memberId,generation=null}) {
  if(!Array.isArray(files)||files.length<1||files.length>MAX_BATCH_PROOFS)denied();
  const batchId=crypto.randomUUID(),expires=Math.floor(Date.now()/1000)+UPLOAD_LIMITS.expiresSeconds;
  const tickets=[];
  for(let index=0;index<files.length;index++){
    const file=files[index],iv=crypto.getRandomValues(new Uint8Array(12));
    const payload={v:1,origin:config.origin??null,generation,batch_id:batchId,index,count:files.length,session_id:crypto.randomUUID(),proof_id:crypto.randomUUID(),
      expires,campaign_id:campaignId,completion_mode:completionMode,member_id:memberId,
      capability:memberId?null:newQueryKey(),type:file.type,size:file.size,sha256:file.sha256};
    const plain=new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},config.key,plain));
    const merged=new Uint8Array(iv.length+ciphertext.length);merged.set(iv);merged.set(ciphertext,iv.length);
    tickets.push(encode(merged));
  }
  return {tickets,expires_in:UPLOAD_LIMITS.expiresSeconds};
}

export async function readBatchTicket(config,token,input) {
  if(typeof token!=='string'||token.length<40||token.length>2048||!/^[A-Za-z0-9_-]+$/.test(token))denied();
  let data;
  try{
    const bytes=Uint8Array.from(atob(token.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
    if(encode(bytes)!==token)denied();
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData:aad},config.key,bytes.subarray(12));
    data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
  }catch{denied();}
  const file=input.files[0],now=Math.floor(Date.now()/1000);
  if(!data||data.v!==1||!uuid(data.batch_id)||!uuid(data.session_id)||!uuid(data.proof_id)||
    data.origin!==(config.origin??null)||data.generation!==(input.generation??null)||
    !Number.isSafeInteger(data.index)||!Number.isSafeInteger(data.count)||data.count<1||data.count>MAX_BATCH_PROOFS||
    data.index<0||data.index>=data.count||!Number.isSafeInteger(data.expires)||data.expires<=now||
    data.campaign_id!==input.campaignId||data.completion_mode!==(input.completionMode??'legacy')||
    (data.member_id!==null&&(typeof data.member_id!=='string'||!data.member_id))||
    (data.member_id===null?typeof data.capability!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.capability):data.capability!==null)||
    data.type!==file.type||data.size!==file.size||data.sha256!==file.sha256)denied();
  return data;
}
