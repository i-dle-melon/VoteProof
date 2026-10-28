import {StorageCapacityError} from '../lib/storage-capacity.js';
import { jsonSuccess, jsonError } from "./response.js";
import { CaseError, readCaseJson, validateCase } from "./case-validation.js";
import { caseDatabase, uploadState } from "../lib/completed-uploads.js";
import {casePreflight} from '../lib/case-preflight.js';
import { newCaseId, newQueryKey, sha256, equalQueryHash, CASE_ID_PATTERN, QUERY_KEY_PATTERN } from "../lib/case-keys.js";
import { archiveCaseFiles, cleanPrivateCopies } from "../lib/case-files.js";
import { insertCase, guestCase, guestFiles } from "../lib/case-store.js";
import { requestIdempotency, newQuerySeed, reconstructQueryKey, replayCase } from "../lib/case-idempotency.js";
import { AuthError } from "./auth-validation.js";
import { memberSession, memberCsrf, requestOrigin } from "../lib/auth-session.js";
import {uploadCapabilityHash,linkFinalProof,finalReference} from '../lib/immutable-uploads.js';
import { SubmissionError } from "../lib/submission-gate.js";
import { ensureCaseBackups } from "../lib/proof-backup-store.js";
import { directCasePreflight, directProofFile, insertDirectCase } from '../lib/direct-intent-case.js';
import {requireResetSession} from '../lib/prelaunch-reset-fence.js';

const errorResponse = error => error instanceof CaseError || error instanceof AuthError || error instanceof SubmissionError
  ? jsonError(error.status, error.code, error.message)
  : jsonError(500, "DATABASE_ERROR", "Case service is unavailable");
const notFound = () => jsonError(404, "CASE_NOT_FOUND", "Case not found");

export const createDirectCase = (env, url, request) => createCase(env, url, request, { direct: true });

export async function createCase(env, _url, request, { direct = false } = {}) {
  const cleanupKeys = [];
  let db, input, id, identity, committed = false;
  try {
    input = validateCase(await readCaseJson(request));
    await requireResetSession(env,input.sessionId,input.keys);
    if (direct) {
      requestOrigin(request, env);
      if (!finalReference(input.keys)) throw new CaseError(400, 'INVALID_UPLOAD_REFERENCE', 'A final proof is required');
      input.directIntent = true;
      input.guestCapabilityHash = input.capability ? await uploadCapabilityHash(input.capability) : null;
    }
    const member = await memberSession(request, env, false);
    if (member) {
      await memberCsrf(request, env, member);
      input.memberId = member.member_id;
      input.sessionHash = member.tokenHash;
    }
    identity = await requestIdempotency(request, input, env);
    if (direct && !identity) throw new CaseError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key is required');
    db = caseDatabase(env);
    const replay = await replayCase(db, identity);
    if (replay) return jsonSuccess(replay, "no-store", 201);
    if (member) { input.nickname = member.nickname; input.playerId = member.player_id ?? "尚未設定"; } else {input.nickname="匿名投稿";input.playerId="匿名投稿";}
    if(!direct && finalReference(input.keys)) {
      requestOrigin(request,env);
      input.guestCapabilityHash=input.capability?await uploadCapabilityHash(input.capability):null;
    }
    const preflight = await (direct ? directCasePreflight : casePreflight)(db,input);
    // Derive only after hashing/replay: legacy request hashes and lost-ACK
    // retries remain compatible, even if the Campaign later closes.
    input.voteType = preflight.campaign.category;
    input.campaignVersion = preflight.campaign.version;
    const completed = preflight.completed;
    id = crypto.randomUUID();
    const now = new Date();
    const caseId = newCaseId(now);
    const seed = identity ? newQuerySeed() : null;
    const queryKey = identity ? await reconstructQueryKey(identity, id, seed) : newQueryKey();
    const queryHash = await sha256(queryKey);
    const files = direct ? [await directProofFile(env.PROOFS_BUCKET, preflight.intent)] : completed.intent ? await linkFinalProof(env.PROOFS_BUCKET,completed)
      : await archiveCaseFiles(env, id, completed.files, cleanupKeys);
    const record = { id, caseId, now: new Date().toISOString(), queryHash,
      idempotency: identity ? { keyHash: identity.keyHash, requestHash: identity.requestHash, seed } : null };
    if (direct) await insertDirectCase(db, input, record, files[0]);
    else await insertCase(db, input, record, files, completed.hash);
    committed = true;
    await ensureCaseBackups(env, id, files);
    if(!direct && !completed.intent)await cleanPrivateCopies(env.PROOFS_BUCKET, completed.files.map(file => file.key));
    return jsonSuccess({ case_id: caseId, query_key: queryKey, status: "pending" }, "no-store", 201);
  } catch (error) {
    if (!committed && !error?.preserveArchives && cleanupKeys.length) await cleanPrivateCopies(env.PROOFS_BUCKET, cleanupKeys);
    if(error instanceof StorageCapacityError)return jsonError(error.status,error.code,error.message);
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
        const state = direct
          ? await db.prepare('SELECT consumed_case_id FROM proof_upload_intents WHERE session_id=?').bind(input.sessionId).first()
          : await uploadState(db, input.sessionId);
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
