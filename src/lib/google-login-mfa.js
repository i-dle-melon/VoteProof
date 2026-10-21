import { authNow } from './auth-store.js';
export async function googleMfaPolicy(db, memberId) {
  // Never catch a missing migration/query failure and downgrade to disabled.
  const row = await db.prepare('SELECT enabled,generation FROM google_login_mfa WHERE member_id=?').bind(memberId).first();
  return row ? {enabled:row.enabled===1,generation:row.generation,exists:true} : {enabled:false,generation:0,exists:false};
}
export const googleMfaGuard = (memberId, policy) => policy.exists ? {
  sql:'EXISTS(SELECT 1 FROM google_login_mfa WHERE member_id=? AND generation=? AND enabled=?)',
  args:[memberId,policy.generation,Number(policy.enabled)],
} : {sql:'NOT EXISTS(SELECT 1 FROM google_login_mfa WHERE member_id=?)',args:[memberId]};
export const googleMfaEvent = (db, memberId, flowId, action, generation) => db.prepare(
  'INSERT INTO google_login_mfa_events(id,member_id,flow_id,action,generation,created_at) VALUES(?,?,?,?,?,?)'
).bind(crypto.randomUUID(),memberId,flowId,action,generation,authNow());
export const googleMfaAvailable = env => env.GOOGLE_LOGIN_MFA_ENROLLMENT_ENABLED === 'true';
