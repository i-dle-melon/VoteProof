import {proofKeyEpoch} from '../lib/proof-generation.js';
export const UPLOAD_LIMITS = Object.freeze({
  maxFiles: 5,
  maxFileBytes: 5 * 1024 * 1024,
  maxBatchBytes: 25 * 1024 * 1024,
  maxJsonBytes: 16 * 1024,
  maxNameLength: 255,
  maxTokenLength: 2048,
  expiresSeconds: 300,
  turnstileTimeoutMs: 5000,
});
export const MIME_EXTENSIONS = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^proofs\/staging\/(?:g(?:0|[1-9]\d{0,15})\/)?(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(png|jpg|webp)$/;

export class UploadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const invalid = message => { throw new UploadError(400, "INVALID_UPLOAD_REQUEST", message); };
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const allowedMime = type => Object.hasOwn(MIME_EXTENSIONS, type);

export function validUploadedObject(key, object) {
  const type = object?.httpMetadata?.contentType;
  return Number.isSafeInteger(object?.size) && object.size > 0 && object.size <= UPLOAD_LIMITS.maxFileBytes &&
    allowedMime(type) && key.endsWith("." + MIME_EXTENSIONS[type]);
}

export async function readUploadJson(request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new UploadError(400, "INVALID_JSON", "A JSON body is required");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new UploadError(400, "INVALID_JSON", "A JSON body is required");
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > UPLOAD_LIMITS.maxJsonBytes) {
        await reader.cancel();
        throw new UploadError(413, "INVALID_UPLOAD_REQUEST", "Upload metadata is too large");
      }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(400, "INVALID_JSON", "The JSON body is invalid");
  } finally {
    reader.releaseLock();
  }
}

export function validatePrepare(body) {
  if (!isRecord(body)) invalid("Invalid upload request");
  const batchTicket=typeof body.batch_ticket==='string';
  if(batchTicket){
    if(Object.hasOwn(body,'turnstile_token')||body.batch_ticket.length>UPLOAD_LIMITS.maxTokenLength||
      !body.batch_ticket.trim())invalid('Invalid batch verification');
  }else{
    if (typeof body.turnstile_token !== "string" || !body.turnstile_token.trim()) {
      throw new UploadError(400, "TURNSTILE_REQUIRED", "Turnstile verification is required");
    }
    if (body.turnstile_token.length > UPLOAD_LIMITS.maxTokenLength) invalid("Invalid verification token");
  }
  if (!Array.isArray(body.files) || !body.files.length) invalid("At least one file is required");
  if (body.files.length > UPLOAD_LIMITS.maxFiles) {
    throw new UploadError(400, "TOO_MANY_FILES", "At most five files are allowed");
  }
  let total = 0;
  const files = body.files.map(file => {
    if (!isRecord(file) || typeof file.name !== "string" || !file.name.trim() ||
        file.name.length > UPLOAD_LIMITS.maxNameLength || /[\u0000-\u001f\u007f]/.test(file.name)) {
      invalid("Invalid file metadata");
    }
    if (typeof file.type !== "string" || !allowedMime(file.type)) {
      throw new UploadError(400, "UNSUPPORTED_FILE_TYPE", "Only PNG, JPEG and WEBP are allowed");
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) invalid("File size must be a positive integer");
    if (file.size > UPLOAD_LIMITS.maxFileBytes) {
      throw new UploadError(400, "FILE_TOO_LARGE", "A file exceeds the size limit");
    }
    total += file.size;
    if (file.algorithm !== 'sha256' || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256))
      throw new UploadError(400, 'UPLOAD_CHECKSUM_REQUIRED', 'A lowercase SHA-256 checksum is required');
    // An untrusted claim; only successful R2 PUT verification makes it usable.
    return { type: file.type, size: file.size, sha256: file.sha256 };
  });
  if (total > UPLOAD_LIMITS.maxBatchBytes) {
    throw new UploadError(400, "FILE_TOO_LARGE", "The batch exceeds the size limit");
  }
  if(body.storage_version!==undefined && body.storage_version!==2) invalid('Invalid upload storage version');
  if(body.completion_mode!==undefined && body.completion_mode!=='direct') invalid('Invalid completion mode');
  if(body.completion_mode==='direct' && body.storage_version!==2) invalid('Direct completion requires an immutable proof');
  if(body.storage_version===2) {
    if(files.length!==1 || typeof body.campaign_id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(body.campaign_id)) invalid('One proof and a Campaign are required');
    return {...(batchTicket?{batchTicket:body.batch_ticket}:{token:body.turnstile_token.trim()}),
      files,storageVersion:2,campaignId:body.campaign_id,completionMode:body.completion_mode??'legacy'};
  }
  if(batchTicket)invalid('Batch ticket requires an immutable proof');
  return { token: body.turnstile_token.trim(), files };
}

export function validateComplete(body) {
  if (!isRecord(body) || typeof body.session_id !== "string" || body.session_id.length !== 36 || !UUID_PATTERN.test(body.session_id)) {
    invalid("Invalid upload session");
  }
  if (!Array.isArray(body.keys) || !body.keys.length) invalid("At least one object key is required");
  if (body.keys.length > UPLOAD_LIMITS.maxFiles) {
    throw new UploadError(400, "TOO_MANY_FILES", "At most five object keys are allowed");
  }
  const sessionId = body.session_id.toLowerCase();
  if (new Set(body.keys).size !== body.keys.length) invalid("Duplicate object keys are not allowed");
  for (const key of body.keys) {
    if(typeof key==='string'&&/^proofs\/(?:staging|final)\/g/.test(key)&&proofKeyEpoch(key)===null)invalid('Invalid proof generation');
    const final=typeof key==='string' && /^proofs\/final\/(?:g(?:0|[1-9]\d{0,15})\/)?([0-9a-f-]{36})\/([0-9a-f-]{36})\.(png|jpg|webp)$/.exec(key);
    if(final) {
      if(body.keys.length!==1 || final[1]!==sessionId || !UUID_PATTERN.test(final[2]) || Object.keys(body).some(k=>!['session_id','keys','capability'].includes(k))) invalid('Invalid final proof reference');
      continue;
    }
    const match = typeof key === "string" && KEY_PATTERN.exec(key);
    if (!match || match[0] !== key || match[4] !== sessionId || !UUID_PATTERN.test(match[4]) || !UUID_PATTERN.test(match[5])) {
      invalid("Object key does not belong to this upload session");
    }
    const [, year, month, day] = match;
    const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
      invalid("Invalid staging date");
    }
  }
  if(body.capability!==undefined && (typeof body.capability!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.capability)))invalid('Invalid upload capability');
  return { sessionId, keys: body.keys,...(body.capability===undefined?{}:{capability:body.capability}) };
}

export function validateBatchAuthorize(body) {
  if(!isRecord(body)||Object.keys(body).some(k=>!['turnstile_token','campaign_id','completion_mode','files'].includes(k))||
    !Array.isArray(body.files)||body.files.length<2||body.files.length>20)invalid('Invalid batch size');
  let total=0;
  const files=body.files.map(file=>{
    const validated=validatePrepare({turnstile_token:body.turnstile_token,
      storage_version:2,campaign_id:body.campaign_id,completion_mode:body.completion_mode,files:[file]});
    total+=validated.files[0].size;
    return validated.files[0];
  });
  if(!Number.isSafeInteger(total)||total>20*UPLOAD_LIMITS.maxFileBytes)invalid('Batch is too large');
  return {token:body.turnstile_token.trim(),files,campaignId:body.campaign_id,
    completionMode:body.completion_mode??'legacy'};
}
