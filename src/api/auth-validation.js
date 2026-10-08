import { readUploadJson, UploadError } from "./upload-validation.js";

export const AUTH_LIMITS = Object.freeze({ otpSeconds: 600, otpAttempts: 5, sessionSeconds: 7 * 86400,
  windowSeconds: 900, emailStarts: 3, ipStarts: 20, ipVerifies: 60, globalStarts: 200,
  emailLength: 254, nickname: 50, playerId: 100, emailTimeoutMs: 5000, defaultPage: 20, maxPage: 50 });
export class AuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const invalidAuth = () => { throw new AuthError(400, "INVALID_AUTH_REQUEST", "Invalid authentication request"); };
export const invalidVerification = () => new AuthError(400, "AUTH_VERIFICATION_FAILED", "Verification is invalid or expired");
export const suspended = () => new AuthError(403, "MEMBER_SUSPENDED", "Member access is unavailable");
export function onlyFields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) invalidAuth();
}
export async function readAuthJson(request) {
  try { return await readUploadJson(request); }
  catch (e) {
    if (e instanceof UploadError) throw new AuthError(e.status,
      e.code === "INVALID_JSON" ? "INVALID_JSON" : "INVALID_AUTH_REQUEST", "Invalid authentication body");
    throw e;
  }
}
export function normalizeEmail(value) {
  if (typeof value !== "string") invalidAuth();
  const email = value.trim().toLowerCase();
  // Conservative ASCII mailbox support; never collapse dots or plus aliases.
  if (email.length > AUTH_LIMITS.emailLength || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) ||
      email.split("@")[0].length > 64 || email.startsWith(".") || email.includes("..") || email.includes(".@")) invalidAuth();
  return email;
}
export function profileInput(body) {
  onlyFields(body, ["nickname", "player_id"]);
  if (!Object.keys(body).length) invalidAuth();
  const result = {};
  for (const [field, max] of [["nickname", AUTH_LIMITS.nickname], ["player_id", AUTH_LIMITS.playerId]]) {
    if (!Object.hasOwn(body, field)) continue;
    const value = body[field];
    if (typeof value !== "string" || !value.trim() || [...value.trim()].length > max || /[\u0000-\u001f\u007f]/.test(value)) invalidAuth();
    result[field] = value.trim();
  }
  return result;
}
