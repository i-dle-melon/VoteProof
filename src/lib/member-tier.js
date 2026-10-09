import { AdminError, ELEVATED_AUTH_GUARD, actorBindings } from './admin-identity.js';

export const TIER_IDENTITIES = Object.freeze([
  ['normal','普通'],['bronze','青銅'],['silver','白銀'],['gold','黃金'],
  ['platinum','白金'],['emerald','翡翠'],['diamond','鑽石'],['stellar','星耀'],
].map(([tier_id,name],i) => Object.freeze({tier_id,name,icon_key:tier_id,rank_order:i+1})));
export const TIER_LIMITS = Object.freeze({ points:1000000000, reason:500 });
export const tierConflict = () => new AdminError(409,'TIER_CONFIG_CONFLICT','Tier version or threshold ordering changed');
export const tierMissing = () => new AdminError(404,'TIER_NOT_FOUND','Member tier not found');
const publicTier = row => ({tier_id:row.tier_id,name:row.name,icon_key:row.icon_key,rank_order:row.rank_order,min_points:row.min_points});
const safeRow = row => { const {last_mutation_id,...safe} = row; return safe; };
export function tierConfigurationReady(rows) {
  if (!Array.isArray(rows) || rows.length !== TIER_IDENTITIES.length) return false;
  const sorted = [...rows].sort((a,b)=>a.rank_order-b.rank_order);
  return sorted.every((row,i) => {
    const identity = TIER_IDENTITIES[i];
    return Object.keys(identity).every(k=>row[k]===identity[k]) && Number.isSafeInteger(row.min_points) && row.min_points >= 0 && row.min_points <= TIER_LIMITS.points &&
      ['active','disabled'].includes(row.status) && (i === 0 ? row.min_points === 0 && row.status === 'active' : row.min_points > sorted[i-1].min_points);
  });
}
// Pure centralized policy. Rows must come from the same DB snapshot as total.
export function resolveMemberTier(totalPoints, rows) {
  if (!Number.isSafeInteger(totalPoints)) throw new AdminError(503,'POINT_SUMMARY_UNAVAILABLE','Point summary is unavailable');
  if (!tierConfigurationReady(rows)) return {tier:{...TIER_IDENTITIES[0],min_points:0},next_tier:null,
    points_to_next_tier:0,tier_progress:0,tier_configuration_ready:false};
  const active = [...rows].filter(r=>r.status==='active').sort((a,b)=>a.rank_order-b.rank_order), effective = Math.max(0,totalPoints);
  const current = active.filter(r=>r.min_points <= effective).at(-1), next = active.find(r=>r.rank_order > current.rank_order) ?? null;
  const progress = next ? Math.min(100,Math.max(0,Math.round((effective-current.min_points)/(next.min_points-current.min_points)*10000)/100)) : 100;
  // Normal is a tier floor, not a points reset: a negative balance must be earned
  // back before the next threshold. Saturate only the display deficit at MAX_SAFE.
  return {tier:publicTier(current),next_tier:next ? publicTier(next) : null,
    points_to_next_tier:next ? Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,next.min_points-totalPoints)) : 0,
    tier_progress:progress,tier_configuration_ready:true};
}
export async function memberPointTier(db,memberId) {
  // One SELECT snapshot, no duplicated SUM per tier and no cached member tier.
  const rows = (await db.prepare(`WITH total AS (SELECT COALESCE(SUM(points),0) AS total_points FROM point_transactions WHERE member_id = ?)
    SELECT total.total_points,t.tier_id,t.name,t.rank_order,t.min_points,t.icon_key,t.status FROM total LEFT JOIN member_tiers t ON 1=1 ORDER BY t.rank_order`)
    .bind(memberId).all()).results;
  const total = rows[0]?.total_points;
  return {total_points:total,...resolveMemberTier(total,rows.filter(r=>r.tier_id !== null))};
}
export async function listMemberTiers(db) {
  const rows = (await db.prepare('SELECT * FROM member_tiers ORDER BY rank_order').all()).results;
  return {tiers:rows.map(safeRow),configuration_ready:tierConfigurationReady(rows)};
}
export function tierUpdateInput(body) {
  const invalid = () => { throw new AdminError(400,'INVALID_TIER_REQUEST','Invalid member tier update'); };
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k=>!['min_points','status','expected_version','reason'].includes(k)) ||
    !Number.isSafeInteger(body.min_points) || body.min_points < 0 || body.min_points > TIER_LIMITS.points || !['active','disabled'].includes(body.status) ||
    !Number.isSafeInteger(body.expected_version) || body.expected_version < 0 || body.expected_version >= Number.MAX_SAFE_INTEGER ||
    typeof body.reason !== 'string' || !body.reason.trim() || [...body.reason.trim()].length > TIER_LIMITS.reason || /[\u0000-\u001f\u007f]/.test(body.reason)) invalid();
  return {...body,reason:body.reason.trim()};
}
export async function updateMemberTier(db,actor,id,input) {
  if (!TIER_IDENTITIES.some(t=>t.tier_id===id)) throw tierMissing();
  const rows = (await db.prepare('SELECT * FROM member_tiers ORDER BY rank_order').all()).results, row = rows.find(t=>t.tier_id===id);
  if (!row) throw tierMissing();
  if (row.version !== input.expected_version || rows.length !== TIER_IDENTITIES.length || !rows.some(t=>t.tier_id==='normal' && t.min_points===0 && t.status==='active') ||
    id==='normal' && (input.min_points !== 0 || input.status !== 'active') || rows.some(t=>t.tier_id!==id && t.min_points!==null &&
      (t.rank_order < row.rank_order ? t.min_points >= input.min_points : t.min_points <= input.min_points))) throw tierConflict();
  const marker = crypto.randomUUID(), now = new Date().toISOString();
  let result;
  try {
    result = await db.batch([
      db.prepare(`UPDATE member_tiers SET min_points=?,status=?,updated_at=?,updated_by=?,version=version+1,last_mutation_id=?
        WHERE tier_id=? AND version=? AND ${ELEVATED_AUTH_GUARD}
        AND (SELECT COUNT(*) FROM member_tiers)=8 AND EXISTS(SELECT 1 FROM member_tiers WHERE tier_id='normal' AND min_points=0 AND status='active')
        AND NOT EXISTS(SELECT 1 FROM member_tiers t WHERE t.tier_id!=member_tiers.tier_id AND t.min_points IS NOT NULL
          AND ((t.rank_order < member_tiers.rank_order AND t.min_points >= ?) OR (t.rank_order > member_tiers.rank_order AND t.min_points <= ?)))`)
        .bind(input.min_points,input.status,now,actor.member.member_id,marker,id,input.expected_version,...actorBindings(actor),input.min_points,input.min_points),
      db.prepare(`INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json,reason)
        SELECT ?,?,?,?,'member_tier_update','member_tier',tier_id,version,?,json_object('min_points',min_points,'status',status,'version',version),?
        FROM member_tiers WHERE tier_id=? AND last_mutation_id=?`)
        .bind(marker,now,actor.member.member_id,actor.role,JSON.stringify({min_points:row.min_points,status:row.status,version:row.version}),input.reason,id,marker),
      db.prepare('SELECT * FROM member_tiers WHERE tier_id=? AND last_mutation_id=?').bind(id,marker),
    ]);
  } catch {
    const stored = await db.prepare('SELECT * FROM member_tiers WHERE tier_id=? AND last_mutation_id=?').bind(id,marker).first();
    if (stored) return safeRow(stored);
    throw new AdminError(503,'TIER_SERVICE_UNAVAILABLE','Member tier service is unavailable');
  }
  if (result[0].meta.changes!==1) throw tierConflict();
  return safeRow(result[2].results[0]);
}
