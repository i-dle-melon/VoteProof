// Provider-neutral boundary: verified identity, CSRF and recent MFA.
// Authentication provider stays behind the session boundary; recent MFA is required.
import { memberSession, memberCsrf, authDatabase } from "./auth-session.js";

export class AdminError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const adminDenied = () => new AdminError(403, "ADMIN_FORBIDDEN", "Administrative access is not allowed");
export const ADMIN_ROLES = Object.freeze(["reviewer", "admin", "super_admin"]);
export const ELEVATED_ROLES = Object.freeze(["admin", "super_admin"]);

export async function adminIdentity(request, env, roles = ADMIN_ROLES) {
  const member = await memberSession(request, env);
  const membership = await authDatabase(env).prepare(`SELECT role FROM admin_memberships
    WHERE member_id = ? AND status = 'active'`).bind(member.member_id).first();
  if (!membership || !roles.includes(membership.role)) throw adminDenied();
  if (member.elevated_until <= Math.floor(Date.now()/1000)) throw new AdminError(403, "ADMIN_STEP_UP_REQUIRED", "Recent multi-factor authentication is required");
  return { member, role: membership.role };
}
export const adminCsrf = (request, env, actor) => memberCsrf(request, env, actor.member);

// Revalidate inside the review transaction, closing revocation/suspension races.
export const REVIEW_AUTH_GUARD = `EXISTS (SELECT 1 FROM admin_memberships a
  JOIN members m ON m.member_id = a.member_id JOIN auth_sessions s ON s.member_id = m.member_id
  WHERE a.member_id = ? AND a.status = 'active' AND a.role = ? AND m.status = 'active'
  AND s.elevated_until > CAST(strftime('%s', 'now') AS INTEGER) AND s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CAST(strftime('%s', 'now') AS INTEGER))`;
export const actorBindings = actor => [actor.member.member_id, actor.role, actor.member.tokenHash];
export const ELEVATED_AUTH_GUARD = REVIEW_AUTH_GUARD.replace("a.role = ?", "a.role = ? AND a.role IN ('admin', 'super_admin')");
