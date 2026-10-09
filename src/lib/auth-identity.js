import { authKey, authMac } from "./auth-session.js";
import { secretBytes } from "./auth-crypto.js";
import { AuthError } from "../api/auth-validation.js";
const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const bytes = value => Uint8Array.from(value.match(/../g), v => parseInt(v, 16));
export const emailHash = async (env, email) => authMac(await authKey(env), "identity-email", email);
export const codeHash = async (env, id, code) => authMac(await authKey(env), "registration-code", JSON.stringify([id, code]));
export const sourceHash = async (env, request) => authMac(await authKey(env), "registration-source", request.headers.get("CF-Connecting-IP") ?? "unknown");
async function encryptionKey(env) {
  return crypto.subtle.importKey("raw", secretBytes(env, "AUTH_TOTP_ENCRYPTION_KEY"), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptEmail(env, email, context) {
  const version = Number(env.AUTH_TOTP_KEY_VERSION ?? 1), iv = crypto.getRandomValues(new Uint8Array(12));
  if (!Number.isSafeInteger(version) || version < 1) throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Authentication service is not configured");
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`VoteProof/email/${version}/${context}`) }, await encryptionKey(env), encoder.encode(email));
  return { email_ciphertext: hex(new Uint8Array(encrypted)), email_iv: hex(iv), email_key_version: version };
}
export async function decryptEmail(env, row, context) {
  if (row.email_key_version !== Number(env.AUTH_TOTP_KEY_VERSION ?? 1)) throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Authentication service is not configured");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(row.email_iv), additionalData: encoder.encode(`VoteProof/email/${row.email_key_version}/${context}`) }, await encryptionKey(env), bytes(row.email_ciphertext));
  return new TextDecoder().decode(clear);
}
export async function findIdentity(db, env, email) {
  return db.prepare(`SELECT i.*,c.version,c.recovery_generation,c.last_used_time_step,c.totp_ciphertext,c.totp_iv,c.totp_key_version,m.status
    FROM auth_identities i JOIN members m USING(member_id) LEFT JOIN member_credentials c USING(member_id) WHERE i.email_lookup_hash=?`).bind(await emailHash(env, email)).first();
}
export async function verifyMemberPassword(db, env, memberId, password) {
  const row = await db.prepare("SELECT * FROM auth_identities WHERE member_id=?").bind(memberId).first();
  if (!row || !row.password_enabled) return false;
  const { verifyPassword } = await import("./supabase-auth.js");
  const verified = await verifyPassword(env, await decryptEmail(env, row, row.provider_subject), password);
  return verified?.id === row.provider_subject;
}
