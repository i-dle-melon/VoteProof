import { AdminError, ELEVATED_AUTH_GUARD, actorBindings } from './admin-identity.js';
export const contentInvalid=()=>new AdminError(400,'INVALID_CONTENT_REQUEST','請確認公告、投稿說明或圖片設定。');
export function contentText(value,max,required=false){if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||required&&!value.trim())throw contentInvalid();return value.trim();}
export function campaignContentInput(body){
 if(body.submission_instructions===undefined&&body.example_asset_id===undefined)return null;
 const instructions=contentText(body.submission_instructions??'',5000),asset=body.example_asset_id??null;
 if(asset!==null&&(typeof asset!=='string'||!/^[a-f0-9-]{36}$/.test(asset)))throw contentInvalid();
 return{submission_instructions:instructions,example_asset_id:asset};
}
export async function campaignContent(db,id){return await db.prepare('SELECT submission_instructions,example_asset_id,version FROM campaign_content WHERE campaign_id=?').bind(id).first()??{submission_instructions:'',example_asset_id:null,version:0};}
export function contentAudit(db,actor,action,type,id,before,after,now=new Date().toISOString()){
 return db.prepare(`INSERT INTO admin_content_audit(id,created_at,admin_member_id,admin_role,action,target_type,target_id,before_json,after_json)
  SELECT ?,?,?,?,?,?,?,?,? WHERE ${ELEVATED_AUTH_GUARD}`).bind(crypto.randomUUID(),now,actor.member.member_id,actor.role,action,type,id,JSON.stringify(before??{}),JSON.stringify(after??{}),...actorBindings(actor));
}
export function announcementInput(body,updating=false){
 const fields=['title','body','enabled','dismissible','starts_at','ends_at','button_label','button_url','button_enabled',...(updating?['expected_version']:[])];
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!fields.includes(k))||typeof body.enabled!=='boolean'||typeof body.dismissible!=='boolean'||body.button_enabled!==undefined&&typeof body.button_enabled!=='boolean')throw contentInvalid();
 const result={title:contentText(body.title,100,true),body:contentText(body.body,5000,true),enabled:body.enabled,dismissible:body.dismissible,button_label:contentText(body.button_label??'',60),button_url:contentText(body.button_url??'',2048)};
 result.button_enabled=body.button_enabled??Boolean(result.button_url);
 for(const k of ['starts_at','ends_at']){const v=body[k]??null;if(v!==null&&(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v))throw contentInvalid();result[k]=v;}
 if(result.starts_at&&result.ends_at&&result.starts_at>=result.ends_at)throw contentInvalid();
 if(result.button_enabled&&!result.button_url)throw contentInvalid();
 if(Boolean(result.button_label)!==Boolean(result.button_url))throw contentInvalid();
 if(result.button_url){let url;try{url=new URL(result.button_url);}catch{throw contentInvalid();}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw contentInvalid();result.button_url=url.href;}
 if(updating){if(!Number.isSafeInteger(body.expected_version)||body.expected_version<0)throw contentInvalid();result.expected_version=body.expected_version;}
 return result;
}
export const publicAnnouncementColumns='announcement_id,title,body,dismissible,button_label,button_url,button_enabled,version,updated_at';
export async function publicAnnouncements(db){const now=new Date().toISOString();return(await db.prepare(`SELECT ${publicAnnouncementColumns} FROM site_announcements WHERE enabled=1 AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) ORDER BY updated_at DESC,announcement_id LIMIT 20`).bind(now,now).all()).results.map(r=>({...r,dismissible:Boolean(r.dismissible),button_enabled:Boolean(r.button_enabled)}));}
export async function saveAnnouncement(db,actor,input,id=null){
 const existing=id?await db.prepare('SELECT * FROM site_announcements WHERE announcement_id=?').bind(id).first():null;
 if(id&&!existing)throw new AdminError(404,'CONTENT_NOT_FOUND','找不到公告。');
 if(existing?.version!==undefined&&existing.version!==input.expected_version)throw new AdminError(409,'CONTENT_CONFLICT','公告已更新，請重新載入。');
 id??=crypto.randomUUID();const marker=crypto.randomUUID(),now=new Date().toISOString(),fields=['title','body','enabled','dismissible','starts_at','ends_at','button_label','button_url','button_enabled'],values=fields.map(k=>['enabled','dismissible','button_enabled'].includes(k)?Number(input[k]):input[k]);
 const statement=existing?db.prepare(`UPDATE site_announcements SET ${fields.map(k=>k+'=?').join(',')},version=version+1,updated_at=?,updated_by=?,last_mutation_id=? WHERE announcement_id=? AND version=? AND ${ELEVATED_AUTH_GUARD}`).bind(...values,now,actor.member.member_id,marker,id,input.expected_version,...actorBindings(actor))
 :db.prepare(`INSERT INTO site_announcements(${fields.join(',')},announcement_id,created_at,updated_at,updated_by,last_mutation_id) SELECT ${Array(fields.length+5).fill('?').join(',')} WHERE ${ELEVATED_AUTH_GUARD}`).bind(...values,id,now,now,actor.member.member_id,marker,...actorBindings(actor));
 const action=!existing?'announcement_create':Boolean(existing.enabled)!==input.enabled?input.enabled?'announcement_enable':'announcement_disable':'announcement_update';
 const result=await db.batch([statement,
  db.prepare(`INSERT INTO admin_content_audit(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json)
    SELECT ?,?,?,?,?,'announcement',announcement_id,version,?,json_object('title',title,'enabled',enabled,'version',version,'body',body,'dismissible',dismissible,'button_label',button_label,'button_url',button_url,'button_enabled',button_enabled,'starts_at',starts_at,'ends_at',ends_at)
    FROM site_announcements WHERE announcement_id=? AND last_mutation_id=?`).bind(marker,now,actor.member.member_id,actor.role,action,JSON.stringify(existing??{}),id,marker),
  db.prepare('SELECT * FROM site_announcements WHERE announcement_id=? AND last_mutation_id=?').bind(id,marker)]);
 if(result[0].meta.changes!==1)throw new AdminError(409,'CONTENT_CONFLICT','公告已更新或權限已改變，請重新載入。');
 const {last_mutation_id,...safe}=result[2].results[0];return{...safe,enabled:Boolean(safe.enabled),dismissible:Boolean(safe.dismissible),button_enabled:Boolean(safe.button_enabled)};
}
