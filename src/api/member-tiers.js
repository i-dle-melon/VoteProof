import { adminHandler } from './admin-response.js';
import { readReviewJson } from './admin-validation.js';
import { jsonSuccess } from './response.js';
import { authDatabase } from '../lib/auth-session.js';
import { adminIdentity,adminCsrf,ELEVATED_ROLES } from '../lib/admin-identity.js';
import { listMemberTiers,tierUpdateInput,updateMemberTier } from '../lib/member-tier.js';

const list = adminHandler(async (env,_url,request) => {
  await adminIdentity(request,env,ELEVATED_ROLES); return jsonSuccess(await listMemberTiers(authDatabase(env)));
});
const update = adminHandler(async (env,url,request) => {
  const actor = await adminIdentity(request,env,ELEVATED_ROLES); await adminCsrf(request,env,actor);
  return jsonSuccess(await updateMemberTier(authDatabase(env),actor,url.pathname.split('/')[4],tierUpdateInput(await readReviewJson(request))));
});
export function memberTierRoute(path) {
  if (path === '/api/admin/member-tiers') return {method:'GET',handler:list};
  if (/^\/api\/admin\/member-tiers\/[^/]+\/update$/.test(path)) return {method:'POST',handler:update};
}
