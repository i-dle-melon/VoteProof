import {systemBoards} from './system-leaderboards.js';
import {liveRankingCte,INTEGRITY_SQL} from './leaderboard-ranking.js';
import {createTierResolver} from './member-tier.js';
import {AdminError} from './admin-identity.js';

const columns='leaderboard_id,name,type,campaign_id,vote_type,start_date,end_date,top_n,version,is_current_comeback';
const safeDefinition=b=>({...b,is_current_comeback:Boolean(b.is_current_comeback),generated_at:null,rankings:[]});
export async function publicBoardDefinitions(db,id=null){
  const fixed=systemBoards.filter(b=>id===null||b.leaderboard_id===id).map(safeDefinition);
  if(fixed.length&&id!==null)return fixed;
  const rows=(await db.prepare(`SELECT ${columns} FROM leaderboards WHERE type!='all_time' AND status='active' AND is_public=1
    ${id===null?'':'AND leaderboard_id=?'} ORDER BY created_at,leaderboard_id`).bind(...(id===null?[]:[id])).all()).results;
  return [...fixed,...rows.map(safeDefinition)];
}
export async function liveBoardRanking(db,definition,context={tierResolvers:new Map()}){
  const clauses=[],args=[];
  if(definition.campaign_id){clauses.push('t.campaign_id=?');args.push(definition.campaign_id);}
  if(definition.vote_type){clauses.push('t.vote_type=?');args.push(definition.vote_type);}
  if(definition.type==='custom'){clauses.push('t.vote_date BETWEEN ? AND ?');args.push(definition.start_date,definition.end_date);}
  const scope=`SELECT t.transaction_id,t.member_id,t.points,t.category,t.created_at,CASE WHEN t.category IN ('proof_approved','proof_reapproved') THEN 1
    WHEN t.category='proof_revoked' THEN -1 ELSE 0 END proof_delta FROM point_transactions t
    ${clauses.length?'WHERE '+clauses.join(' AND '):''}`;
  const history=definition.leaderboard_id==='system-history';
  // Scores, full-scope integrity, tier configuration and global tier balances
  // are read in one SQL snapshot. No balance reuse across separate snapshots.
  const data=(await db.prepare(`${liveRankingCte(scope)}, selected AS (
    SELECT r.*,m.player_id fan_id FROM ranked r JOIN members m ON m.member_id=r.member_id WHERE r.rank<=? ORDER BY r.rank
  )${history?'':`, tier_totals AS (
    SELECT member_id,SUM(points) total_points FROM point_transactions
    WHERE member_id IN (SELECT member_id FROM selected) GROUP BY member_id
  )`}
  SELECT MAX(created_at) generated_at,${INTEGRITY_SQL} integrity_errors,
    (SELECT json_group_array(json_object('tier_id',tier_id,'name',name,'icon_key',icon_key,'rank_order',rank_order,'min_points',min_points,'status',status))
      FROM (SELECT tier_id,name,icon_key,rank_order,min_points,status FROM member_tiers ORDER BY rank_order)) tier_json,
    (SELECT json_group_array(json(item)) FROM (
      SELECT json_object('rank',r.rank,'member_id',r.member_id,'nickname',r.nickname,'fan_id',r.fan_id,'points',r.points,'proof_count',r.proof_count,'reached_at',r.reached_at,'total_points',${history?'r.points':'COALESCE(t.total_points,0)'}) item
      FROM selected r ${history?'':'LEFT JOIN tier_totals t ON t.member_id=r.member_id'} ORDER BY r.rank)) rankings_json
    FROM scoped`).bind(...args,definition.top_n).all()).results[0];
  if(data.integrity_errors!==0)throw new AdminError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','排行榜統計暫時無法取得。');
  let resolve=context.tierResolvers.get(data.tier_json);
  if(!resolve){resolve=createTierResolver(JSON.parse(data.tier_json));context.tierResolvers.set(data.tier_json,resolve);}
  const rankings=JSON.parse(data.rankings_json).map(({total_points,...r})=>{
    if(!Number.isSafeInteger(r.points)||!Number.isSafeInteger(r.proof_count))throw new AdminError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','排行榜統計暫時無法取得。');
    const {tier,tier_configuration_ready}=resolve(total_points),{tier_id,name,icon_key}=tier;
    return {...r,tier:{tier_id,name,icon_key},tier_configuration_ready};
  });
  return {...definition,generated_at:data.generated_at??null,rankings};
}
export function leaderboardPayload(boards){
  return {generated_at:boards.reduce((last,b)=>b.generated_at>last?b.generated_at:last,'')||null,leaderboards:boards,
    custom_boards:boards.filter(b=>b.type==='custom').map(({leaderboard_id,name,type,campaign_id,vote_type})=>({leaderboard_id,name,type,campaign_id,vote_type}))};
}
export async function publicLeaderboardData(db,id=null){
  const definitions=await publicBoardDefinitions(db,id);
  // No id is a catalog read: never scan ledger history for navigation.
  return leaderboardPayload(id===null?definitions:await Promise.all(definitions.map(b=>liveBoardRanking(db,b))));
}
