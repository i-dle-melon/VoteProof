import { adminHandler } from './admin-response.js';
import { jsonSuccess } from './response.js';
import { UUID_PATTERN } from './admin-validation.js';
import { AdminError,adminIdentity,adminCsrf,ELEVATED_ROLES,ELEVATED_AUTH_GUARD,actorBindings } from '../lib/admin-identity.js';
import { authDatabase } from '../lib/auth-session.js';
import { normalizeFanId } from '../lib/fan-id.js';
import { memberPointTier } from '../lib/member-tier.js';
import { sha256 } from '../lib/case-keys.js';
import { CONTACT_LIMITS,contactFields,contactInvalid,contactLimits,mailText,resolveContactEmails,recipientUnavailable } from '../lib/admin-member-contact.js';
import { adminMailConfig,deliverAdminMail } from '../lib/admin-mail-relay.js';

// 10,000 Unicode characters can exceed the existing upload metadata 16 KiB cap.
async function contactJson(request){
 if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw contactInvalid();
 const reader=request.body?.getReader();if(!reader)throw contactInvalid();const parts=[];let length=0;
 try{for(;;){const{done,value}=await reader.read();if(done)break;length+=value.length;if(length>131072)throw contactInvalid();parts.push(value);}const bytes=new Uint8Array(length);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw contactInvalid();}finally{await reader.cancel().catch(()=>{});}
}
async function contactActor(env,url,request){
 // Map guest denial to 403 as well; retain suspension/step-up codes.
 let actor;try{actor=await adminIdentity(request,env,ELEVATED_ROLES);}catch(e){if(e.code==='AUTH_REQUIRED')throw new AdminError(403,'ADMIN_FORBIDDEN','Administrative access is not allowed');throw e;}
 await adminCsrf(request,env,actor);if(url.search)throw contactInvalid();return actor;
}
const lookup=adminHandler(async(env,url,request)=>{
 const actor=await contactActor(env,url,request),db=authDatabase(env),b=await contactJson(request);contactFields(b,['fan_id']);
 if(typeof b.fan_id!=='string'||/[\u0000-\u001f\u007f]/.test(b.fan_id))throw contactInvalid();const fan=normalizeFanId(b.fan_id);if(!fan||fan.length>100)throw contactInvalid();
 const member=await db.prepare('SELECT member_id,player_id,nickname,status,created_at,updated_at FROM members WHERE lower(trim(player_id))=?').bind(fan).first();
 if(!member)throw new AdminError(404,'MEMBER_NOT_FOUND','找不到此粉絲 ID 的會員。');
 const[emails,points,counts,reason]=await Promise.all([
  resolveContactEmails(db,env,member.member_id),memberPointTier(db,member.member_id),
  db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status IN ('approved','completed') THEN 1 ELSE 0 END) AS approved,SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected FROM cases WHERE member_id=?`).bind(member.member_id).first(),
  db.prepare("SELECT reason FROM member_status_events WHERE member_id=? AND action='member_block' ORDER BY sequence DESC LIMIT 1").bind(member.member_id).first(),
 ]);
 const id=crypto.randomUUID(),now=new Date().toISOString();
 const result=await db.prepare(`INSERT INTO admin_member_contact_audit(id,created_at,admin_member_id,admin_role,target_member_id,action,outcome)
 SELECT ?,?,?,?,?,'member_lookup','revealed' WHERE ${ELEVATED_AUTH_GUARD}`).bind(id,now,actor.member.member_id,actor.role,member.member_id,...actorBindings(actor)).run();
 if(result.meta.changes!==1){await adminIdentity(request,env,ELEVATED_ROLES);throw new AdminError(403,'ADMIN_FORBIDDEN','Administrative access is not allowed');}
 return jsonSuccess({member:{member_id:member.member_id,fan_id:member.player_id,nickname:member.nickname,status:member.status,created_at:member.created_at,updated_at:member.updated_at,
  emails,login_methods:[...new Set(emails.flatMap(e=>e.providers))],tier:points.tier,total_points:points.total_points,
  proof_counts:{total:counts.total,pending:counts.pending??0,approved:counts.approved??0,rejected:counts.rejected??0},explanation:member.status==='suspended'?reason?.reason??'會員目前已被封鎖。':''}});
});
const send=adminHandler(async(env,url,request)=>{
 const actor=await contactActor(env,url,request),db=authDatabase(env),b=await contactJson(request);
 contactFields(b,['member_id','recipient_ref','subject','body','mutation_id']);
 if(typeof b.member_id!=='string'||b.member_id.length>100||!UUID_PATTERN.test(b.mutation_id)||b.recipient_ref!==undefined&&!/^[a-f0-9]{64}$/.test(b.recipient_ref))throw contactInvalid();
 const text=mailText(b.subject,b.body),subjectHash=await sha256(text.subject),bodyHash=await sha256(text.body);
 const existing=await db.prepare('SELECT * FROM admin_member_mail_requests WHERE send_id=?').bind(b.mutation_id).first();
 const replay=async row=>{
  if(row.admin_member_id!==actor.member.member_id||row.target_member_id!==b.member_id||row.subject_hash!==subjectHash||row.body_hash!==bodyHash||b.recipient_ref!==undefined&&row.recipient_ref!==b.recipient_ref)throw new AdminError(409,'MEMBER_MAIL_MUTATION_CONFLICT','此寄信編號已用於其他內容，請重新查詢後建立新信件。');
  const r=await db.prepare('SELECT outcome FROM admin_member_contact_audit WHERE send_id=?').bind(row.send_id).first();
  return jsonSuccess({send_id:row.send_id,outcome:r?.outcome??'ambiguous',replayed:true});
 };
 if(existing)return replay(existing);
 const limits=contactLimits(env),config=adminMailConfig(env),now=new Date().toISOString(),ago=n=>new Date(Date.now()-n*1000).toISOString();
 // A browser can only send to a target resolved by this admin's explicit search.
 const grant=await db.prepare("SELECT 1 FROM admin_member_contact_audit WHERE action='member_lookup' AND outcome='revealed' AND admin_member_id=? AND target_member_id=? AND created_at>=?").bind(actor.member.member_id,b.member_id,ago(CONTACT_LIMITS.lookupWindow)).first();
 if(!grant)throw new AdminError(403,'MEMBER_LOOKUP_REQUIRED','請先以粉絲 ID 查詢會員，再撰寫信件。');
 if(!await db.prepare('SELECT 1 FROM members WHERE member_id=?').bind(b.member_id).first())throw recipientUnavailable();
 const emails=await resolveContactEmails(db,env,b.member_id),recipient=b.recipient_ref?emails.find(e=>e.recipient_ref===b.recipient_ref):emails.length===1?emails[0]:null;
 if(!recipient)throw recipientUnavailable();
 let reserved;
 try{
  reserved=await db.prepare(`INSERT INTO admin_member_mail_requests(send_id,created_at,admin_member_id,admin_role,target_member_id,subject_hash,body_hash,recipient_ref)
   SELECT ?,?,?,?,?,?,?,? WHERE ${ELEVATED_AUTH_GUARD}
   AND EXISTS(SELECT 1 FROM members WHERE member_id=?)
   AND EXISTS(SELECT 1 FROM admin_member_contact_audit WHERE action='member_lookup' AND outcome='revealed' AND admin_member_id=? AND target_member_id=? AND created_at>=?)
   AND (SELECT COUNT(*) FROM admin_member_mail_requests WHERE admin_member_id=? AND created_at>=?)<?
   AND (SELECT COUNT(*) FROM admin_member_mail_requests WHERE created_at>=?)<?`)
   .bind(b.mutation_id,now,actor.member.member_id,actor.role,b.member_id,subjectHash,bodyHash,recipient.recipient_ref,...actorBindings(actor),b.member_id,
    actor.member.member_id,b.member_id,ago(CONTACT_LIMITS.lookupWindow),actor.member.member_id,ago(CONTACT_LIMITS.adminWindow),limits.admin,ago(CONTACT_LIMITS.siteWindow),limits.site).run();
 }catch{
  const raced=await db.prepare('SELECT * FROM admin_member_mail_requests WHERE send_id=?').bind(b.mutation_id).first();if(raced)return replay(raced);throw new AdminError(503,'ADMIN_MAIL_UNAVAILABLE','客服寄信暫時無法使用，未自動重送。');
 }
 if(reserved.meta.changes!==1){await adminIdentity(request,env,ELEVATED_ROLES);throw new AdminError(429,'ADMIN_MAIL_RATE_LIMITED','客服寄信已達保留配額限制，請稍後再試；未自動重送。');}
 // Reservation is committed BEFORE network I/O. A crash is permanently unknown,
 // never a reason to resend the same mutation. All reservations count to quota.
 let outcome='ambiguous';
 try{
  await adminIdentity(request,env,ELEVATED_ROLES);
  // Re-resolve immediately before delivery. Changed mappings must not get mail.
  const fresh=await resolveContactEmails(db,env,b.member_id);
  if(!fresh.some(e=>e.recipient_ref===recipient.recipient_ref))outcome='rejected';
  else({outcome}=await deliverAdminMail(config,b.mutation_id,recipient.email,text.subject,text.body));
 }catch{outcome='rejected';}
 try{
  await db.prepare(`INSERT INTO admin_member_contact_audit(id,created_at,admin_member_id,admin_role,target_member_id,action,send_id,outcome,subject_hash,body_hash)
   VALUES(?,?,?,?,?,'member_mail_send',?,?,?,?)`).bind(crypto.randomUUID(),new Date().toISOString(),actor.member.member_id,actor.role,b.member_id,b.mutation_id,outcome,subjectHash,bodyHash).run();
 }catch{outcome='ambiguous';}
 return jsonSuccess({send_id:b.mutation_id,outcome,replayed:false});
});
export function memberContactRoute(path){return path==='/api/admin/member-lookup'?{method:'POST',handler:lookup}:path==='/api/admin/member-mail/send'?{method:'POST',handler:send}:undefined;}
