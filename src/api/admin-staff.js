import { adminHandler } from './admin-response.js';
import { jsonSuccess } from './response.js';
import { readReviewJson } from './admin-validation.js';
import { normalizeEmail } from './auth-validation.js';
import { authDatabase } from '../lib/auth-session.js';
import { emailHash } from '../lib/auth-identity.js';
import { AdminError, adminIdentity, adminCsrf, REVIEW_AUTH_GUARD, actorBindings } from '../lib/admin-identity.js';

const invalid = () => new AdminError(400,'INVALID_STAFF_REQUEST','請輸入 Google 帳號並選擇管理員或審核員。');
const conflict = () => new AdminError(409,'STAFF_CONFLICT','帳號權限已變更，請重新載入確認。');
const superGuard = REVIEW_AUTH_GUARD.replace('a.role = ?', "a.role = ? AND a.role = 'super_admin'");
const safe = row => ({ nickname:row.nickname,fan_id:row.player_id,role:row.role,status:row.status });
const handler = adminHandler(async(env,url,request)=>{
 const actor=await adminIdentity(request,env,['super_admin']),db=authDatabase(env);
 if(url.search)throw invalid();
 // Role mapping is authoritative; never authorize by a client-provided email.
 // Fail closed if an inconsistent registry has more than one active owner.
 if((await db.prepare("SELECT COUNT(*) n FROM admin_memberships WHERE role='super_admin' AND status='active'").first()).n!==1)
   throw new AdminError(503,'STAFF_OWNER_UNAVAILABLE','主管理員設定需要確認，暫時無法新增權限。');
 if(request.method==='GET')return jsonSuccess({memberships:(await db.prepare(`SELECT m.nickname,m.player_id,a.role,a.status FROM admin_memberships a
   JOIN members m USING(member_id) ORDER BY CASE a.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,a.created_at,a.id`).all()).results.map(safe)});
 await adminCsrf(request,env,actor);
 const body=await readReviewJson(request);
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['email','role'].includes(k))||!['admin','reviewer'].includes(body.role))throw invalid();
 let email;try{email=normalizeEmail(body.email);}catch{throw invalid();}
 const hash=await emailHash(env,email),target=await db.prepare(`SELECT i.member_id,i.google_identity_id,m.nickname,m.player_id FROM auth_identities i
   JOIN members m USING(member_id) WHERE i.email_lookup_hash=? AND i.google_identity_id IS NOT NULL AND m.status='active'`).bind(hash).first();
 if(!target)throw new AdminError(404,'STAFF_GOOGLE_MEMBER_REQUIRED','找不到可授權的 Google 會員，請對方先以此 Google 帳號登入並完成會員資料。');
 if(target.member_id===actor.member.member_id)throw invalid();
 const previous=await db.prepare('SELECT * FROM admin_memberships WHERE member_id=?').bind(target.member_id).first();
 if(previous?.role==='super_admin'||previous?.status==='disabled'||previous?.role==='admin'&&body.role!=='admin')throw conflict();
 if(previous?.role===body.role)return jsonSuccess({membership:safe({...target,...previous}),outcome:'already_granted'});
 const id=previous?.id??crypto.randomUUID(),audit=crypto.randomUUID(),now=new Date().toISOString();
 const identityGuard=`EXISTS(SELECT 1 FROM auth_identities i JOIN members m USING(member_id) WHERE i.member_id=? AND i.email_lookup_hash=? AND i.google_identity_id=? AND m.status='active')`;
 const guardArgs=[...actorBindings(actor),target.member_id,hash,target.google_identity_id];
 const ownerGuard="(SELECT COUNT(*) FROM admin_memberships WHERE role='super_admin' AND status='active')=1";
 const statement=previous?db.prepare(`UPDATE admin_memberships SET role=?,updated_at=? WHERE id=? AND role='reviewer' AND status='active' AND updated_at=?
   AND ${superGuard} AND ${identityGuard} AND ${ownerGuard}`).bind(body.role,now,id,previous.updated_at,...guardArgs)
   :db.prepare(`INSERT INTO admin_memberships(id,member_id,role,status,created_at,created_by,updated_at)
     SELECT ?,?,?,'active',?,?,? WHERE ${superGuard} AND ${identityGuard} AND ${ownerGuard}`).bind(id,target.member_id,body.role,now,actor.member.member_id,now,...guardArgs);
 let results;
 try{results=await db.batch([statement,
   // Reuse the established membership-grant audit action; do not store email,
   // provider IDs, credentials or tokens in the audit record.
   db.prepare(`INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,before_json,after_json)
     SELECT ?,?,?,?,'bootstrap_membership','admin_membership',id,?,json_object('role',role,'status',status)
     FROM admin_memberships WHERE id=? AND updated_at=? AND role=? AND changes()=1`).bind(audit,now,actor.member.member_id,actor.role,JSON.stringify(previous?{role:previous.role,status:previous.status}:{}),id,now,body.role),
   db.prepare('SELECT role,status FROM admin_memberships WHERE id=?').bind(id)]);
 }catch{throw conflict();}
 if(results[0].meta.changes!==1)throw conflict();
 return jsonSuccess({membership:safe({...target,...results[2].results[0]}),outcome:previous?'upgraded':'granted'},'no-store',previous?200:201);
});
export function staffRoute(path,method){if(path==='/api/admin/staff')return{method:method==='POST'?'POST':'GET',allow:'GET, POST',handler};}
