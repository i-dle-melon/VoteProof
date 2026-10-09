import { readUploadJson, UploadError } from "./upload-validation.js";

export const AUTH_LIMITS = Object.freeze({
  transactionSeconds: 600,
  transactionAttempts: 5,
  sessionSeconds: 7 * 86400,
  rememberSeconds: 30 * 86400,
  deviceSeconds: 30 * 86400,
  elevationSeconds: 3600,
  securitySeconds: 300,
  windowSeconds: 900,
  accountAttempts: 10,
  ipAttempts: 40,
  registrationStarts: 3,
  passwordMin: 12,
  passwordMax: 128,
  recoveryCount: 10,
  maxDevices: 100,
  nickname: 50,
  playerId: 100,
  defaultPage: 20,
  maxPage: 50,
});
export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const invalidAuth = () => {
  throw new AuthError(
    400,
    "INVALID_AUTH_REQUEST",
    "Invalid authentication request",
  );
};
export const invalidVerification = () =>
  new AuthError(
    400,
    "AUTH_VERIFICATION_FAILED",
    "Verification is invalid or expired",
  );
export const suspended = () =>
  new AuthError(403, "MEMBER_SUSPENDED", "Member access is unavailable");
export function onlyFields(body, allowed) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !allowed.includes(k))
  )
    invalidAuth();
}
export async function readAuthJson(request) {
  try {
    return await readUploadJson(request);
  } catch (e) {
    if (e instanceof UploadError)
      throw new AuthError(
        e.status,
        e.code === "INVALID_JSON" ? "INVALID_JSON" : "INVALID_AUTH_REQUEST",
        "Invalid authentication body",
      );
    throw e;
  }
}
export function normalizeLogin(value) {
  if (typeof value !== "string") invalidAuth();
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9._-]{4,32}$/.test(normalized)) invalidAuth();
  return normalized;
}
export function normalizeEmail(value) {
  if (typeof value !== "string") invalidAuth();
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) || email.split("@")[0].startsWith(".") || email.split("@")[0].endsWith(".") || email.includes("..")) invalidAuth();
  return email;
}
export function passwordInput(value) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    [...value].length < AUTH_LIMITS.passwordMin ||
    [...value].length > AUTH_LIMITS.passwordMax ||
    /[\u0000]/.test(value)
  )
    invalidAuth();
  return value; // Never trim or silently normalize passwords.
}
export function booleanInput(value) {
  if (value !== undefined && typeof value !== "boolean") invalidAuth();
  return value === true;
}
export function transactionId(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw invalidVerification();
  return value;
}
export function profileInput(body) {
  onlyFields(body, ["nickname", "player_id"]);
  if (!Object.keys(body).length) invalidAuth();
  const result = {};
  for (const [field, max] of [
    ["nickname", AUTH_LIMITS.nickname],
    ["player_id", AUTH_LIMITS.playerId],
  ]) {
    if (!Object.hasOwn(body, field)) continue;
    const value = body[field];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      [...value.trim()].length > max ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      invalidAuth();
    result[field] = value.trim();
  }
  return result;
}
