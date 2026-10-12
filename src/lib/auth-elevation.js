import { AUTH_LIMITS } from "../api/auth-validation.js";
import { authAtomic } from "./auth-store.js";

// Use only after verified TOTP. Evaluate the trusted role inside the same
// transaction as session issuance/elevation; enrollment or login alone is not MFA.
export const MFA_ELEVATION_SQL = `CASE WHEN EXISTS (
  SELECT 1 FROM admin_memberships WHERE member_id=? AND status='active'
  AND role IN ('admin','super_admin')
) THEN ? ELSE ? END`;
export const mfaElevationBindings = (memberId, expiresAt, now) => [
  memberId, expiresAt, Math.min(expiresAt, now + AUTH_LIMITS.elevationSeconds),
];

export async function commitMfaStepUp(db, member, now, guards, statements) {
  const result = await authAtomic(db, guards, [
    ...statements,
    db.prepare(`UPDATE auth_sessions SET elevated_until=${MFA_ELEVATION_SQL},
      reauthenticated_until=? WHERE token_hash=?
      RETURNING elevated_until,reauthenticated_until`)
      .bind(...mfaElevationBindings(member.member_id, member.expires_at, now),
        now + AUTH_LIMITS.securitySeconds, member.tokenHash),
  ]);
  // The final batch statement removes the atomic guard; return the actual write.
  return result.at(-2).results[0];
}
