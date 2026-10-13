import { CaseError } from "../api/case-validation.js";
import { sha256 } from "./case-keys.js";
import { requireSubmissionsEnabled, SubmissionError } from "./submission-gate.js";

export const COMPLETED_UPLOAD_TTL_SECONDS = 24 * 60 * 60;
const expired = () => new CaseError(409, "UPLOAD_SESSION_EXPIRED", "Completed upload has expired; prepare a new upload");

export function caseDatabase(env) {
  if (typeof env.DB?.prepare !== "function" || typeof env.DB?.batch !== "function") {
    throw new CaseError(503, "DB_NOT_CONFIGURED", "Case service is not configured");
  }
  return env.DB;
}

export const manifestHash = files => sha256(JSON.stringify([...files].sort((a, b) => a.key.localeCompare(b.key))
  .map(({ key, size, type, etag, sha256 }) => ({ key, size, type, etag, ...(sha256?{sha256}:{}) }))));

export const uploadStateStatement = (db, sessionId) => db.prepare(
  "SELECT session_id, manifest_hash, consumed_case_id, expires_at FROM completed_uploads WHERE session_id = ?"
).bind(sessionId);
export const uploadState = (db, sessionId) => uploadStateStatement(db,sessionId).first();
export const completedFilesStatement = (db, sessionId) => db.prepare(
  `SELECT f.object_key AS key, f.content_type AS type, f.size, f.etag, h.sha256 FROM completed_upload_files f
   LEFT JOIN proof_upload_checksums h ON h.object_key=f.object_key WHERE f.session_id = ? ORDER BY f.object_key`
).bind(sessionId);

export async function completedFiles(db, sessionId) {
  return (await completedFilesStatement(db,sessionId).all()).results;
}

export async function rememberCompletedUpload(env, sessionId, files) {
  // Global submission gate requires D1; no no-database upload mode.
  const db = caseDatabase(env);
  try {
    if (files.some(file => typeof file.etag !== "string" || !file.etag)) throw new Error();
    const hash = await manifestHash(files);
    const now = new Date();
    await db.batch([
      db.prepare("INSERT INTO completed_uploads (session_id, manifest_hash, completed_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING")
        .bind(sessionId, hash, now.toISOString(), new Date(now.valueOf() + COMPLETED_UPLOAD_TTL_SECONDS * 1000).toISOString()),
      ...files.map(file => db.prepare(
        `INSERT INTO completed_upload_files (session_id, object_key, content_type, size, etag)
         SELECT ?, ?, ?, ?, ? FROM completed_uploads
         WHERE session_id = ? AND manifest_hash = ? AND consumed_case_id IS NULL
         ON CONFLICT(object_key) DO NOTHING`
      ).bind(sessionId, file.key, file.type, file.size, file.etag, sessionId, hash)),
      ...files.map(file => db.prepare(`INSERT INTO proof_upload_checksums(object_key,sha256,source_etag,source_size)
        SELECT object_key,?,?,? FROM completed_upload_files WHERE object_key=? AND session_id=? AND etag=? AND size=?
        AND EXISTS(SELECT 1 FROM completed_uploads WHERE session_id=? AND manifest_hash=? AND consumed_case_id IS NULL)
        ON CONFLICT(object_key) DO NOTHING`).bind(file.sha256,file.etag,file.size,file.key,sessionId,file.etag,file.size,sessionId,hash)),
    ]);
    const [stateResult,filesResult] = await db.batch([uploadStateStatement(db,sessionId),completedFilesStatement(db,sessionId)]);
    const state = stateResult.results[0];
    if (state?.consumed_case_id) throw new CaseError(409, "UPLOAD_ALREADY_USED", "Upload has already been used");
    if (state?.expires_at <= new Date().toISOString()) throw expired();
    if (state?.manifest_hash !== hash || await manifestHash(filesResult.results) !== hash) {
      throw new CaseError(409, "UPLOAD_SESSION_CONFLICT", "Completed upload cannot be changed");
    }
  } catch (error) {
    if (error instanceof CaseError || error instanceof SubmissionError) throw error;
    await requireSubmissionsEnabled(db);
    throw new CaseError(500, "DATABASE_ERROR", "Case storage is unavailable");
  }
}

export async function requireCompletedUpload(db, sessionId, keys) {
  const state = await uploadState(db, sessionId);
  // Existing standalone callers retain their validation/error order.
  const files = state && !state.consumed_case_id && state.expires_at>new Date().toISOString() ? await completedFiles(db,sessionId) : [];
  return requireCompletedUploadSnapshot(state,files,keys);
}

export async function requireCompletedUploadSnapshot(state,files,keys) {
  if (!state) throw new CaseError(400, "UPLOAD_NOT_COMPLETED", "Upload must be completed first");
  if (state.consumed_case_id) throw new CaseError(409, "UPLOAD_ALREADY_USED", "Upload has already been used");
  if (state.expires_at <= new Date().toISOString()) throw expired();
  if (JSON.stringify(files.map(file => file.key).sort()) !== JSON.stringify([...keys].sort())) {
    throw new CaseError(400, "INVALID_UPLOAD_REFERENCE", "Files do not match the completed upload");
  }
  if (await manifestHash(files) !== state.manifest_hash) throw new CaseError(500, "DATABASE_ERROR", "Case storage is unavailable");
  return { files, hash: state.manifest_hash };
}
