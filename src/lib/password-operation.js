import { AuthError, invalidVerification } from "../api/auth-validation.js";
import { authNow, authAtomic, transactionGuard, credentialGuard } from "./auth-store.js";
import { revokeSessions, revokeDevices, consumeTransaction } from "../api/auth.js";
import { adminUpdatePassword } from "./supabase-auth.js";
const pending = () => new AuthError(409, "AUTH_PASSWORD_UPDATE_PENDING", "Password update is pending; retry the verified transaction");
export async function updatePassword(db, env, tx, password, kind) {
  if (!tx.member_id || tx.data.invalid) throw invalidVerification();
  let op = await db.prepare("SELECT * FROM auth_password_operations WHERE transaction_id=? AND member_id=?").bind(tx.id, tx.member_id).first();
  if (!op) {
    const id = crypto.randomUUID(), statements = [
      db.prepare("INSERT INTO auth_password_operations(id,member_id,transaction_id,credential_version,kind,status,lease_until,created_at) VALUES(?,?,?,?,?,'pending',0,?)")
        .bind(id, tx.member_id, tx.id, tx.data.version + 1, kind, authNow()),
      db.prepare("UPDATE member_credentials SET version=version+1,updated_at=? WHERE member_id=?").bind(authNow(), tx.member_id),
      revokeSessions(db, tx.member_id), revokeDevices(db, tx.member_id) ];
    const previous = kind === "recovery" ? await db.prepare("SELECT id FROM auth_password_operations WHERE member_id=? AND status='pending' AND lease_until<=?").bind(tx.member_id, authNow()).first() : null;
    const guards = [transactionGuard(tx), previous
      ? { sql: "EXISTS(SELECT 1 FROM member_credentials c JOIN members m USING(member_id) WHERE c.member_id=? AND c.version=? AND m.status='active') AND EXISTS(SELECT 1 FROM auth_password_operations WHERE id=? AND status='pending' AND lease_until<=?)", args: [tx.member_id, tx.data.version, previous.id, authNow()] }
      : credentialGuard(tx.member_id, tx.data.version)];
    if (previous) statements.unshift(db.prepare("UPDATE auth_password_operations SET status='superseded',lease_owner=NULL WHERE id=?").bind(previous.id));
    if (kind === "change") guards.push({ sql: "EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=? AND member_id=? AND revoked_at IS NULL AND reauthenticated_until>CAST(strftime('%s','now') AS INTEGER))", args: [tx.data.session_hash, tx.member_id] });
    if (kind === "recovery") {
      guards.push({ sql: "EXISTS(SELECT 1 FROM recovery_codes r JOIN member_credentials c USING(member_id) WHERE r.member_id=? AND r.generation=c.recovery_generation AND r.code_hash=? AND r.used_at IS NULL)", args: [tx.member_id, tx.data.code_hash] });
      statements.push(db.prepare("UPDATE recovery_codes SET used_at=? WHERE member_id=? AND code_hash=? AND used_at IS NULL").bind(authNow(), tx.member_id, tx.data.code_hash));
    }
    await authAtomic(db, guards, statements);
    op = await db.prepare("SELECT * FROM auth_password_operations WHERE id=?").bind(id).first();
  }
  if (op.status !== "pending") throw invalidVerification();
  const owner = crypto.randomUUID();
  const claimed = await db.prepare("UPDATE auth_password_operations SET lease_owner=?,lease_until=? WHERE id=? AND status='pending' AND lease_until<? RETURNING id")
    .bind(owner, authNow() + 30, op.id, authNow() + 1).first();
  if (!claimed) throw pending();
  try {
    const identity = await db.prepare("SELECT provider_subject FROM auth_identities WHERE member_id=?").bind(tx.member_id).first();
    if (!identity) throw invalidVerification();
    await adminUpdatePassword(env, identity.provider_subject, password);
    await authAtomic(db, [transactionGuard(tx), { sql: "EXISTS(SELECT 1 FROM auth_password_operations o JOIN member_credentials c USING(member_id) WHERE o.id=? AND o.status='pending' AND o.lease_owner=? AND c.version=o.credential_version)", args: [op.id, owner] }], [
      db.prepare("UPDATE auth_password_operations SET status='complete',completed_at=?,lease_until=0,lease_owner=NULL WHERE id=?").bind(authNow(), op.id),
      consumeTransaction(db, tx), revokeSessions(db, tx.member_id), revokeDevices(db, tx.member_id) ]);
  } catch (error) {
    // Keep the durable auth lock and revocations. Never restore a spent code.
    try { await db.prepare("UPDATE auth_password_operations SET lease_until=0,lease_owner=NULL WHERE id=? AND lease_owner=? AND status='pending'").bind(op.id, owner).run(); } catch { console.warn("Password update reservation requires reconciliation"); }
    throw error;
  }
}
