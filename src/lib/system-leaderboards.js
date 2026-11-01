import { AdminError } from './admin-identity.js';
import { resolveMemberTier } from './member-tier.js';
import {ELEVATED_AUTH_GUARD,actorBindings} from './admin-identity.js';
export async function configuredSystemBoards(db,enabled=false){
 if(!enabled)return systemBoards.map(b=>({...b}));
 const rows=(await db.prepare("SELECT leaderboard_id,name,top_n,is_public,version FROM admin_leaderboard_presentations").all()).results;
 return systemBoards.map(b=>{const r=rows.find(r=>r.leaderboard_id===b.leaderboard_id);return r?{...b,...r,is_public:Boolean(r.is_public)}:{...b};});
}
export async function saveSystemPresentation(db,actor,id,input){
 const base=systemBoards.find(b=>b.leaderboard_id===id),bad=()=>new AdminError(400,'INVALID_LEADERBOARD_REQUEST','固定榜只可設定名稱、顯示及名次數。');
 if(!base||!input||Object.keys(input).sort().join(',')!=='expected_version,is_public,name,top_n'||typeof input.name!=='string'||!input.name.trim()||[...input.name.trim()].length>100||/[\u0000-\u001f\u007f]/.test(input.name)||typeof input.is_public!=='boolean'||!Number.isInteger(input.top_n)||input.top_n<1||input.top_n>100||!Number.isSafeInteger(input.expected_version)||input.expected_version<0)throw bad();
 const prior=await db.prepare('SELECT * FROM admin_leaderboard_presentations WHERE leaderboard_id=?').bind(id).first(),marker=crypto.randomUUID(),at=new Date().toISOString();
 if((prior?.version??0)!==input.expected_version)throw new AdminError(409,'LEADERBOARD_CONFLICT','設定已變更。');
 const statement=prior?db.prepare(`UPDATE admin_leaderboard_presentations SET name=?,top_n=?,is_public=?,version=version+1,updated_at=?,updated_by=?,last_mutation_id=? WHERE leaderboard_id=? AND version=? AND ${ELEVATED_AUTH_GUARD}`)
 .bind(input.name.trim(),input.top_n,Number(input.is_public),at,actor.member.member_id,marker,id,input.expected_version,...actorBindings(actor)):
 db.prepare(`INSERT INTO admin_leaderboard_presentations(leaderboard_id,name,top_n,is_public,updated_at,updated_by,last_mutation_id,version)
 SELECT ?,?,?,?,?,?,?,1 WHERE ${ELEVATED_AUTH_GUARD}`)
 .bind(id,input.name.trim(),input.top_n,Number(input.is_public),at,actor.member.member_id,marker,...actorBindings(actor));
 try{const r=await db.batch([statement,db.prepare(`INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json)
 SELECT ?,?,?,?,'leaderboard_update','leaderboard','presentation:'||leaderboard_id,version,?,json_object('name',name,'top_n',top_n,'is_public',is_public) FROM admin_leaderboard_presentations WHERE leaderboard_id=? AND last_mutation_id=?`)
 .bind(marker,at,actor.member.member_id,actor.role,JSON.stringify(prior?{name:prior.name,top_n:prior.top_n,is_public:prior.is_public}:base),id,marker)]);if(r[0].meta.changes!==1)throw new AdminError(409,'LEADERBOARD_CONFLICT','設定或權限已變更。');}
 catch(error){if((await db.prepare('SELECT last_mutation_id FROM admin_leaderboard_presentations WHERE leaderboard_id=?').bind(id).first())?.last_mutation_id!==marker)throw error;}
 return (await configuredSystemBoards(db,true)).find(b=>b.leaderboard_id===id);
}
export const systemBoards = [
  {leaderboard_id:'system-history',name:'歷史累計',vote_type:null,rule:'所有正式歷史積分，包含調整與撤銷。'},
  {leaderboard_id:'system-group',name:'團體排行',vote_type:'團體',rule:'跨活動的團體正式積分。'},
  {leaderboard_id:'system-solo',name:'Solo 總排行',vote_type:'Solo',rule:'跨所有活動的 Solo 正式歷史積分，包含撤銷，不再細分對象。'},
].map(b=>({...b,type:'all_time',system_fixed:true,campaign_id:null,status:'active',is_public:true,top_n:100,version:0}));
export const isSystemBoard = b => b?.type==='all_time' || systemBoards.some(x=>x.leaderboard_id === (typeof b==='string'?b:b?.leaderboard_id));
export function rejectSystemMutation(board) { if(isSystemBoard(board)) throw new AdminError(409,'SYSTEM_LEADERBOARD_FIXED','系統固定榜由正式積分即時統計，無法修改或重建。'); }
export async function liveSystemBoards(db,id=null) {
  const definitions=(await configuredSystemBoards(db)).filter(b=>!id || b.leaderboard_id===id);
  if(!definitions.length)return [];
  const configuration=(await db.prepare('SELECT tier_id,name,icon_key,rank_order,min_points,status FROM member_tiers ORDER BY rank_order').all()).results;
  const totalRows=(await db.prepare('SELECT member_id,SUM(points) total_points FROM point_transactions GROUP BY member_id').all()).results;
  const balances=new Map(totalRows.map(r=>[r.member_id,r.total_points]));
  const boards=[];
  for(const definition of definitions) {
    const data=await db.prepare(`WITH scoped AS (
      SELECT t.*,CASE WHEN t.category IN ('proof_approved','proof_reapproved') THEN 1 WHEN t.category='proof_revoked' THEN -1 ELSE 0 END proof_delta
      FROM point_transactions t
      WHERE (? IS NULL OR t.vote_type=?)
    ), history AS (
      SELECT *,ROW_NUMBER() OVER w step,SUM(points) OVER w running_points,SUM(proof_delta) OVER w running_proofs FROM scoped
      WINDOW w AS(PARTITION BY member_id ORDER BY created_at,CASE WHEN category='proof_revoked' THEN 1 ELSE 0 END,transaction_id ROWS UNBOUNDED PRECEDING)
    ), totals AS(SELECT member_id,SUM(points) points,SUM(proof_delta) proof_count FROM scoped GROUP BY member_id),
    departure AS(SELECT h.member_id,COALESCE(MAX(CASE WHEN h.running_points!=t.points OR h.running_proofs!=t.proof_count THEN h.step END),0) last_departure FROM history h JOIN totals t USING(member_id) GROUP BY h.member_id),
    candidates AS(SELECT t.member_id,m.nickname,m.player_id fan_id,t.points,t.proof_count,MIN(h.created_at) reached_at FROM totals t JOIN members m USING(member_id) JOIN departure d USING(member_id) JOIN history h USING(member_id)
      WHERE m.status='active' AND t.points>0 AND h.step>d.last_departure GROUP BY t.member_id,m.nickname,m.player_id,t.points,t.proof_count)
    SELECT *,ROW_NUMBER() OVER(ORDER BY points DESC,proof_count DESC,reached_at,member_id) rank FROM candidates ORDER BY rank LIMIT ?`).bind(definition.vote_type,definition.vote_type,definition.top_n).all();
    const last=(await db.prepare(`SELECT MAX(created_at) generated_at FROM point_transactions WHERE (? IS NULL OR vote_type=?)`).bind(definition.vote_type,definition.vote_type).first()).generated_at;
    boards.push({...definition,generated_at:last,rankings:data.results.map(r=>{
      if(!Number.isSafeInteger(r.points)||!Number.isSafeInteger(r.proof_count))throw new AdminError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','排行榜統計暫時無法取得。');
      const resolved=resolveMemberTier(balances.get(r.member_id)??0,configuration);
      const {tier_id,name,icon_key}=resolved.tier;
      return {...r,tier:{tier_id,name,icon_key},tier_configuration_ready:resolved.tier_configuration_ready};
    })});
  }
  return boards;
}
