// Read-only, bounded management views. No member activity logging or image access.
import { adminHandler } from './admin-response.js';
import { jsonSuccess } from './response.js';
import { adminIdentity, ELEVATED_ROLES, AdminError } from '../lib/admin-identity.js';
import { authDatabase } from '../lib/auth-session.js';
import { createTierResolver } from '../lib/member-tier.js';
import { normalizeFanId } from '../lib/fan-id.js';
import { encodeCursor, UUID_PATTERN } from './admin-validation.js';

const invalid=()=>new AdminError(400,'INVALID_MEMBER_OVERVIEW','會員篩選或分頁參數無效。');
const LIMIT=20;
function params(url, allowed) {
  const p=url.searchParams;
  if([...p.keys()].some(k=>!allowed.includes(k)||p.getAll(k).length!==1))throw invalid();
  return p;
}
function cursor(raw, scope, n) {
  if(raw===null)return null;
  try {
    if(raw.length>800||!/^[A-Za-z0-9_-]+$/.test(raw))throw Error();
    const bytes=Uint8Array.from(atob(raw.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
    const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!Array.isArray(v)||v.length!==n+1||v[0]!==scope||v.slice(1).some(x=>typeof x!=='string'||x.length>110))throw Error();
    return v.slice(1);
  }catch{throw invalid();}
}
const validId=id=>typeof id==='string'&&id.startsWith('M-')&&id.length===38&&UUID_PATTERN.test(id.slice(2));
function memberId(url) {
  const id=url.pathname.split('/')[4];
  if(!validId(id))throw invalid();
  return id;
}
async function tierPolicy(db) {
  const rows=(await db.prepare('SELECT tier_id,name,rank_order,min_points,icon_key,status FROM member_tiers ORDER BY rank_order').all()).results;
  return createTierResolver(rows);
}
const countsSql=`SELECT member_id,COUNT(*) total,
  SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
  SUM(CASE WHEN status IN ('approved','completed') THEN 1 ELSE 0 END) approved,
  SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) rejected
  FROM cases WHERE member_id IN (%IDS%) GROUP BY member_id`;
async function aggregatePage(db, members) {
  if(!members.length)return [];
  const ids=members.map(m=>m.member_id), ph=ids.map(()=>'?').join(',');
  const [points,cases]=await db.batch([
    db.prepare(`SELECT member_id,COALESCE(SUM(points),0) total_points
      FROM point_transactions WHERE member_id IN (${ph}) GROUP BY member_id`).bind(...ids),
    db.prepare(countsSql.replace('%IDS%',ph)).bind(...ids),
  ]);
  const pointMap=new Map(points.results.map(r=>[r.member_id,r.total_points]));
  const caseMap=new Map(cases.results.map(r=>[r.member_id,r]));
  const resolve=await tierPolicy(db);
  return members.map(m=>{
    const total_points=pointMap.get(m.member_id)??0;
    if(!Number.isSafeInteger(total_points))throw new AdminError(503,'POINT_SUMMARY_UNAVAILABLE','會員積分無法統計。');
    const c=caseMap.get(m.member_id);
    return {...m,fan_id:m.player_id,player_id:undefined,total_points,tier:resolve(total_points).tier,
      proof_counts:{total:c?.total??0,pending:c?.pending??0,approved:c?.approved??0,rejected:c?.rejected??0}};
  });
}
const list=adminHandler(async(env,url,request)=>{
  await adminIdentity(request,env,ELEVATED_ROLES);
  const p=params(url,['status','fan_id','nickname','cursor']);
  const status=p.get('status')??'all',fan=normalizeFanId(p.get('fan_id')??''),nick=(p.get('nickname')??'').trim();
  if(!['all','active','suspended'].includes(status)||fan.length>100||nick.length>50||fan&&nick)throw invalid();
  const scope=JSON.stringify([status,fan,nick]),prior=cursor(p.get('cursor'),scope,2);
  if(prior&&(!validId(prior[1])||nick&&prior[0].length>50||!nick&&prior[0]!==''))throw invalid();
  const where=[],bind=[],nicknameSort=Boolean(nick);
  if(status!=='all'){where.push('m.status=?');bind.push(status);}
  if(fan){where.push('lower(trim(m.player_id))=?');bind.push(fan);}
  if(nick){
    // Indexed, case-sensitive Unicode prefix range; no leading-wildcard scan.
    const chars=Array.from(nick),last=chars.pop().codePointAt(0);
    const upper=last<0x10ffff?chars.join('')+String.fromCodePoint(last+1):null;
    where.push('m.nickname>=?');bind.push(nick);
    if(upper){where.push('m.nickname<?');bind.push(upper);}
  }
  if(prior){
    if(nicknameSort){where.push('(m.nickname>? OR (m.nickname=? AND m.member_id>?))');bind.push(prior[0],prior[0],prior[1]);}
    else{where.push('m.member_id>?');bind.push(prior[1]);}
  }
  const rows=(await authDatabase(env).prepare(`SELECT m.member_id,m.player_id,m.nickname,m.status,m.created_at
    FROM members m ${where.length?'WHERE '+where.join(' AND '):''}
    ORDER BY ${nicknameSort?'m.nickname ASC,':''}m.member_id ASC LIMIT ?`).bind(...bind,LIMIT+1).all()).results;
  const chosen=rows.slice(0,LIMIT),last=chosen.at(-1);
  return jsonSuccess({members:await aggregatePage(authDatabase(env),chosen),
    next_cursor:rows.length>LIMIT?encodeCursor([scope,nicknameSort?last.nickname:'',last.member_id]):null,
    page_size:LIMIT,search_mode:nick?'nickname_prefix_case_sensitive':fan?'fan_id_exact':'all'});
});
async function findMember(db,id) {
  const r=await db.prepare('SELECT member_id,player_id,nickname,status,created_at FROM members WHERE member_id=?').bind(id).first();
  if(!r)throw new AdminError(404,'MEMBER_NOT_FOUND','查無此會員。');
  return r;
}
const detail=adminHandler(async(env,url,request)=>{
  await adminIdentity(request,env,ELEVATED_ROLES);
  if(url.search)throw invalid();
  const id=memberId(url),db=authDatabase(env),r=await findMember(db,id);
  const [identity,status]=await db.batch([
    db.prepare('SELECT password_enabled,google_identity_id FROM auth_identities WHERE member_id=?').bind(id),
    db.prepare("SELECT reason,created_at FROM member_status_events WHERE member_id=? AND action='member_block' ORDER BY sequence DESC LIMIT 1").bind(id),
  ]);
  const [enriched]=await aggregatePage(db,[r]);
  return jsonSuccess({member:{...enriched,login_methods:identity.results.flatMap(x=>[
    ...(x.password_enabled?['Email／密碼']:[]),...(x.google_identity_id?['Google']:[])]),
    blocked_reason:r.status==='suspended'?status.results[0]?.reason??'未記錄':null,
    blocked_at:r.status==='suspended'?status.results[0]?.created_at??null:null}});
});
const page=adminHandler(async(env,url,request)=>{
  await adminIdentity(request,env,ELEVATED_ROLES);
  const p=params(url,['cursor']),id=memberId(url),db=authDatabase(env);
  await findMember(db,id);
  const kind=url.pathname.endsWith('/transactions')?'transactions':'cases';
  const scope=JSON.stringify([kind,id]),prior=cursor(p.get('cursor'),scope,2);
  if(prior&&(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(prior[0])||!UUID_PATTERN.test(prior[1])))throw invalid();
  const date=prior?'AND (created_at<? OR (created_at=? AND '+(kind==='cases'?'id':'transaction_id')+'<?))':'';
  const sql=kind==='cases'
    ?`SELECT id,case_id,created_at,campaign_id,status,points_awarded,vote_type,vote_date
      FROM cases WHERE member_id=? ${date} ORDER BY created_at DESC,id DESC LIMIT ?`
    :`SELECT transaction_id,created_at,category,points,reason,campaign_id
      FROM point_transactions WHERE member_id=? ${date} ORDER BY created_at DESC,transaction_id DESC LIMIT ?`;
  const rows=(await db.prepare(sql).bind(id,...(prior?[prior[0],prior[0],prior[1]]:[]),LIMIT+1).all()).results;
  const selected=rows.slice(0,LIMIT),last=selected.at(-1);
  const key=kind==='cases'?'id':'transaction_id';
  return jsonSuccess({[kind]:selected.map(({id:internal,...item})=>kind==='cases'?item:{...item,id:internal}),
    next_cursor:rows.length>LIMIT?encodeCursor([scope,last.created_at,last[key]]):null,page_size:LIMIT});
});
export function adminMembersOverviewRoute(path){
  if(path==='/api/admin/members-overview')return{method:'GET',handler:list};
  if(/^\/api\/admin\/members-overview\/M-[0-9a-f-]{36}$/.test(path))return{method:'GET',handler:detail};
  if(/^\/api\/admin\/members-overview\/M-[0-9a-f-]{36}\/(cases|transactions)$/.test(path))return{method:'GET',handler:page};
}
