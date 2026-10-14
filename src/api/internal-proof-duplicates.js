import {jsonSuccess,jsonError} from './response.js';
import {readUploadJson} from './upload-validation.js';
import {UUID_PATTERN} from './admin-validation.js';
import {claimDuplicateJob,processDuplicateJob} from '../lib/proof-duplicate-processor.js';
async function process(env,url,request) {
  if (url.search || request.headers.has('origin')) return jsonError(403,'DUPLICATE_SERVER_ONLY','Server request required');
  if (env.DUPLICATE_PROCESSOR_ENABLED!=='true' || !/^[a-f0-9]{64}$/.test(env.DUPLICATE_PROCESSOR_SECRET??''))
    return jsonError(503,'DUPLICATE_PROCESSOR_DISABLED','Processor unavailable');
  const authorization=request.headers.get('authorization');
  if (!/^Bearer [a-f0-9]{64}$/.test(authorization??'')) return jsonError(401,'DUPLICATE_AUTH_REQUIRED','Authentication required');
  const [a,b]=await Promise.all([env.DUPLICATE_PROCESSOR_SECRET,authorization.slice(7)].map(value=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
  let difference=0;const x=new Uint8Array(a),y=new Uint8Array(b);for(let i=0;i<32;i++)difference|=x[i]^y[i];
  if(difference) return jsonError(401,'DUPLICATE_AUTH_REQUIRED','Authentication required');
  try {
    const input=await readUploadJson(request);
    if(!input||Array.isArray(input)||Object.keys(input).length!==1||!UUID_PATTERN.test(input.request_id??''))
      return jsonError(400,'INVALID_DUPLICATE_REQUEST','Invalid request');
    const job=await claimDuplicateJob(env.DB,input.request_id);
    // A replay after supersession/lease reclaim must never process the new lease.
    if(job && job.lease_token!==input.request_id) return jsonSuccess({state:'lease_conflict',file_id:job.file_id});
    return jsonSuccess(await processDuplicateJob(env.DB,job));
  } catch { return jsonError(503,'DUPLICATE_PROCESSOR_UNAVAILABLE','Processor unavailable'); }
}
export const internalDuplicateRoute = path => path==='/api/internal/proof-duplicates/process' ? {method:'POST',handler:process} : undefined;
