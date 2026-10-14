import { jsonSuccess, jsonError } from "./response.js";
import { readUploadJson, validatePrepare, validateComplete, validUploadedObject, MIME_EXTENSIONS, UPLOAD_LIMITS, UploadError } from "./upload-validation.js";
import { verifyTurnstile } from "./turnstile.js";
import { uploadGrantConfig, issueUploadGrant, readUploadGrant } from '../lib/upload-grant.js';
import { r2VerifiedSha256 } from '../lib/r2-verified-checksum.js';
import { requestOrigin } from '../lib/auth-session.js';
import { AuthError } from './auth-validation.js';
import { rememberCompletedUpload } from "../lib/completed-uploads.js";
import { CaseError } from "./case-validation.js";
import { requireSubmissionsEnabled, SubmissionError } from "../lib/submission-gate.js";
import {prepareFinalUpload,putFinalUpload,sealFinalUpload,finalReference} from '../lib/immutable-uploads.js';

export async function prepareUpload(env, _url, request) {
  try {
    const input = validatePrepare(await readUploadJson(request));
    const {token,files}=input;
    const config = await uploadGrantConfig(env);
    await verifyTurnstile(request, env, token);
    await requireSubmissionsEnabled(env.DB);
    // Stop issuing new V2 intents during an operator-controlled rollback, while
    // keeping V2 complete/create readers available to drain existing uploads.
    if(input.storageVersion===2) {
      if(env.IMMUTABLE_FINAL_UPLOAD_ENABLED==='false')throw new UploadError(503,'SUBMISSIONS_IMMUTABLE_DISABLED','New immutable uploads are paused');
      return jsonSuccess(await prepareFinalUpload(env,request,config,input));
    }
    const sessionId = crypto.randomUUID();
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
    const uploads = await Promise.all(files.map(file => {
      const fileId = crypto.randomUUID();
      const key = `proofs/staging/${date}/${sessionId}/${fileId}.${MIME_EXTENSIONS[file.type]}`;
      return issueUploadGrant(config, `/api/uploads/put/${sessionId}/${fileId}`, key, file);
    }));
    return jsonSuccess({ session_id: sessionId, expires_in: UPLOAD_LIMITS.expiresSeconds, uploads });
  } catch (error) {
    if (error instanceof UploadError || error instanceof CaseError || error instanceof SubmissionError || error instanceof AuthError) return jsonError(error.status, error.code, error.message);
    return jsonError(500, "INTERNAL_ERROR", "Upload request failed");
  }
}

export async function putUpload(env, url, request) {
  try {
    requestOrigin(request, env);
    const grant = await readUploadGrant(env, request, url.pathname);
    if (request.headers.get('Content-Type') !== grant.type || request.headers.get('Content-Length') !== String(grant.size) || !request.body)
      throw new UploadError(400, 'UPLOAD_VALIDATION_FAILED', 'Uploaded size or type does not match authorization');
    await requireSubmissionsEnabled(env.DB);
    if(grant.v===2)return jsonSuccess(await putFinalUpload(env,request,grant));
    // Pass the original native request stream directly to R2. R2 verifies bytes;
    // no arrayBuffer(), tee(), digest(), Blob or per-chunk JS hashing here.
    let object;
    try { object = await env.PROOFS_BUCKET.put(grant.key, request.body, {sha256:grant.sha256,httpMetadata:{contentType:grant.type}}); }
    catch { throw new UploadError(502, 'UPLOAD_CHECKSUM_FAILED', 'Upload integrity verification failed; retry the same upload'); }
    if (!object || object.size!==grant.size || r2VerifiedSha256(object)!==grant.sha256 || !validUploadedObject(grant.key,object))
      throw new UploadError(502, 'UPLOAD_CHECKSUM_FAILED', 'Upload integrity verification failed; retry the same upload');
    return jsonSuccess({uploaded:true});
  } catch (error) {
    if (error instanceof UploadError || error instanceof SubmissionError || error instanceof AuthError) return jsonError(error.status,error.code,error.message);
    return jsonError(502,'R2_UPLOAD_ERROR','Upload storage is unavailable');
  }
}

export async function completeUpload(env, _url, request) {
  try {
    const reference = validateComplete(await readUploadJson(request));
    const {sessionId,keys}=reference;
    if(finalReference(keys)) {
      await requireSubmissionsEnabled(env.DB);
      return jsonSuccess(await sealFinalUpload(env,request,reference));
    }
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
        const sha256 = r2VerifiedSha256(object);
        if (!sha256) { invalid = true; continue; } // No destructive fallback for legacy objects.
        files.push({ key, size: object.size, type, etag: object.etag, sha256 });
      } catch {
        storageError = true;
      }
    }
    if (storageError) throw new UploadError(502, "R2_UPLOAD_ERROR", "Upload storage is unavailable");
    if (invalid) throw new UploadError(400, "UPLOAD_VALIDATION_FAILED", "One or more uploaded files failed validation");
    if (missing) throw new UploadError(400, "UPLOAD_INCOMPLETE", "One or more uploaded files are missing");
    await rememberCompletedUpload(env, sessionId, files);
    return jsonSuccess({ session_id: sessionId, files: files.map(({sha256:_verified,...file})=>file) });
  } catch (error) {
    if (error instanceof UploadError || error instanceof CaseError || error instanceof SubmissionError || error instanceof AuthError) return jsonError(error.status, error.code, error.message);
    return jsonError(500, "INTERNAL_ERROR", "Upload request failed");
  }
}
