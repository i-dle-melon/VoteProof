import {adminHandler} from './admin-response.js';
import {jsonSuccess} from './response.js';
import {readReviewJson,adminPage,encodeCursor} from './admin-validation.js';
import {authDatabase} from '../lib/auth-session.js';
import {normalizeFanId} from '../lib/fan-id.js';
import {AdminError,adminIdentity,adminCsrf,ELEVATED_ROLES,ELEVATED_AUTH_GUARD,actorBindings} from '../lib/admin-identity.js';

const invalid=()=>new AdminError(400,'INVALID_MEMBER_BLOCK','請輸入粉絲 ID、1～500 字原因，並再次確認操作。');
const conflict=()=>new AdminError(409,'MEMBER_STATUS_CONFLICT','會員狀態已變更，請重新載入名單確認。');
const safe=row=>({fan_id:row.player_id,nickname:row.nickname,status:row.status});
const handler=adminHandler(async(env,url,request)=>{
 const actor=await adminIdentity(request,env,ELEVATED_ROLES),db=authDatabase(env);
 if(request.method==='GET'){
  if([...url.searchParams.keys()].some(k=>!['limit','cursor'].includes(k)))throw invalid();
  const page=adminPage(url),rows=(await db.prepare(`SELECT m.id,m.player_id,m.nickname,m.status,m.updated_at,
    e.reason,e.created_at AS blocked_at FROM members m LEFT JOIN member_status_events e ON e.sequence=
    (SELECT MAX(sequence) FROM member_status_events WHERE member_id=m.member_id AND action='member_block')
    WHERE m.status='suspended' ${page.cursor?'AND (m.updated_at<? OR (m.updated_at=? AND m.id<?))':''}
    ORDER BY m.updated_at DESC,m.id DESC LIMIT ?`).bind(...(page.cursor?[page.cursor[1],page.cursor[1],page.cursor[2]]:[]),page.limit+1).all()).results;
  const selected=rows.slice(0,page.limit),last=selected.at(-1);
  return jsonSuccess({members:selected.map(r=>({...safe(r),reason:r.reason??'既有封鎖，未記錄原因',blocked_at:r.blocked_at??r.updated_at})),next_cursor:rows.length>page.limit?encodeCursor([page.scope,0,last.updated_at,last.id]):null});
 }
 if(url.search)throw invalid();await adminCsrf(request,env,actor);
 const b=await readReviewJson(request);
 if(!b||Array.isArray(b)||Object.keys(b).some(k=>!['fan_id','confirmed_fan_id','reason','action'].includes(k))||!['block','restore'].includes(b.action)||typeof b.fan_id!=='string'||typeof b.confirmed_fan_id!=='string'||typeof b.reason!=='string'||/[\u0000-\u001f\u007f]/.test(b.fan_id+b.reason)||!b.reason.trim()||[...b.reason.trim()].length>500)throw invalid();
 const fan=normalizeFanId(b.fan_id),reason=b.reason.trim();if(!fan||[...fan].length>100||normalizeFanId(b.confirmed_fan_id)!==fan)throw invalid();
 const target=await db.prepare('SELECT member_id,player_id,nickname,status,updated_at FROM members WHERE lower(trim(player_id))=?').bind(fan).first();
 if(!target)throw new AdminError(404,'MEMBER_NOT_FOUND','找不到此粉絲 ID 的會員。');
 const blocking=b.action==='block',desired=blocking?'suspended':'active',previous=blocking?'active':'suspended';
 if(target.member_id===actor.member.member_id||blocking&&await db.prepare("SELECT 1 FROM admin_memberships WHERE member_id=? AND role IN ('admin','super_admin') AND status='active'").bind(target.member_id).first())throw new AdminError(403,'MEMBER_BLOCK_PROTECTED','不能封鎖自己、主管理員或管理員帳號。');
 if(target.status===desired)return jsonSuccess({member:safe(target),outcome:'already_'+b.action});
 const id=crypto.randomUUID(),now=new Date().toISOString(),seconds=Math.floor(Date.now()/1000);
 try{
  await db.batch([
   db.prepare(`UPDATE members SET status=?,updated_at=? WHERE member_id=? AND status=? AND updated_at=? AND ${ELEVATED_AUTH_GUARD}
     ${blocking?"AND NOT EXISTS(SELECT 1 FROM admin_memberships WHERE member_id=members.member_id AND role IN ('admin','super_admin') AND status='active')":''}`)
    .bind(desired,now,target.member_id,previous,target.updated_at,...actorBindings(actor)),
   db.prepare('INSERT INTO auth_atomic_guards(id,valid) VALUES(?,changes())').bind(id),
   db.prepare('INSERT INTO member_status_events(id,member_id,created_at,admin_member_id,admin_role,action,before_status,after_status,reason) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,target.member_id,now,actor.member.member_id,actor.role,blocking?'member_block':'member_restore',previous,desired,reason),
   ...(blocking?[
    // Keep the session identifiable: its status check must report a block, not silently become Guest.
    db.prepare('UPDATE auth_sessions SET elevated_until=0,reauthenticated_until=0,google_authenticated_until=0 WHERE member_id=?').bind(target.member_id),
    db.prepare('UPDATE trusted_devices SET revoked_at=? WHERE member_id=? AND revoked_at IS NULL').bind(seconds,target.member_id),
    db.prepare('UPDATE auth_transactions SET consumed_at=? WHERE member_id=? AND consumed_at IS NULL').bind(seconds,target.member_id),
   ]:[]),
   db.prepare('DELETE FROM auth_atomic_guards WHERE id=?').bind(id),
  ]);
 }catch{
  await adminIdentity(request,env,ELEVATED_ROLES);
  const fresh=await db.prepare('SELECT status FROM members WHERE member_id=?').bind(target.member_id).first();
  if(fresh?.status===desired)return jsonSuccess({member:safe({...target,status:desired}),outcome:'already_'+b.action});
  throw conflict();
 }
 return jsonSuccess({member:safe({...target,status:desired}),outcome:blocking?'blocked':'restored'});
});
export function memberBlockRoute(path,method){if(path==='/api/admin/member-blocks')return{method:method==='POST'?'POST':'GET',allow:'GET, POST',handler};}
