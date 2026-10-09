// Isolated local benchmark module. Never imported by the deployed Worker.
import { passwordRecord, verifyPassword, secretBytes } from "../../src/lib/auth-crypto.js";
import { equalQueryHash } from "../../src/lib/case-keys.js";

const encoder = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (value) => Uint8Array.from(value.match(/../g), (v) => parseInt(v, 16));
let fixture;

async function pbkdfRecord(password, env, salt = crypto.getRandomValues(new Uint8Array(16))) {
  // Match the current production pepper prehash; HMAC is input to the real
  // password KDF, never a standalone password verifier.
  const pepperKey = await crypto.subtle.importKey("raw", secretBytes(env, "AUTH_PASSWORD_PEPPER"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const material = new Uint8Array(await crypto.subtle.sign("HMAC", pepperKey,
    encoder.encode("VoteProof/password/v1:" + password)));
  try {
    const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    const digest = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256",
      salt, iterations: env.LOCAL_ITERATIONS }, key, 256);
    return JSON.stringify({ algorithm: "PBKDF2-HMAC-SHA256", version: 1,
      iterations: env.LOCAL_ITERATIONS, salt: hex(salt), hash: hex(new Uint8Array(digest)) });
  } finally { material.fill(0); }
}

async function record(password, env) {
  return env.LOCAL_ALGORITHM === "scrypt" ? passwordRecord(password, env) : pbkdfRecord(password, env);
}
async function verify(password, env) {
  if (env.LOCAL_ALGORITHM === "scrypt") return verifyPassword(password, fixture, env);
  const parsed = JSON.parse(fixture);
  const candidate = JSON.parse(await pbkdfRecord(password, env, bytes(parsed.salt)));
  return equalQueryHash(candidate.hash, parsed.hash);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/baseline") return Response.json({ ok: true });
    if (path === "/setup") {
      // Independently check native PBKDF2 against Node's reference, outside
      // timed samples. No password, salt, digest or record leaves the Worker.
      if (env.LOCAL_ALGORITHM !== "scrypt") {
        const key = await crypto.subtle.importKey("raw", encoder.encode("public benchmark vector"),
          "PBKDF2", false, ["deriveBits"]);
        const result = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256",
          iterations: env.LOCAL_ITERATIONS, salt: encoder.encode("public benchmark salt") }, key, 256);
        if (hex(new Uint8Array(result)) !== env.LOCAL_REFERENCE) throw new Error("Reference mismatch");
      }
      fixture = await record(env.LOCAL_PASSWORD, env);
      if (!await verify(env.LOCAL_PASSWORD, env) || await verify(env.LOCAL_PASSWORD + "!", env))
        throw new Error("Verification correctness failed");
      return Response.json({ ok: true, correct_password: true, wrong_password_rejected: true,
        native_derive_bits: Function.prototype.toString.call(crypto.subtle.deriveBits).includes("[native code]") });
    }
    if (!fixture) throw new Error("Benchmark not initialized");
    if (path === "/hash") { await record(env.LOCAL_PASSWORD, env); return Response.json({ ok: true }); }
    if (path === "/verify") return Response.json({ ok: await verify(env.LOCAL_PASSWORD, env) });
    return new Response(null, { status: 404 });
  },
};
