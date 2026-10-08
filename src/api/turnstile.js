import { UploadError, UPLOAD_LIMITS } from "./upload-validation.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(request, env, token) {
  if (typeof env.TURNSTILE_SECRET_KEY !== "string" || !env.TURNSTILE_SECRET_KEY.trim()) {
    throw new UploadError(503, "TURNSTILE_NOT_CONFIGURED", "Verification service is not configured");
  }
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.set("remoteip", ip);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_LIMITS.turnstileTimeoutMs);
  try {
    const response = await fetch(SITEVERIFY_URL, { method: "POST", body, signal: controller.signal });
    if (!response.ok) throw new Error("Siteverify HTTP error");
    const result = await response.json();
    if (typeof result?.success !== "boolean") throw new Error("Invalid Siteverify response");
    if (!result.success) throw new UploadError(403, "TURNSTILE_INVALID", "Turnstile verification failed");
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(502, "TURNSTILE_UPSTREAM_ERROR", "Verification service is unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
