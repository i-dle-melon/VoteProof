// Mature audited scrypt; Web Crypto for key-separated HMAC/AES-GCM.
import { scrypt } from "@noble/hashes/scrypt.js";
import { TOTP, Secret } from "otpauth";
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
function keyVersion(env) {
  const v = Number(env.AUTH_TOTP_KEY_VERSION ?? 1);
  if (!Number.isSafeInteger(v) || v < 1 || v > 1000000) throw configError();
  return v;
}
async function totpKey(env) {
  return crypto.subtle.importKey(
    "raw",
    secretBytes(env, "AUTH_TOTP_ENCRYPTION_KEY"),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encryptTotp(secret, memberId, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    version = keyVersion(env);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(`VoteProof/TOTP/${version}/${memberId}`),
    },
    await totpKey(env),
    encoder.encode(secret),
  );
  return {
    totp_ciphertext: hex(new Uint8Array(ciphertext)),
    totp_iv: hex(iv),
    totp_key_version: version,
  };
}
export async function decryptTotp(record, memberId, env) {
  if (record.totp_key_version !== keyVersion(env)) throw configError();
  const clear = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes(record.totp_iv),
      additionalData: encoder.encode(
        `VoteProof/TOTP/${record.totp_key_version}/${memberId}`,
      ),
    },
    await totpKey(env),
    bytes(record.totp_ciphertext),
  );
  return new TextDecoder().decode(clear);
}
export function newTotp(loginName) {
  const secret = new Secret({ size: 20 }),
    otp = new TOTP({
      issuer: "VoteProof",
      label: loginName,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });
  return { secret: secret.base32, otpauth_uri: otp.toString() };
}
export async function totpStep(
  record,
  memberId,
  code,
  env,
  timestamp = Date.now(),
) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code))
    throw invalidVerification();
  const otp = new TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(await decryptTotp(record, memberId, env)),
  });
  const delta = otp.validate({ token: code, window: 1, timestamp }),
    step = Math.floor(timestamp / 30000) + (delta ?? 0);
  if (delta === null || step < 0 || step <= (record.last_used_time_step ?? -1))
    throw invalidVerification();
  return step;
}
export const deviceHash = (token) =>
  sha256("VoteProof/trusted-device/v1:" + token);
export const recoveryHash = (member, code) =>
  sha256("VoteProof/recovery/v1:" + member + ":" + code);
