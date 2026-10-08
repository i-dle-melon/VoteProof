import { jsonSuccess, jsonError } from "./response.js";
import { CaseError, readCaseJson, validateCase } from "./case-validation.js";
import { caseDatabase, requireCompletedUpload, uploadState } from "../lib/completed-uploads.js";
import { newCaseId, newQueryKey, sha256, equalQueryHash, CASE_ID_PATTERN, QUERY_KEY_PATTERN } from "../lib/case-keys.js";
import { archiveCaseFiles, cleanPrivateCopies } from "../lib/case-files.js";
import { insertCase, guestCase, guestFiles } from "../lib/case-store.js";
import { requestIdempotency, newQuerySeed, reconstructQueryKey, replayCase } from "../lib/case-idempotency.js";
import { AuthError } from "./auth-validation.js";
import { memberSession, memberCsrf } from "../lib/auth-session.js";
import { requireCaseCampaign } from "../lib/campaign-policy.js";

const errorResponse = error => error instanceof CaseError || error instanceof AuthError
  ? jsonError(error.status, error.code, error.message)
  : jsonError(500, "DATABASE_ERROR", "Case service is unavailable");
const notFound = () => jsonError(404, "CASE_NOT_FOUND", "Case not found");

export async function createCase(env, _url, request) {
  const cleanupKeys = [];
  let db, input, id, identity, committed = false;
  try {
    input = validateCase(await readCaseJson(request));
    const member = await memberSession(request, env, false);
    if (member) {
      await memberCsrf(request, env, member);
      input.memberId = member.member_id;
      input.sessionHash = member.tokenHash;
    }
    identity = await requestIdempotency(request, input, env);
    db = caseDatabase(env);
    const replay = await replayCase(db, identity);
    if (replay) return jsonSuccess(replay, "no-store", 201);
    input.campaignVersion = (await requireCaseCampaign(db, input)).version;
    const completed = await requireCompletedUpload(db, input.sessionId, input.keys);
    id = crypto.randomUUID();
    const now = new Date();
    const caseId = newCaseId(now);
    const seed = identity ? newQuerySeed() : null;
    const queryKey = identity ? await reconstructQueryKey(identity, id, seed) : newQueryKey();
    const queryHash = await sha256(queryKey);
    const files = await archiveCaseFiles(env.PROOFS_BUCKET, id, completed.files, cleanupKeys);
    await insertCase(db, input, { id, caseId, now: new Date().toISOString(), queryHash,
      idempotency: identity ? { keyHash: identity.keyHash, requestHash: identity.requestHash, seed } : null }, files, completed.hash);
    committed = true;
    await cleanPrivateCopies(env.PROOFS_BUCKET, completed.files.map(file => file.key));
    return jsonSuccess({ case_id: caseId, query_key: queryKey, status: "pending" }, "no-store", 201);
  } catch (error) {
    if (!committed && !error?.preserveArchives && cleanupKeys.length) await cleanPrivateCopies(env.PROOFS_BUCKET, cleanupKeys);
    if (error instanceof AuthError) return errorResponse(error);
    // A competing atomic transaction may win after the initial replay lookup.
    // Resolve its persistent response even when it already removed staging data.
    if (db && identity) {
      try {
        const replay = await replayCase(db, identity);
        if (replay) return jsonSuccess(replay, "no-store", 201);
      } catch (replayError) {
        if (replayError instanceof CaseError) return errorResponse(replayError);
      }
    }
    // If another request consumed the session while this one copied R2 data,
    // use the same conflict response even if its staging object is now missing.
    if (db && input && !error?.preserveArchives) {
      try {
        const state = await uploadState(db, input.sessionId);
        if (state?.consumed_case_id && state.consumed_case_id !== id) {
          return errorResponse(new CaseError(409, "UPLOAD_ALREADY_USED", "Upload has already been used"));
        }
      } catch { /* Preserve the original sanitized error. */ }
    }
    return errorResponse(error);
  }
}

export async function getCase(env, url, request) {
  const id = url.pathname.split("/").at(-1);
  const queryKeys = url.searchParams.getAll("key");
  const headerKey = request.headers.get("X-Case-Query-Key");
  const key = headerKey ?? queryKeys[0];
  if (!CASE_ID_PATTERN.test(id) || typeof key !== "string" || !QUERY_KEY_PATTERN.test(key) ||
      queryKeys.length > 1 || (headerKey !== null && queryKeys.length && headerKey !== queryKeys[0])) return notFound();
  try {
    const db = caseDatabase(env);
    const candidateHash = await sha256(key);
    const stored = await guestCase(db, id);
    const matches = equalQueryHash(candidateHash, stored?.query_key_hash ?? "0".repeat(64));
    if (!stored || !matches) return notFound();
    const { id: internalId, query_key_hash: _privateHash, ...publicCase } = stored;
    return jsonSuccess({ ...publicCase, files: await guestFiles(db, internalId) });
  } catch (error) { return errorResponse(error); }
}
