import { AUTH_LIMITS, AuthError, normalizeEmail } from "../api/auth-validation.js";

export function emailConfig(env) {
  if (typeof env.AUTH_EMAIL_API_KEY !== "string" || !env.AUTH_EMAIL_API_KEY.trim() ||
      typeof env.AUTH_EMAIL_FROM !== "string") throw new AuthError(503, "AUTH_EMAIL_NOT_CONFIGURED", "Email service is not configured");
  try { normalizeEmail(env.AUTH_EMAIL_FROM); }
  catch { throw new AuthError(503, "AUTH_EMAIL_NOT_CONFIGURED", "Email service is not configured"); }
}
export async function sendLoginCode(env, email, code, challengeId) {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.AUTH_EMAIL_API_KEY,
        "Idempotency-Key": "voteproof-auth/" + challengeId },
      body: JSON.stringify({ from: env.AUTH_EMAIL_FROM, to: [email], subject: "VoteProof 登入驗證碼",
        text: `你的 VoteProof 登入驗證碼：${code}\n有效時間為 10 分鐘。如非本人操作，請忽略此信。` }),
      signal: AbortSignal.timeout(AUTH_LIMITS.emailTimeoutMs),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const payload = await response.json();
    if (typeof payload?.id !== "string" || !payload.id) throw new Error();
  } catch { throw new AuthError(502, "AUTH_EMAIL_UNAVAILABLE", "Email service is unavailable; try again later"); }
}
