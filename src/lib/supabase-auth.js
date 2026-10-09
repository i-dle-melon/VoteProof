import { AuthError, normalizeEmail, invalidVerification } from "../api/auth-validation.js";
const unavailable = () => new AuthError(502, "AUTH_PROVIDER_UNAVAILABLE", "Authentication provider is unavailable");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function supabaseConfig(env) {
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { /* Fail closed. */ }
  if (!url || url.protocol !== "https:" || url.origin !== env.SUPABASE_URL || url.username || url.password ||
      ![env.SUPABASE_PUBLISHABLE_KEY, env.SUPABASE_SECRET_KEY].every(v => typeof v === "string" && v.length >= 16 && !/[\s\r\n]/.test(v)))
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Authentication service is not configured");
  return url.origin;
}
async function call(env, path, method, body, admin = false) {
  const origin = supabaseConfig(env);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(origin + "/auth/v1" + path, { method, redirect: "manual", signal: controller.signal,
      headers: { apikey: admin ? env.SUPABASE_SECRET_KEY : env.SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json", "User-Agent": "VoteProof-auth/1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // Never propagate provider errors or access/refresh tokens.
    if (!response.ok) {
      if (!admin && [400, 401, 403, 422].includes(response.status)) return null;
      if (admin && method === "POST" && [400, 409, 422].includes(response.status)) throw invalidVerification();
      if (admin && method === "DELETE" && response.status === 404) return {};
      throw unavailable();
    }
    return await response.json();
  } catch (error) { if (error instanceof AuthError) throw error; throw unavailable(); }
  finally { clearTimeout(timer); }
}
function identity(user, email) {
  let normalized;
  try { normalized = normalizeEmail(user?.email); } catch { throw unavailable(); }
  if (!user || !uuid.test(user.id ?? "") || !user.email_confirmed_at || normalized !== email) throw unavailable();
  return { id: user.id.toLowerCase() }; // Tokens/email/provider metadata are discarded here.
}
export async function verifyPassword(env, email, password) {
  const result = await call(env, "/token?grant_type=password", "POST", { email, password });
  return result ? identity(result.user, email) : null;
}
export async function adminCreateVerifiedUser(env, email, password, enrollmentId) {
  const result = await call(env, "/admin/users", "POST", { email, password, email_confirm: true,
    app_metadata: { voteproof_enrollment_id: enrollmentId } }, true);
  return identity(result?.user ?? result, email).id;
}
export async function adminUpdatePassword(env, subject, password) {
  if (!uuid.test(subject)) throw unavailable();
  const result = await call(env, "/admin/users/" + subject, "PUT", { password }, true);
  if ((result?.user ?? result)?.id?.toLowerCase() !== subject.toLowerCase()) throw unavailable();
}
export async function adminDeleteUser(env, subject) {
  if (!uuid.test(subject)) throw unavailable();
  await call(env, "/admin/users/" + subject, "DELETE", { should_soft_delete: false }, true);
}
