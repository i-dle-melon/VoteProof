import { jsonError, jsonSuccess } from './response.js';
import {publicBoardDefinitions,liveBoardRanking,leaderboardPayload} from '../lib/public-leaderboards.js';
import {cachedPublicRanking} from '../lib/public-ranking-cache.js';

export async function getLeaderboards(env, url) {
  if (!env.DB) return jsonError(503,'DB_NOT_CONFIGURED','Leaderboard storage is not configured');
  if (['id','view'].some(k=>url.searchParams.getAll(k).length>1)) return jsonError(400,'INVALID_LEADERBOARD_QUERY','Invalid leaderboard query');
  const id = url.searchParams.get('id');
  const view=url.searchParams.get('view');
  // Legacy clients may append cache busters. Only opt-in views require the
  // strict parameter contract; unsupported ranking dimensions stay rejected.
  if(view!==null && [...url.searchParams.keys()].some(k=>!['id','view'].includes(k)))
    return jsonError(400,'INVALID_LEADERBOARD_QUERY','Invalid leaderboard query');
  if(view!==null && !['catalog','live'].includes(view) || view==='catalog'&&id!==null || view==='live'&&id===null)
    return jsonError(400,'INVALID_LEADERBOARD_QUERY','Invalid leaderboard query');
  if (id !== null && id.length > 100) return jsonError(400,'INVALID_LEADERBOARD_QUERY','Invalid leaderboard query');
  // Artist metadata is not a public ranking dimension. Reject the removed
  // filter explicitly instead of silently presenting totals as artist scores.
  if (url.searchParams.has('solo_target')) return jsonError(400,'INVALID_LEADERBOARD_QUERY','Invalid leaderboard query');
  try {
    const definitions=await publicBoardDefinitions(env.DB,id);
    if(view==='catalog')return jsonSuccess({...leaderboardPayload(definitions),refreshed_at:new Date().toISOString()},'public, max-age=0, must-revalidate');
    // Read active/public definitions before looking up cached scores. Hiding or
    // changing a board takes effect immediately, independent of score TTL.
    if(!definitions.length)return jsonSuccess(leaderboardPayload([]),'public, max-age=0, must-revalidate');
    // Unversioned clients retain the original full list/detail response shape.
    // Resolve serially so a legacy all-board miss does not fan out D1 queries.
    const scores=[];
    for(const definition of definitions)scores.push(await cachedPublicRanking(env.DB,url,definition,()=>liveBoardRanking(env.DB,definition)));
    const boards=scores.map(({board})=>{
      if(view==='live')return board;
      if(board.system_fixed){const {is_current_comeback,...legacy}=board;return legacy;}
      const {start_date,end_date,top_n,version,...legacy}=board;return legacy;
    });
    const data=leaderboardPayload(boards);
    if(view===null){
      const fixed=boards.filter(b=>b.system_fixed),stored=boards.filter(b=>!b.system_fixed).sort((a,b)=>a.leaderboard_id<b.leaderboard_id?-1:a.leaderboard_id>b.leaderboard_id?1:0);
      data.leaderboards=[...fixed,...stored];
      data.custom_boards=leaderboardPayload(definitions).custom_boards;
    }
    if(view==='live')data.refreshed_at=scores[0].refreshed_at;
    const response=jsonSuccess(data,'public, max-age=0, must-revalidate');
    response.headers.set('X-Leaderboard-Cache',scores.every(s=>s.cache_status==='HIT')?'HIT':scores.some(s=>s.cache_status==='BYPASS')?'BYPASS':'MISS');
    return response;
  } catch { return jsonError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','Leaderboard service is unavailable'); }
}
