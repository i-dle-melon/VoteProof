import { CaseError } from "../api/case-validation.js";
import { sha256 } from "./case-keys.js";

export function caseDatabase(env) {
  if (typeof env.DB?.prepare !== "function" || typeof env.DB?.batch !== "function") {
    throw new CaseError(503, "DB_NOT_CONFIGURED", "Case service is not configured");
  }
  return env.DB;
}

export const manifestHash = files => sha256(JSON.stringify([...files].sort((a, b) => a.key.localeCompare(b.key))
  .map(({ key, size, type, etag }) => ({ key, size, type, etag }))));

export const uploadState = (db, sessionId) => db.prepare(
  "SELECT session_id, manifest_hash, consumed_case_id FROM completed_uploads WHERE session_id = ?"
).bind(sessionId).first();

export async function completedFiles(db, sessionId) {
  return (await db.prepare(
    "SELECT object_key AS key, content_type AS type, size, etag FROM completed_upload_files WHERE session_id = ? ORDER BY object_key"
  ).bind(sessionId).all()).results;
}

export async function rememberCompletedUpload(env, sessionId, files) {
  // Backwards compatible B2 mode without D1. Such uploads cannot create a B3
  // case: complete must be repeated after DB binding + migration are ready.
  if (!env.DB) return;
  const db = caseDatabase(env);
  try {
    if (files.some(file => typeof file.etag !== "string" || !file.etag)) throw new Error();
    const hash = await manifestHash(files);
    await db.batch([
      db.prepare("INSERT INTO completed_uploads (session_id, manifest_hash, completed_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING")
        .bind(sessionId, hash, new Date().toISOString()),
      ...files.map(file => db.prepare(
        `INSERT INTO completed_upload_files (session_id, object_key, content_type, size, etag)
         SELECT ?, ?, ?, ?, ? FROM completed_uploads
         WHERE session_id = ? AND manifest_hash = ? AND consumed_case_id IS NULL
         ON CONFLICT(object_key) DO NOTHING`
      ).bind(sessionId, file.key, file.type, file.size, file.etag, sessionId, hash)),
    ]);
    const state = await uploadState(db, sessionId);
    if (state?.consumed_case_id) throw new CaseError(409, "UPLOAD_ALREADY_USED", "Upload has already been used");
    if (state?.manifest_hash !== hash || await manifestHash(await completedFiles(db, sessionId)) !== hash) {
      throw new CaseError(409, "UPLOAD_SESSION_CONFLICT", "Completed upload cannot be changed");
    }
  } catch (error) {
    if (error instanceof CaseError) throw error;
    throw new CaseError(500, "DATABASE_ERROR", "Case storage is unavailable");
  }
}

export async function requireCompletedUpload(db, sessionId, keys) {
  const state = await uploadState(db, sessionId);
  if (!state) throw new CaseError(400, "UPLOAD_NOT_COMPLETED", "Upload must be completed first");
  if (state.consumed_case_id) throw new CaseError(409, "UPLOAD_ALREADY_USED", "Upload has already been used");
  const files = await completedFiles(db, sessionId);
  if (JSON.stringify(files.map(file => file.key).sort()) !== JSON.stringify([...keys].sort())) {
    throw new CaseError(400, "INVALID_UPLOAD_REFERENCE", "Files do not match the completed upload");
  }
  if (await manifestHash(files) !== state.manifest_hash) throw new CaseError(500, "DATABASE_ERROR", "Case storage is unavailable");
  return { files, hash: state.manifest_hash };
}
