import { AuthError, normalizeEmail } from "../api/auth-validation.js";

export const MAIL_RELAY_LIMITS = Object.freeze({ timeoutMs: 10000, redirects: 2, responseBytes: 4096, secretMinBytes: 32, secretMaxBytes: 1024 });
const encoder = new TextEncoder();
const unavailable = (status = 502) => new AuthError(status, "AUTH_EMAIL_UNAVAILABLE", "Verification email service is unavailable");
const notConfigured = () => new AuthError(503, "AUTH_NOT_CONFIGURED", "Authentication service is not configured");
const separatedFrom = ["AUTH_SECRET", "AUTH_TOTP_ENCRYPTION_KEY", "CASE_QUERY_KEY_SECRET", "TURNSTILE_SECRET_KEY",
  "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY",
  "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"];

export function mailConfig(env) {
  try {
    const url = new URL(env.MAIL_RELAY_URL);
    if (url.protocol !== "https:" || url.hostname !== "script.google.com" || url.port || url.username || url.password ||
        url.search || url.hash || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) throw notConfigured();
    const secret = env.MAIL_RELAY_SECRET;
    if (typeof secret !== "string" || !secret.trim() || encoder.encode(secret).length < MAIL_RELAY_LIMITS.secretMinBytes ||
        encoder.encode(secret).length > MAIL_RELAY_LIMITS.secretMaxBytes ||
        separatedFrom.some(name => typeof env[name] === "string" && env[name].toLowerCase() === secret.toLowerCase())) throw notConfigured();
    return { url: url.href, secret };
  } catch { throw notConfigured(); }
}

export function canonicalVerificationMail({ timestamp, send_id, to, code }) {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || typeof send_id !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(send_id) ||
      typeof code !== "string" || !/^\d{6}$/.test(code)) throw unavailable();
  return `v1\n${timestamp}\n${send_id}\nverify_email\n${normalizeEmail(to)}\n${code}`;
}

export async function signedVerificationMail(secret, email, code) {
  const body = { to: normalizeEmail(email), code, purpose: "verify_email", send_id: crypto.randomUUID(), timestamp: Math.floor(Date.now() / 1000) };
  // The relay uses the exact UTF-8 secret, including when it looks like hex.
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(canonicalVerificationMail(body))));
  body.signature = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return body;
}

function responseLocation(location, current) {
  try {
    const url = new URL(location, current);
    if (!location || url.protocol !== "https:" || url.hostname !== "script.googleusercontent.com" || url.port ||
        url.username || url.password || url.hash || url.pathname !== "/macros/echo") throw unavailable();
    return url.href;
  } catch { throw unavailable(); }
}

async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAIL_RELAY_LIMITS.responseBytes) throw unavailable();
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function sendVerificationEmail(env, email, code) {
  const config = mailConfig(env), body = await signedVerificationMail(config.secret, email, code);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), MAIL_RELAY_LIMITS.timeoutMs);
  try {
    let url = config.url, method = "POST", redirects = 0;
    while (true) {
      const response = await fetch(url, { method, redirect: "manual", signal: controller.signal,
        ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        // ContentService returns the response via 302/303 GET. Never replay
        // the sensitive POST on 307/308 or another script endpoint.
        if (![301, 302, 303].includes(response.status) || ++redirects > MAIL_RELAY_LIMITS.redirects) throw unavailable();
        url = responseLocation(response.headers.get("Location"), url);
        method = "GET";
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw unavailable([403, 429, 503].includes(response.status) ? 503 : 502); }
      const result = await responseJson(response);
      if (result && !Array.isArray(result) && result.ok === true && result.error === undefined && result.code === undefined) return;
      const code = result?.error?.code ?? result?.error ?? result?.code;
      throw unavailable(["DAILY_LIMIT_REACHED", "PROVIDER_QUOTA_LOW", "RELAY_NOT_CONFIGURED", "BUSY"].includes(code) ? 503 : 502);
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    // Never attach upstream errors, URLs, request bodies or response details.
    throw unavailable();
  } finally { clearTimeout(timer); }
}
