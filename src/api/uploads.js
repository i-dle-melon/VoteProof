import { jsonSuccess, jsonError } from "./response.js";
import { readUploadJson, validatePrepare, validateComplete, validUploadedObject, MIME_EXTENSIONS, UPLOAD_LIMITS, UploadError } from "./upload-validation.js";
import { verifyTurnstile } from "./turnstile.js";
import { readR2UploadConfig, presignPut } from "../lib/r2-presign.js";
import { rememberCompletedUpload } from "../lib/completed-uploads.js";
import { CaseError } from "./case-validation.js";
import { requireSubmissionsEnabled, SubmissionError } from "../lib/submission-gate.js";

export async function prepareUpload(env, _url, request) {
  try {
    const { token, files } = validatePrepare(await readUploadJson(request));
    const config = readR2UploadConfig(env);
    await verifyTurnstile(request, env, token);
    await requireSubmissionsEnabled(env.DB);
    const sessionId = crypto.randomUUID();
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
    const uploads = await Promise.all(files.map(file => {
      const key = `proofs/staging/${date}/${sessionId}/${crypto.randomUUID()}.${MIME_EXTENSIONS[file.type]}`;
      return presignPut(config, key, file.type);
    }));
    return jsonSuccess({ session_id: sessionId, expires_in: UPLOAD_LIMITS.expiresSeconds, uploads });
  } catch (error) {
    if (error instanceof UploadError || error instanceof SubmissionError) return jsonError(error.status, error.code, error.message);
    return jsonError(500, "INTERNAL_ERROR", "Upload request failed");
  }
}

export async function completeUpload(env, _url, request) {
  try {
    const { sessionId, keys } = validateComplete(await readUploadJson(request));
    if (typeof env.PROOFS_BUCKET?.head !== "function" || typeof env.PROOFS_BUCKET?.delete !== "function") {
      throw new UploadError(503, "R2_UPLOAD_NOT_CONFIGURED", "Upload service is not configured");
    }
    await requireSubmissionsEnabled(env.DB);
    const files = [];
    let missing = false;
    let invalid = false;
    let storageError = false;
    // Inspect every requested object so invalid files are removed even in mixed batches.
    for (const key of keys) {
      try {
        const object = await env.PROOFS_BUCKET.head(key);
        if (!object) { missing = true; continue; }
        const type = object.httpMetadata?.contentType;
        if (!validUploadedObject(key, object)) {
          invalid = true;
          await env.PROOFS_BUCKET.delete(key);
          continue;
        }
        files.push({ key, size: object.size, type, etag: object.etag });
      } catch {
        storageError = true;
      }
    }
    if (storageError) throw new UploadError(502, "R2_UPLOAD_ERROR", "Upload storage is unavailable");
    if (invalid) throw new UploadError(400, "UPLOAD_VALIDATION_FAILED", "One or more uploaded files failed validation");
    if (missing) throw new UploadError(400, "UPLOAD_INCOMPLETE", "One or more uploaded files are missing");
    await rememberCompletedUpload(env, sessionId, files);
    return jsonSuccess({ session_id: sessionId, files });
  } catch (error) {
    if (error instanceof UploadError || error instanceof CaseError || error instanceof SubmissionError) return jsonError(error.status, error.code, error.message);
    return jsonError(500, "INTERNAL_ERROR", "Upload request failed");
  }
}
