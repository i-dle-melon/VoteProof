import { UploadError, UPLOAD_LIMITS } from '../api/upload-validation.js';
import { configuredAuthOrigin } from './auth-session.js';

const denied = (reason='invalid') => Object.assign(new UploadError(403, 'UPLOAD_GRANT_INVALID', 'Upload authorization is invalid or expired'),{uploadGrantReason:reason});
const aad = new TextEncoder().encode('VoteProof/upload-grant/v1');
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');
async function key(env) {
  if (typeof env.UPLOAD_GRANT_SECRET !== 'string' || !/^[0-9a-f]{64}$/.test(env.UPLOAD_GRANT_SECRET) || typeof env.PROOFS_BUCKET?.put !== 'function')
    throw new UploadError(503, 'R2_UPLOAD_NOT_CONFIGURED', 'Upload service is not configured');
  return crypto.subtle.importKey('raw', Uint8Array.from(env.UPLOAD_GRANT_SECRET.match(/../g), v => parseInt(v,16)), 'AES-GCM', false, ['encrypt','decrypt']);
}
export async function uploadGrantConfig(env) { return { key: await key(env), origin: configuredAuthOrigin(env) }; }
export async function issueUploadGrant(config, path, objectKey, file, binding) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new TextEncoder().encode(JSON.stringify({ v:binding?2:1, path, key:objectKey, size:file.size, type:file.type,
    sha256:file.sha256, expires:binding?.expires??Math.floor(Date.now()/1000)+UPLOAD_LIMITS.expiresSeconds,...(binding?{session_id:binding.sessionId,proof_id:binding.proofId,campaign_id:binding.campaignId,member_id:binding.memberId,guest_capability_hash:binding.guestCapabilityHash}: {}) }));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},config.key,body));
  const token = new Uint8Array(iv.length+encrypted.length); token.set(iv); token.set(encrypted,iv.length);
  return { key:objectKey, method:'PUT', upload_url:config.origin+path, headers:{'Content-Type':file.type,'X-Upload-Grant':encode(token)} };
}
export async function readUploadGrant(env, request, path) {
  const token = request.headers.get('X-Upload-Grant');
  if (typeof token !== 'string' || token.length>2048 || !/^[A-Za-z0-9_-]{40,}$/.test(token)) throw denied('format');
  try {
    const bytes = Uint8Array.from(atob(token.replaceAll('-','+').replaceAll('_','/')), x=>x.charCodeAt(0));
    const clear = await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData:aad},await key(env),bytes.subarray(12));
    const grant = JSON.parse(new TextDecoder().decode(clear));
    if(![1,2].includes(grant.v))throw denied('version');
    if(grant.path!==path)throw denied('path');
    if(!Number.isSafeInteger(grant.expires))throw denied();
    if(grant.expires<=Math.floor(Date.now()/1000))throw denied('expired');
    return grant;
  } catch (error) { if (error instanceof UploadError) throw error; throw denied(); }
}
