import { adminHandler } from './admin-response.js';
import { jsonSuccess } from './response.js';
import { readReviewJson } from './admin-validation.js';
import { adminIdentity,adminCsrf,ELEVATED_ROLES } from '../lib/admin-identity.js';
import { authDatabase } from '../lib/auth-session.js';
import { boardInput,rebuildInput } from '../lib/leaderboard-policy.js';
import { getBoard,listBoards,saveBoard,rebuildBoard,publishedBoards } from '../lib/leaderboard-store.js';

const handler = (mutation, action) => adminHandler(async (env,url,request) => {
  const actor = await adminIdentity(request,env,ELEVATED_ROLES);
  if (mutation) await adminCsrf(request,env,actor);
  return action(authDatabase(env),actor,url,request);
});
const id = url => url.pathname.split('/')[4];
const list = handler(false,async (db,_actor,url) => jsonSuccess(await listBoards(db,url)));
const detail = handler(false,async (db,_actor,url) => jsonSuccess(await getBoard(db,id(url))));
const create = handler(true,async (db,actor,_url,request) => jsonSuccess(await saveBoard(db,actor,boardInput(await readReviewJson(request))),'no-store',201));
const update = handler(true,async (db,actor,url,request) => jsonSuccess(await saveBoard(db,actor,boardInput(await readReviewJson(request),true),await getBoard(db,id(url)))));
const rebuild = handler(true,async (db,actor,url,request) => jsonSuccess(await rebuildBoard(db,actor,await getBoard(db,id(url)),rebuildInput(await readReviewJson(request)))));
const results = handler(false,async (db,_actor,url) => { await getBoard(db,id(url)); return jsonSuccess(await publishedBoards(db,id(url),true)); });
export function leaderboardRoute(path,method) {
  if (path === '/api/admin/leaderboards') return method === 'POST' ? { method:'POST',handler:create } : { method:'GET',handler:list,allow:'GET, POST' };
  if (/^\/api\/admin\/leaderboards\/[^/]+$/.test(path)) return { method:'GET',handler:detail };
  for (const [suffix,action,verb] of [['update',update,'POST'],['rebuild',rebuild,'POST'],['results',results,'GET']]) {
    if (new RegExp('^/api/admin/leaderboards/[^/]+/'+suffix+'$').test(path)) return { method:verb,handler:action };
  }
}
