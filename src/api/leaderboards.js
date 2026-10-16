import { jsonError, jsonSuccess } from './response.js';
import { publishedBoards } from '../lib/leaderboard-store.js';
import { CAMPAIGN_ID } from '../lib/campaign-policy.js';
import { soloArtistRankings } from '../lib/solo-targets.js';

export async function getSoloArtistRankings(env) {
  if (!env.DB) return jsonError(503,'DB_NOT_CONFIGURED','Leaderboard storage is not configured');
  try { return jsonSuccess({targets:await soloArtistRankings(env.DB)},'public, max-age=15, must-revalidate'); }
  catch { return jsonError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','Leaderboard service is unavailable'); }
}

export async function getLeaderboards(env, url) {
  if (!env.DB) return jsonError(503,'DB_NOT_CONFIGURED','Leaderboard storage is not configured');
  if (url.searchParams.getAll('id').length > 1) return jsonError(400,'INVALID_LEADERBOARD_QUERY','Invalid leaderboard query');
  const id = url.searchParams.get('id');
  if (id !== null && id.length > 100) return jsonError(400,'INVALID_LEADERBOARD_QUERY','Invalid leaderboard query');
  const soloTarget = url.searchParams.get('solo_target');
  if (url.searchParams.getAll('solo_target').length > 1 || (soloTarget !== null &&
      (id !== 'system-solo' || !CAMPAIGN_ID.test(soloTarget)))) return jsonError(400,'INVALID_LEADERBOARD_QUERY','Invalid leaderboard query');
  try {
    return jsonSuccess(await publishedBoards(env.DB,id,false,soloTarget), 'public, max-age=15, must-revalidate');
  } catch { return jsonError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','Leaderboard service is unavailable'); }
}
