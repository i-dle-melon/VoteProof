import { jsonError, jsonSuccess } from './response.js';
import { publishedBoards } from '../lib/leaderboard-store.js';

export async function getLeaderboards(env, url) {
  if (!env.DB) return jsonError(503,'DB_NOT_CONFIGURED','Leaderboard storage is not configured');
  if (url.searchParams.getAll('id').length > 1) return jsonError(400,'INVALID_LEADERBOARD_QUERY','Invalid leaderboard query');
  const id = url.searchParams.get('id');
  if (id !== null && id.length > 100) return jsonError(400,'INVALID_LEADERBOARD_QUERY','Invalid leaderboard query');
  try {
    return jsonSuccess(await publishedBoards(env.DB,id), 'public, max-age=15, must-revalidate');
  } catch { return jsonError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','Leaderboard service is unavailable'); }
}
