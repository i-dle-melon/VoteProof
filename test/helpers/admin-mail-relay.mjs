// Synthetic account, memory Properties and MailApp only. No network or real mail.
import {readFile} from 'node:fs/promises';
import {createHmac,randomBytes} from 'node:crypto';
import vm from 'node:vm';
const source=await readFile(new URL('../../relay/admin-member-mail/Code.gs',import.meta.url),'utf8');
export function fakeAdminRelay(secret=randomBytes(32).toString('hex')){
 const properties={ADMIN_MAIL_RELAY_SECRET:secret},sent=[];let quota=100,fail=false,owner='idle.voteproof.verify@gmail.com',locked=false;
 const context=vm.createContext({
  Utilities:{Charset:{UTF_8:'UTF-8'},newBlob:v=>({getBytes:()=>Buffer.from(v)}),computeHmacSha256Signature:(v,k)=>createHmac('sha256',k).update(v).digest(),base64EncodeWebSafe:b=>Buffer.from(b).toString('base64url')},
  ContentService:{MimeType:{JSON:'application/json'},createTextOutput:text=>({text,setMimeType(){return this;}})},
  Session:{getEffectiveUser:()=>({getEmail:()=>owner})},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k]??null,setProperty:(k,v)=>{properties[k]=v;},getProperties:()=>({...properties}),deleteProperty:k=>delete properties[k]})},
  LockService:{getScriptLock:()=>({tryLock:()=>{if(locked)return false;locked=true;return true;},releaseLock:()=>{locked=false;}})},
  MailApp:{getRemainingDailyQuota:()=>quota,sendEmail:b=>{sent.push({...b});quota--;if(fail)throw Error('Synthetic provider timeout');}},
 });vm.runInContext(source,context);
 return{secret,sent,properties,setQuota:n=>{quota=n;},setFailure:v=>{fail=v;},setOwner:v=>{owner=v;},setLocked:v=>{locked=v;},
  request:b=>JSON.parse(context.doPost({postData:{type:'application/json',contents:JSON.stringify(b)}}).text),
  async fetch(url,options){if(typeof url!=='string'||!url.startsWith('https://script.google.com/macros/s/'))throw Error('Unexpected synthetic upstream');return Response.json(this.request(JSON.parse(options.body)));}};
}
