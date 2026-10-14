import { AdminError } from './admin-identity.js';
import { resolveMemberTier } from './member-tier.js';
export const systemBoards = [
  {leaderboard_id:'system-history',name:'歷史累計',vote_type:null,rule:'所有正式歷史積分，包含調整與撤銷。'},
  {leaderboard_id:'system-group',name:'團體排行',vote_type:'團體',rule:'跨活動的團體正式積分。'},
  {leaderboard_id:'system-solo',name:'Solo排行',vote_type:'Solo',rule:'依穩定 Solo 對象 key 分別累積歷史正式積分。'},
].map(b=>({...b,type:'all_time',system_fixed:true,campaign_id:null,status:'active',is_public:true,top_n:100,version:0}));
export const isSystemBoard = b => b?.type==='all_time' || systemBoards.some(x=>x.leaderboard_id === (typeof b==='string'?b:b?.leaderboard_id));
export function rejectSystemMutation(board) { if(isSystemBoard(board)) throw new AdminError(409,'SYSTEM_LEADERBOARD_FIXED','系統固定榜由正式積分即時統計，無法修改或重建。'); }
export async function liveSystemBoards(db,id=null) {
  const definitions=systemBoards.filter(b=>!id || b.leaderboard_id===id);
  if(!definitions.length)return [];
  const configuration=(await db.prepare('SELECT tier_id,name,icon_key,rank_order,min_points,status FROM member_tiers ORDER BY rank_order').all()).results;
  const totalRows=(await db.prepare('SELECT member_id,SUM(points) total_points FROM point_transactions GROUP BY member_id').all()).results;
  const balances=new Map(totalRows.map(r=>[r.member_id,r.total_points]));
  const targetSql="COALESCE(json_extract(t.metadata_json,'$.solo_target'),p.solo_target)";
  const targets=(await db.prepare(`SELECT DISTINCT ${targetSql} solo_target FROM point_transactions t JOIN campaigns p USING(campaign_id) WHERE t.vote_type='Solo' AND ${targetSql} IS NOT NULL ORDER BY solo_target`).all()).results;
  const unresolved=(await db.prepare(`SELECT COUNT(*) count FROM point_transactions t LEFT JOIN campaigns p USING(campaign_id) WHERE t.vote_type='Solo' AND ${targetSql} IS NULL`).first()).count;
  const boards=[];
  for(const definition of definitions) for(const target of definition.vote_type==='Solo'?(targets.length?targets.map(t=>t.solo_target):[null]):[null]) {
    const data=await db.prepare(`WITH scoped AS (
      SELECT t.*,CASE WHEN t.category IN ('proof_approved','proof_reapproved') THEN 1 WHEN t.category='proof_revoked' THEN -1 ELSE 0 END proof_delta
      FROM point_transactions t LEFT JOIN campaigns p USING(campaign_id)
      WHERE (? IS NULL OR t.vote_type=?) AND (?!='Solo' OR (? IS NOT NULL AND ${targetSql}=?))
    ), history AS (
      SELECT *,ROW_NUMBER() OVER w step,SUM(points) OVER w running_points,SUM(proof_delta) OVER w running_proofs FROM scoped
      WINDOW w AS(PARTITION BY member_id ORDER BY created_at,CASE WHEN category='proof_revoked' THEN 1 ELSE 0 END,transaction_id ROWS UNBOUNDED PRECEDING)
    ), totals AS(SELECT member_id,SUM(points) points,SUM(proof_delta) proof_count FROM scoped GROUP BY member_id),
    departure AS(SELECT h.member_id,COALESCE(MAX(CASE WHEN h.running_points!=t.points OR h.running_proofs!=t.proof_count THEN h.step END),0) last_departure FROM history h JOIN totals t USING(member_id) GROUP BY h.member_id),
    candidates AS(SELECT t.member_id,m.nickname,m.player_id fan_id,t.points,t.proof_count,MIN(h.created_at) reached_at FROM totals t JOIN members m USING(member_id) JOIN departure d USING(member_id) JOIN history h USING(member_id)
      WHERE m.status='active' AND t.points>0 AND h.step>d.last_departure GROUP BY t.member_id,m.nickname,m.player_id,t.points,t.proof_count)
    SELECT *,ROW_NUMBER() OVER(ORDER BY points DESC,proof_count DESC,reached_at,member_id) rank FROM candidates ORDER BY rank LIMIT 100`).bind(definition.vote_type,definition.vote_type,definition.vote_type??'',target,target).all();
    const last=(await db.prepare(`SELECT MAX(created_at) generated_at FROM point_transactions WHERE (? IS NULL OR vote_type=?)`).bind(definition.vote_type,definition.vote_type).first()).generated_at;
    boards.push({...definition,solo_target:target,unresolved_solo_transactions:definition.vote_type==='Solo'?unresolved:0,generated_at:last,rankings:data.results.map(r=>{
      if(!Number.isSafeInteger(r.points)||!Number.isSafeInteger(r.proof_count))throw new AdminError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','排行榜統計暫時無法取得。');
      const resolved=resolveMemberTier(balances.get(r.member_id)??0,configuration);
      const {tier_id,name,icon_key}=resolved.tier;
      return {...r,tier:{tier_id,name,icon_key},tier_configuration_ready:resolved.tier_configuration_ready};
    })});
  }
  return boards;
}
