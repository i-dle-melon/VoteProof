import { adminHandler } from './admin-response.js';
import { jsonSuccess } from './response.js';
import { authDatabase } from '../lib/auth-session.js';
import { AdminError,adminIdentity,adminCsrf,ELEVATED_ROLES,ELEVATED_AUTH_GUARD,actorBindings } from '../lib/admin-identity.js';
import { CAMPAIGN_ID,campaignClassificationReady } from '../lib/campaign-policy.js';
import { campaignRow } from '../lib/campaign-store.js';
import { campaignContent,publicAnnouncements,announcementInput,saveAnnouncement,contentInvalid } from '../lib/site-content.js';
import { readReviewJson } from './admin-validation.js';
import { privateProofResponse } from './admin.js';
import { allowedMime,MIME_EXTENSIONS } from './upload-validation.js';
const missing=()=>new AdminError(404,'CONTENT_NOT_FOUND','找不到內容。');
async function assetResponse(env,asset){
 if(!asset||!asset.object_key.startsWith('campaign-assets/'+asset.campaign_id+'/example/'))throw missing();
 return privateProofResponse(env,asset);
}
const handler=adminHandler(async(env,url,request)=>{
 const db=authDatabase(env),parts=url.pathname.split('/');
 if(url.search)throw contentInvalid();
 if(url.pathname==='/api/announcements')return jsonSuccess({announcements:await publicAnnouncements(db)});
 if(parts[2]==='campaigns'){
  const id=parts[3];if(!CAMPAIGN_ID.test(id??''))throw missing();
  const row=await campaignRow(db,id),now=new Date().toISOString();
  if(!campaignClassificationReady(row)||row.status!=='active'||row.start_at>now||row.end_at<=now)throw missing();
  const content=await campaignContent(db,id);
  if(parts[4]==='guidance')return jsonSuccess({submission_instructions:content.submission_instructions,example_image_url:content.example_asset_id?'/api/campaigns/'+encodeURIComponent(id)+'/example':null});
  const asset=await db.prepare('SELECT * FROM campaign_example_assets WHERE asset_id=? AND campaign_id=?').bind(content.example_asset_id,id).first();return assetResponse(env,asset);
 }
 const actor=await adminIdentity(request,env,ELEVATED_ROLES);
 if(request.method==='POST')await adminCsrf(request,env,actor);
 if(parts[3]==='announcements'){
  if(request.method==='GET')return jsonSuccess({announcements:(await db.prepare('SELECT * FROM site_announcements ORDER BY updated_at DESC,announcement_id').all()).results.map(({last_mutation_id,...r})=>({...r,enabled:Boolean(r.enabled),dismissible:Boolean(r.dismissible)}))});
  return jsonSuccess(await saveAnnouncement(db,actor,announcementInput(await readReviewJson(request),Boolean(parts[4])),parts[4]??null),'no-store',parts[4]?200:201);
 }
 if(parts[3]==='campaigns'){
  const id=parts[4];if(!CAMPAIGN_ID.test(id??'')||!await campaignRow(db,id))throw missing();return jsonSuccess(await campaignContent(db,id));
 }
 const id=parts[4];
 if(request.method==='GET'){if(!/^[a-f0-9-]{36}$/.test(id??''))throw missing();return assetResponse(env,await db.prepare('SELECT * FROM campaign_example_assets WHERE asset_id=?').bind(id).first());}
 // Upload before Campaign creation is allowed, but its path is always generated
 // from a validated Campaign identity and never a caller-supplied object key.
 if(!CAMPAIGN_ID.test(id??''))throw contentInvalid();
 const mime=request.headers.get('Content-Type')?.split(';')[0];if(!allowedMime(mime))throw new AdminError(400,'INVALID_IMAGE_TYPE','範例圖片僅支援 PNG、JPEG、WEBP。');
 if(Number(request.headers.get('Content-Length'))>5242880)throw new AdminError(413,'CONTENT_IMAGE_TOO_LARGE','範例圖片最多 5 MB。');
 const reader=request.body?.getReader();if(!reader)throw contentInvalid();const chunks=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>5242880){await reader.cancel();throw new AdminError(413,'CONTENT_IMAGE_TOO_LARGE','範例圖片最多 5 MB。');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const ascii=(start,end)=>new TextDecoder().decode(bytes.subarray(start,end));
 const raster=size>=12&&(mime==='image/png'&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)||mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255||mime==='image/webp'&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP');
 if(!raster)throw new AdminError(400,'INVALID_IMAGE_TYPE','圖片內容與格式不符。');
 const asset_id=crypto.randomUUID(),key='campaign-assets/'+id+'/example/'+asset_id+'.'+MIME_EXTENSIONS[mime],now=new Date().toISOString();
 const object=await env.PROOFS_BUCKET.put(key,bytes,{httpMetadata:{contentType:mime},onlyIf:new Headers({'If-None-Match':'*'})});if(!object)throw new AdminError(409,'CONTENT_CONFLICT','圖片上傳衝突，請重試。');
 try{const results=await db.batch([
  db.prepare(`INSERT INTO campaign_example_assets(asset_id,campaign_id,object_key,content_type,size,etag,created_at,created_by) SELECT ?,?,?,?,?,?,?,? WHERE ${ELEVATED_AUTH_GUARD}`).bind(asset_id,id,key,mime,size,object.etag,now,actor.member.member_id,...actorBindings(actor)),
  db.prepare(`INSERT INTO admin_content_audit(id,created_at,admin_member_id,admin_role,action,target_type,target_id,before_json,after_json)
    SELECT ?,?,?,?,'example_image_upload','campaign_asset',asset_id,'{}',json_object('campaign_id',campaign_id,'asset_id',asset_id,'size',size,'content_type',content_type) FROM campaign_example_assets WHERE asset_id=?`).bind(crypto.randomUUID(),now,actor.member.member_id,actor.role,asset_id),
 ]);if(results[0].meta.changes!==1)throw new AdminError(403,'ADMIN_FORBIDDEN','圖片上傳權限已失效。');}
 catch(error){if(!await db.prepare('SELECT asset_id FROM campaign_example_assets WHERE asset_id=?').bind(asset_id).first())await env.PROOFS_BUCKET.delete(key);throw error;}
 return jsonSuccess({asset_id,content_type:mime,size},'no-store',201);
});
export function siteContentRoute(path,method){
 if(path==='/api/announcements'||/^\/api\/campaigns\/[A-Za-z0-9_-]{1,100}\/(guidance|example)$/.test(path))return{method:'GET',handler};
 if(path==='/api/admin/announcements')return{method:method==='POST'?'POST':'GET',allow:'GET, POST',handler};
 if(/^\/api\/admin\/announcements\/[a-f0-9-]{36}\/update$/.test(path))return{method:'POST',handler};
 if(/^\/api\/admin\/campaigns\/[A-Za-z0-9_-]{1,100}\/guidance$/.test(path))return{method:'GET',handler};
 if(/^\/api\/admin\/campaign-assets\/[A-Za-z0-9_-]{1,100}$/.test(path))return{method:method==='POST'?'POST':'GET',allow:'GET, POST',handler};
}
