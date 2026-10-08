import { CaseError } from "../api/case-validation.js";
import { sha256, equalQueryHash } from "./case-keys.js";

export const IDEMPOTENCY_LIMITS = Object.freeze({ minLength: 16, maxLength: 128 });
const unavailable = () => new CaseError(503, "IDEMPOTENCY_NOT_CONFIGURED", "Case retry service is unavailable");

export async function requestIdempotency(request, input, env) {
  const key = request.headers.get("Idempotency-Key");
  if (key === null) return null; // Existing B3 callers retain one-use behavior.
  if (key.length < IDEMPOTENCY_LIMITS.minLength || key.length > IDEMPOTENCY_LIMITS.maxLength ||
      !/^[A-Za-z0-9._-]+$/.test(key)) {
    throw new CaseError(400, "INVALID_IDEMPOTENCY_KEY", "Invalid Idempotency-Key");
  }
  // Explicit canonical fields: trim/null normalization is performed by validateCase.
  const normalized = { nickname: input.nickname, playerId: input.playerId, campaignId: input.campaignId,
    voteType: input.voteType, voteDate: input.voteDate, note: input.note,
    sessionId: input.sessionId, keys: [...input.keys].sort() };
  // Guest hashes remain byte-compatible with B3. Member retries are scoped to
  // the authenticated identity, independent of its current session or profile.
  if (input.memberId) normalized.memberId = input.memberId;
  const secret = env.CASE_QUERY_KEY_SECRET;
  // A dedicated, randomly generated 256-bit hex Secret; never reuse other keys.
  if (typeof secret !== "string" || !/^[0-9a-fA-F]{64}$/.test(secret)) throw unavailable();
  const signingKey = await crypto.subtle.importKey("raw",
    Uint8Array.from(secret.match(/../g), byte => parseInt(byte, 16)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return { keyHash: await sha256(input.memberId
    ? JSON.stringify(["VoteProof/member-idempotency/v1", input.memberId, key])
    : "VoteProof/case-idempotency/v1:" + key),
    requestHash: await sha256(JSON.stringify(normalized)), signingKey };
}

export function newQuerySeed() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function reconstructQueryKey(identity, id, seed) {
  const message = JSON.stringify(["VoteProof/guest-query/v1", id, seed, identity.keyHash, identity.requestHash]);
  const signed = await crypto.subtle.sign("HMAC", identity.signingKey, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signed))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function replayCase(db, identity) {
  if (!identity) return null;
  const row = await db.prepare(`SELECT i.request_hash, i.query_seed, c.id, c.case_id, c.query_key_hash
    FROM case_idempotency i JOIN cases c ON c.id = i.case_id WHERE i.key_hash = ?`)
    .bind(identity.keyHash).first();
  if (!row) return null;
  if (!equalQueryHash(identity.requestHash, row.request_hash)) {
    throw new CaseError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was used for a different request");
  }
  const queryKey = await reconstructQueryKey(identity, row.id, row.query_seed);
  // Fail closed on secret replacement or corrupt state; never return an unusable credential.
  if (!equalQueryHash(await sha256(queryKey), row.query_key_hash)) throw unavailable();
  return { case_id: row.case_id, query_key: queryKey, status: "pending" };
}
