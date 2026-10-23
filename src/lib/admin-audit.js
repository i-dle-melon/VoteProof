import { AdminError } from './admin-identity.js';
import { encodeCursor, UUID_PATTERN } from '../api/admin-validation.js';

// Only the five existing auditLogs sources; other audit domains stay separate.
const sources = [
  {key:'admin',table:'admin_audit_logs'},
  {key:'content',table:'admin_content_audit'},
  {key:'member_status',table:'member_status_events',target:'member_id',type:"'member'",version:'NULL',before:"json_object('status',before_status)",after:"json_object('status',after_status)"},
  {key:'member_contact',table:'admin_member_contact_audit',target:'target_member_id',type:"'member'",version:'NULL',reason:'outcome',before:"'{}'",after:"json_object('outcome',outcome)"},
  {key:'mail_pending',table:'admin_member_mail_requests',id:'send_id',target:'target_member_id',type:"'member'",version:'NULL',reason:"'ambiguous'",action:"'member_mail_send'",before:"'{}'",after:"json_object('outcome','ambiguous')",extra:'NOT EXISTS(SELECT 1 FROM admin_member_contact_audit x WHERE x.send_id=r.send_id)'},
];
const col=(s,k)=>({id:s.id??'id',target_id:s.target??'target_id',target_type:s.type??'target_type',target_version:s.version??'target_version',reason:s.reason??'reason',action:s.action??'action'}[k]??k);
const expr=(s,k)=>{const v=col(s,k);return /^(?:NULL|'|json_object\()/i.test(v)?v:'r.'+v;};
const fields=['status','version','points_awarded','point_status','review_stage','review_risk_reason','status_reason','campaign_id','name','category','solo_target','start_at','end_at','campaign_timezone','vote_start_date','vote_end_date','points_per_proof','daily_limit','note','type','vote_type','start_date','end_date','top_n','is_public','is_current_comeback','min_points','tier_id','enabled','title','body','message','submission_instructions','outcome','reason','delta','points','source','role'];
fields.push('case_id','duplicate_of_case_id','transaction_id','leaderboard_id','run_id','row_count','source_count','generated_at','campaign_version','campaign_category','proof_count','example_asset_id','dismissible','button_label','button_enabled','starts_at','ends_at');
export function auditText(value,max=2000){
  if(value==null)return null;
  const raw=String(value);
  return raw.slice(0,max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
    .replace(/https?:\/\/\S+|\b(?:proofs|staging)\/[^\s]+/gi,'[連結或儲存路徑已隱藏]')
    .replace(/\bM-[0-9a-f-]{36}\b/gi,'[會員識別已隱藏]')
    .replace(/\b(?:Bearer\s+\S+|(?:token|secret|cookie|password|credential|csrf|authorization|api[_ -]?key)\s*[:=]\s*[^\s,;]+)/gi,'[敏感內容已隱藏]')
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g,'[長識別資料已隱藏]')+(raw.length>max?'…（內容已截短）':'');
}
function payload(raw){
  if(raw==null)return null;
  try{const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v))return null;
    return Object.fromEntries(fields.filter(k=>Object.hasOwn(v,k)&&(v[k]===null||['string','number','boolean'].includes(typeof v[k]))).map(k=>[k,typeof v[k]==='string'?auditText(v[k],16000):v[k]]));
  }catch{return null;}
}
const actorJoins=`LEFT JOIN members actor ON actor.member_id=p.admin_member_id
 LEFT JOIN members target ON p.target_type IN ('member','admin_membership') AND target.member_id=p.target_id`;
function safeRow(row){
  const {admin_member_id,actor_fan_id,target_fan_id,before_json,after_json,...rest}=row;
  return {...rest,actor_kind:admin_member_id==null||admin_member_id==='system'?'system':'admin',operator_fan_id:auditText(actor_fan_id,64),
    target:['member','admin_membership'].includes(rest.target_type)?(auditText(target_fan_id,64)??'會員（未提供粉絲 ID）'):auditText(rest.target_id,100),
    target_id:['member','admin_membership'].includes(rest.target_type)?null:auditText(rest.target_id,100),reason:auditText(rest.reason,160)};
}
export async function auditSummary(db,page){
  const values=[];
  const branches=sources.map(s=>{
    const where=s.extra?[s.extra]:[];
    for(const [key,value]of Object.entries(page.filters))if(value!==null){where.push(expr(s,['created_from','created_to'].includes(key)?'created_at':key)+(key==='created_from'?' >= ?':key==='created_to'?' < ?':' = ?'));values.push(value);}
    if(page.cursor){where.push(`(${expr(s,'created_at')} < ? OR (${expr(s,'created_at')} = ? AND (${expr(s,'id')} < ? OR (${expr(s,'id')} = ? AND '${s.key}' < ?))))`);values.push(page.cursor[1],page.cursor[1],page.cursor[2],page.cursor[2],page.cursor[3]);}
    values.push(page.limit+1);
    return `SELECT * FROM (SELECT '${s.key}' source,${['id','created_at','admin_member_id','action','target_type','target_id','target_version'].map(k=>expr(s,k)+' AS '+k).join(',')},substr(${expr(s,'reason')},1,161) reason FROM ${s.table} r ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY r.created_at DESC,${expr(s,'id')} DESC LIMIT ?)`;
  });
  values.push(page.limit+1);
  const result=await db.prepare(`WITH candidates AS (${branches.join(' UNION ALL ')}), p AS (SELECT * FROM candidates ORDER BY created_at DESC,id DESC,source DESC LIMIT ?)
   SELECT p.*,actor.player_id actor_fan_id,target.player_id target_fan_id FROM p ${actorJoins} ORDER BY p.created_at DESC,p.id DESC,p.source DESC`).bind(...values).all();
  const rows=result.results.slice(0,page.limit),last=rows.at(-1);
  return {logs:rows.map(safeRow),next_cursor:result.results.length>page.limit?encodeCursor([page.scope,0,last.created_at,last.id,last.source]):null};
}
export async function auditDetail(db,url){
  const id=url.pathname.split('/').at(-1),key=url.searchParams.get('source'),s=sources.find(s=>s.key===key);
  if(!UUID_PATTERN.test(id)||!s||[...url.searchParams.keys()].some(k=>k!=='source')||url.searchParams.getAll('source').length!==1)throw new AdminError(400,'INVALID_ADMIN_QUERY','Invalid audit detail');
  const select=['id','created_at','admin_member_id','action','target_type','target_id','target_version','reason'].map(k=>expr(s,k)+' AS '+k).join(',');
  const row=await db.prepare(`WITH p AS (SELECT '${s.key}' source,${select},${s.before??'r.before_json'} before_json,${s.after??'r.after_json'} after_json FROM ${s.table} r WHERE ${expr(s,'id')}=? ${s.extra?'AND '+s.extra:''} LIMIT 1)
   SELECT p.*,actor.player_id actor_fan_id,target.player_id target_fan_id FROM p ${actorJoins}`).bind(id).first();
  if(!row)throw new AdminError(404,'AUDIT_NOT_FOUND','Audit record unavailable');
  return {log:{...safeRow(row),reason:auditText(row.reason,2000),before:payload(row.before_json),after:payload(row.after_json),detail_policy:'僅顯示原始紀錄已保存且可安全展示的欄位；不提供憑證、私人儲存路徑或內部會員識別。'}};
}
