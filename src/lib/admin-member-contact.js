import { AdminError } from './admin-identity.js';
import { authKey, authMac } from './auth-session.js';
import { decryptEmail } from './auth-identity.js';
import { normalizeEmail } from '../api/auth-validation.js';

export const ADMIN_MAIL_FROM='idle.voteproof.verify@gmail.com';
export const CONTACT_LIMITS=Object.freeze({admin:3,site:10,adminWindow:600,siteWindow:86400,lookupWindow:600});
export const contactInvalid=()=>new AdminError(400,'INVALID_MEMBER_CONTACT','請確認粉絲 ID、主旨與純文字內容。');
export const recipientUnavailable=()=>new AdminError(409,'MEMBER_EMAIL_UNAVAILABLE','此會員沒有可使用的已驗證 Email，或收件資料已變更，請重新查詢。');
export function contactFields(body,allowed){if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).some(k=>!allowed.includes(k)))throw contactInvalid();}
export function mailText(subject,body){
 if(typeof subject!=='string'||typeof body!=='string'||!subject.isWellFormed()||!body.isWellFormed()||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(subject))throw contactInvalid();
 body=body.replace(/\r\n?/g,'\n');
 if(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body))throw contactInvalid();
 subject=subject.trim();body=body.trim();
 if(!subject||[...subject].length>150||!body||[...body].length>10000)throw contactInvalid();
 return{subject,body};
}
export function contactLimits(env){
 const lower=(key,max)=>{if(env[key]===undefined)return max;const v=Number(env[key]);if(!Number.isInteger(v)||v<1||v>max||!/^\d+$/.test(String(env[key])))throw new AdminError(503,'ADMIN_MAIL_NOT_CONFIGURED','客服寄信尚未設定完成。');return v;};
 return{admin:lower('ADMIN_MAIL_ADMIN_LIMIT',CONTACT_LIMITS.admin),site:lower('ADMIN_MAIL_SITE_LIMIT',CONTACT_LIMITS.site)};
}
// This project's auth_identities contains only activated, verified identities.
// Challenges, provider pending rows and enrollment mail are never recipients.
// Current schema has UNIQUE(member_id). Fold all rows defensively for future
// verified provider adapters without inventing a second identity store.
export async function resolveContactEmails(db,env,memberId){
 const rows=(await db.prepare('SELECT provider,provider_subject,email_ciphertext,email_iv,email_key_version,password_enabled,google_identity_id FROM auth_identities WHERE member_id=? ORDER BY created_at DESC,provider_subject').bind(memberId).all()).results;
 const key=await authKey(env),emails=new Map();
 for(const row of rows){
  let email;try{email=normalizeEmail(await decryptEmail(env,row,row.provider_subject));}catch{throw recipientUnavailable();}
  const providers=[...(row.password_enabled?['Email／密碼']:[]),...(row.google_identity_id?['Google']:[])];
  if(!providers.length)throw recipientUnavailable();
  const prior=emails.get(email);if(prior){prior.providers=[...new Set([...prior.providers,...providers])];continue;}
  const recipient_ref=await authMac(key,'admin-member-mail-recipient',JSON.stringify([memberId,email]));
  emails.set(email,{email,providers,recipient_ref});
 }
 return [...emails.values()];
}
