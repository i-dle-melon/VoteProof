import { AuthError } from "../api/auth-validation.js";
import { authNow, authAtomic, rateError } from "./auth-store.js";
export const EMAIL_LIMITS = Object.freeze({ codeSeconds: 600, attempts: 5, cooldown: 60, emailSends: 5, window: 1800, sourceSends: 60, dailyWindow: 86400, soft: 60, hard: 80 });
export function quotaConfig(env) {
  const hard = Number(env.AUTH_EMAIL_HARD_LIMIT ?? EMAIL_LIMITS.hard), soft = Number(env.AUTH_EMAIL_SOFT_LIMIT ?? Math.min(EMAIL_LIMITS.soft, hard));
  if (!Number.isSafeInteger(hard) || hard < 1 || hard > EMAIL_LIMITS.hard || !Number.isSafeInteger(soft) || soft < 1 || soft > Math.min(EMAIL_LIMITS.soft, hard))
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Authentication service is not configured");
  return { hard, soft };
}
export async function emailBudget(db, env) {
  const { hard, soft } = quotaConfig(env), now = authNow();
  const row = await db.prepare("SELECT COUNT(*) n,MIN(created_at) oldest FROM auth_email_sends WHERE created_at>?").bind(now - EMAIL_LIMITS.dailyWindow).first();
  return { available: row.n < hard, warning: row.n >= soft, retryAfter: Math.max(1, (row.oldest ?? now) + EMAIL_LIMITS.dailyWindow - now) };
}
export async function reserveEmail(db, env, { id, challengeId, emailHash, sourceHash, statements = [] }) {
  const { hard } = quotaConfig(env), now = authNow();
  const guard = { sql: `
    (SELECT COUNT(*) FROM auth_email_sends WHERE created_at>?)<? AND
    (SELECT COUNT(*) FROM auth_email_sends WHERE email_lookup_hash=? AND created_at>?)<? AND
    NOT EXISTS(SELECT 1 FROM auth_email_sends WHERE email_lookup_hash=? AND created_at>?) AND
    (SELECT COUNT(*) FROM auth_email_sends WHERE source_hash=? AND created_at>?)<?`,
  args: [now - EMAIL_LIMITS.dailyWindow, hard, emailHash, now - EMAIL_LIMITS.window, EMAIL_LIMITS.emailSends,
    emailHash, now - EMAIL_LIMITS.cooldown, sourceHash, now - EMAIL_LIMITS.window, EMAIL_LIMITS.sourceSends] };
  try {
    await authAtomic(db, [guard], [
      db.prepare("DELETE FROM auth_email_sends WHERE id IN(SELECT id FROM auth_email_sends WHERE created_at<=? LIMIT 100)").bind(now - EMAIL_LIMITS.dailyWindow - EMAIL_LIMITS.codeSeconds),
      db.prepare("DELETE FROM auth_email_challenges WHERE id IN(SELECT id FROM auth_email_challenges WHERE expires_at<=? LIMIT 100)").bind(now - EMAIL_LIMITS.dailyWindow),
      db.prepare("INSERT INTO auth_email_sends(id,challenge_id,email_lookup_hash,source_hash,created_at) VALUES(?,?,?,?,?)").bind(id, challengeId, emailHash, sourceHash, now), ...statements]);
  } catch (e) {
    if (e instanceof AuthError && e.code === "AUTH_VERIFICATION_FAILED") {
      const budget = await emailBudget(db, env);
      if (!budget.available) { const err = new AuthError(429, "AUTH_REGISTRATION_UNAVAILABLE", "Registration is temporarily unavailable"); err.retryAfter = budget.retryAfter; throw err; }
      throw rateError(EMAIL_LIMITS.cooldown);
    }
    throw e;
  }
  if ((await emailBudget(db, env)).warning) console.warn("Registration email safety budget warning");
}
