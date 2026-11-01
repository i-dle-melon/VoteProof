import {adminHandler} from './admin-response.js';
import {adminIdentity,adminCsrf,ELEVATED_ROLES,AdminError} from '../lib/admin-identity.js';
import {jsonSuccess} from './response.js';
import {readReviewJson} from './admin-validation.js';
import {cleanupCandidates,cleanupInput,verifyCleanup,deleteCleanup,cleanupStatus,cleanCleanup} from '../lib/manual-r2-cleanup.js';
const handler=kind=>adminHandler(async(env,url,request)=>{
 const actor=await adminIdentity(request,env,ELEVATED_ROLES);
 if(kind==='list')return jsonSuccess({...await cleanupCandidates(env.DB,url),enabled:env.R2_MANUAL_CLEANUP_ENABLED==='true'});
 const file=url.pathname.split('/')[5];
 if(!/^[a-f0-9-]{36}$/.test(file??'')||url.search)throw new AdminError(400,'INVALID_CLEANUP_REQUEST','Invalid file');
 if(kind==='status')return jsonSuccess(await cleanupStatus(env.DB,file));
 await adminCsrf(request,env,actor);const input=cleanupInput(await readReviewJson(request));
 if(input.file_id!==file)throw new AdminError(400,'INVALID_CLEANUP_REQUEST','File mismatch');
 return jsonSuccess(await(kind==='verify'?verifyCleanup:kind==='clean'?cleanCleanup:deleteCleanup)(env,actor,input));
});
export function manualCleanupRoute(path){
 if(path==='/api/admin/storage/manual')return{method:'GET',handler:handler('list')};
 if(/^\/api\/admin\/storage\/manual\/[a-f0-9-]{36}\/(verify|delete|clean|status)$/.test(path)){
  const kind=path.split('/').at(-1);return{method:kind==='status'?'GET':'POST',handler:handler(kind)};
 }
}
