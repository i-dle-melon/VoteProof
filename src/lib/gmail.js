import { AuthError, normalizeEmail } from "../api/auth-validation.js";
const error = (status = 502, code = "AUTH_EMAIL_UNAVAILABLE") => new AuthError(status, code, "Verification email service is unavailable");
export function gmailConfig(env) {
  if (!["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_SENDER_EMAIL", "GMAIL_SENDER_NAME"].every(name => typeof env[name] === "string" && env[name].trim()) ||
      /[\r\n\u0000-\u001f\u007f]/.test(env.GMAIL_SENDER_NAME)) throw error(503, "AUTH_NOT_CONFIGURED");
  try { normalizeEmail(env.GMAIL_SENDER_EMAIL); } catch { throw error(503, "AUTH_NOT_CONFIGURED"); }
}
function base64(value) {
  return btoa(Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join(""));
}
async function request(url, init) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    if (!response.ok) throw error(response.status === 429 || response.status === 403 ? 503 : 502);
    return await response.json();
  } catch (e) { if (e instanceof AuthError) throw e; throw error(); }
  finally { clearTimeout(timer); }
}
export async function sendVerificationEmail(env, email, code) {
  gmailConfig(env); email = normalizeEmail(email);
  if (!/^\d{6}$/.test(code)) throw error();
  const oauth = await request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: "refresh_token" }) });
  if (typeof oauth.access_token !== "string" || !oauth.access_token || /[\r\n]/.test(oauth.access_token)) throw error();
  const message = `VoteProof 信箱驗證\r\n\r\n你的六位數驗證碼：${code}\r\n\r\n此驗證碼將於 10 分鐘後失效。請勿分享驗證碼。\r\n如果不是你提出的註冊申請，請忽略此郵件。\r\n`;
  const raw = [`From: =?UTF-8?B?${base64(env.GMAIL_SENDER_NAME)}?= <${normalizeEmail(env.GMAIL_SENDER_EMAIL)}>`, `To: ${email}`,
    `Subject: =?UTF-8?B?${base64("VoteProof 信箱驗證")}?=`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64(message).match(/.{1,76}/g).join("\r\n")].join("\r\n");
  const sent = await request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { Authorization: "Bearer " + oauth.access_token, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") }) });
  if (typeof sent.id !== "string" || !sent.id) throw error();
}
