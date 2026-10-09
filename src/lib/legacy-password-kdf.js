// Historical B4.x KDF; benchmark/tests only. Never import from runtime auth.
// Mature audited scrypt; Web Crypto for key-separated HMAC/AES-GCM.
import { scrypt } from "@noble/hashes/scrypt.js";
import { AuthError, invalidVerification } from "../api/auth-validation.js";
import { equalQueryHash, sha256 } from "./case-keys.js";
export const PASSWORD_KDF = Object.freeze({
  algorithm: "scrypt",
  N: 32768,
  r: 8,
  p: 3,
  dkLen: 32,
  maxmem: 34 * 1024 * 1024,
});
const encoder = new TextEncoder();
const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (value) =>
  Uint8Array.from(value.match(/../g), (v) => parseInt(v, 16));
const configError = () =>
  new AuthError(
    503,
    "AUTH_NOT_CONFIGURED",
    "Authentication service is not configured",
  );
export function secretBytes(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value))
    throw configError();
  return bytes(value);
}
export function authCryptoConfig(env) {
  for (const name of [
    "AUTH_SECRET",
    "AUTH_PASSWORD_PEPPER",
    "AUTH_TOTP_ENCRYPTION_KEY",
  ])
    secretBytes(env, name);
  if (
    new Set(
      [
        env.AUTH_SECRET,
        env.AUTH_PASSWORD_PEPPER,
        env.AUTH_TOTP_ENCRYPTION_KEY,
      ].map((v) => v.toLowerCase()),
    ).size !== 3
  )
    throw configError();
  for (const other of [
    "CASE_QUERY_KEY_SECRET",
    "TURNSTILE_SECRET_KEY",
    "R2_SECRET_ACCESS_KEY",
  ]) {
    if (
      typeof env[other] === "string" &&
      [
        env.AUTH_SECRET,
        env.AUTH_PASSWORD_PEPPER,
        env.AUTH_TOTP_ENCRYPTION_KEY,
      ].some((v) => v.toLowerCase() === env[other].toLowerCase())
    )
      throw configError();
  }
}
async function passwordMaterial(password, env) {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(env, "AUTH_PASSWORD_PEPPER"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode("VoteProof/password/v1:" + password),
    ),
  );
}
export async function passwordRecord(
  password,
  env,
  salt = hex(crypto.getRandomValues(new Uint8Array(16))),
) {
  const material = await passwordMaterial(password, env);
  try {
    // Synchronous bounded allocation: JS cannot overlap multiple 32 MiB KDFs
    // inside this isolate. No process-local authentication or rate-limit state.
    const digest = scrypt(material, bytes(salt), PASSWORD_KDF);
    return JSON.stringify({
      algorithm: "scrypt",
      version: 1,
      N: PASSWORD_KDF.N,
      r: 8,
      p: 3,
      salt,
      hash: hex(digest),
    });
  } finally {
    material.fill(0);
  }
}
export async function verifyPassword(password, record, env) {
  let parsed;
  try {
    parsed = JSON.parse(record);
  } catch {
    throw configError();
  }
  if (
    parsed.algorithm !== "scrypt" ||
    parsed.version !== 1 ||
    parsed.N !== PASSWORD_KDF.N ||
    parsed.r !== 8 ||
    parsed.p !== 3 ||
    !/^[a-f0-9]{32}$/.test(parsed.salt) ||
    !/^[a-f0-9]{64}$/.test(parsed.hash)
  )
    throw configError();
  const candidate = JSON.parse(
    await passwordRecord(password, env, parsed.salt),
  );
  return equalQueryHash(candidate.hash, parsed.hash);
}
export async function dummyPasswordCheck(password, env) {
  // Same full KDF cost for missing accounts. This salt is public dummy material,
  // not a credential; no comparison can issue a session.
  await passwordRecord(password, env, "00".repeat(16));
  return false;
}
