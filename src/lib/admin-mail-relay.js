// Separate from verify_email transport. No OAuth fallback, logs, or retry.
import { AdminError } from './admin-identity.js';
import { mailText, ADMIN_MAIL_FROM } from './admin-member-contact.js';
import { normalizeEmail } from '../api/auth-validation.js';
export { ADMIN_MAIL_FROM };
const encoder=new TextEncoder();
const unavailable=()=>new AdminError(503,'ADMIN_MAIL_NOT_CONFIGURED','客服寄信尚未設定完成。');
export function adminMailConfig(env){
 try{
  const url=new URL(env.ADMIN_MAIL_RELAY_URL),secret=env.ADMIN_MAIL_RELAY_SECRET;
  if(url.protocol!=='https:'||url.hostname!=='script.google.com'||url.port||url.username||url.password||url.search||url.hash||!/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)||
   typeof secret!=='string'||!secret.trim()||encoder.encode(secret).length<32||encoder.encode(secret).length>1024||
   Object.keys(env).some(k=>k!=='ADMIN_MAIL_RELAY_SECRET'&&typeof env[k]==='string'&&/(SECRET|KEY|TOKEN|PASSWORD)$/.test(k)&&env[k].toLowerCase()===secret.toLowerCase())||(env.MAIL_RELAY_URL && url.href===new URL(env.MAIL_RELAY_URL).href))throw unavailable();
  return{url:url.href,secret};
 }catch{throw unavailable();}
}
export const mailCanonical=b=>JSON.stringify(['VoteProof/admin-member-mail',b.version,b.timestamp,b.send_id,b.purpose,b.recipient,b.subject,b.body]);
export const receiptCanonical=b=>JSON.stringify(['VoteProof/admin-member-mail-receipt',b.version,b.send_id,b.outcome,b.code??'']);
export async function adminMailSignature(secret,text){
 const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(text))))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export async function signedAdminMail(secret,sendId,recipient,subject,body){
 const text=mailText(subject,body),b={version:1,timestamp:Math.floor(Date.now()/1000),send_id:sendId,purpose:'admin_member_message',recipient:normalizeEmail(recipient),...text};
 b.signature=await adminMailSignature(secret,mailCanonical(b));return b;
}
async function boundedJson(response){
 const reader=response.body?.getReader();if(!reader)throw Error();let size=0;const parts=[];
 try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096)throw Error();parts.push(value);}const b=new Uint8Array(size);let i=0;for(const p of parts){b.set(p,i);i+=p.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}finally{await reader.cancel().catch(()=>{});}
}
export async function deliverAdminMail(config,sendId,recipient,subject,body){
 const payload=await signedAdminMail(config.secret,sendId,recipient,subject,body),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 // Anything without an authenticated negative receipt may already be delivered.
 try{
  let url=config.url,method='POST',redirects=0;
  for(;;){
   const response=await fetch(url,{method,redirect:'manual',signal:controller.signal,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})});
   if(response.status>=300&&response.status<400){
    await response.body?.cancel();if(![301,302,303].includes(response.status)||++redirects>2)return{outcome:'ambiguous'};
    const next=new URL(response.headers.get('Location'),url);
    if(next.protocol!=='https:'||next.hostname!=='script.googleusercontent.com'||next.port||next.username||next.password||next.hash||next.pathname!=='/macros/echo')return{outcome:'ambiguous'};
    url=next.href;method='GET';continue;
   }
   if(!response.ok){await response.body?.cancel();return{outcome:'ambiguous'};}
   const r=await boundedJson(response);
   if(!r||Object.keys(r).some(k=>!['version','send_id','outcome','code','signature'].includes(k))||r.version!==1||r.send_id!==sendId||!['sent','rejected','ambiguous'].includes(r.outcome)||
    !['','PROVIDER_QUOTA_LOW','RATE_LIMITED','REPLAY_CONFLICT','EXPIRED','INVALID_REQUEST','NOT_CONFIGURED','BUSY','SEND_UNCERTAIN'].includes(r.code??'')||
    typeof r.signature!=='string'||r.signature.length!==43)return{outcome:'ambiguous'};
   const expected=await adminMailSignature(config.secret,receiptCanonical(r));let mismatch=0;for(let i=0;i<43;i++)mismatch|=r.signature.charCodeAt(i)^expected.charCodeAt(i);if(mismatch)return{outcome:'ambiguous'};
   return{outcome:r.outcome};
  }
 }catch{return{outcome:'ambiguous'};}finally{clearTimeout(timer);}
}
