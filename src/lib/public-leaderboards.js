import {systemBoards} from './system-leaderboards.js';
import {rankingCte,INTEGRITY_SQL} from './leaderboard-ranking.js';
import {resolveMemberTier} from './member-tier.js';
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
export async function liveBoardRanking(db,definition){
  const clauses=[],args=[];
  if(definition.campaign_id){clauses.push('t.campaign_id=?');args.push(definition.campaign_id);}
  if(definition.vote_type){clauses.push('t.vote_type=?');args.push(definition.vote_type);}
  if(definition.type==='custom'){clauses.push('t.vote_date BETWEEN ? AND ?');args.push(definition.start_date,definition.end_date);}
  const scope=`SELECT t.*,CASE WHEN t.category IN ('proof_approved','proof_reapproved') THEN 1
    WHEN t.category='proof_revoked' THEN -1 ELSE 0 END proof_delta FROM point_transactions t
    ${clauses.length?'WHERE '+clauses.join(' AND '):''}`;
  const rows=(await db.prepare(`${rankingCte(scope)}
    SELECT r.rank,r.member_id,r.nickname,m.player_id fan_id,r.points,r.proof_count,r.reached_at,meta.generated_at,meta.integrity_errors
    FROM (SELECT MAX(created_at) generated_at,${INTEGRITY_SQL} integrity_errors FROM scoped) meta
    LEFT JOIN ranked r ON r.rank<=? LEFT JOIN members m ON m.member_id=r.member_id ORDER BY r.rank`).bind(...args,definition.top_n).all()).results;
  if(rows.some(r=>r.integrity_errors!==0))throw new AdminError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','排行榜統計暫時無法取得。');
  const rankings=rows.filter(r=>r.rank!==null).map(({generated_at,integrity_errors,...r})=>{
    if(!Number.isSafeInteger(r.points)||!Number.isSafeInteger(r.proof_count))throw new AdminError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','排行榜統計暫時無法取得。');
    return r;
  });
  if(rankings.length){
    const history=definition.leaderboard_id==='system-history';
    const statements=[db.prepare('SELECT tier_id,name,icon_key,rank_order,min_points,status FROM member_tiers ORDER BY rank_order')];
    if(!history)statements.push(db.prepare(`SELECT member_id,SUM(points) total_points FROM point_transactions WHERE member_id IN (${rankings.map(()=>'?').join(',')}) GROUP BY member_id`).bind(...rankings.map(r=>r.member_id)));
    const [config,totals]=await db.batch(statements),balances=new Map((totals?.results??rankings.map(r=>({member_id:r.member_id,total_points:r.points}))).map(r=>[r.member_id,r.total_points]));
    for(const row of rankings){
      const resolved=resolveMemberTier(balances.get(row.member_id)??0,config.results),{tier_id,name,icon_key}=resolved.tier;
      row.tier={tier_id,name,icon_key};row.tier_configuration_ready=resolved.tier_configuration_ready;
    }
  }
  return {...definition,generated_at:rows[0]?.generated_at??null,rankings};
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
