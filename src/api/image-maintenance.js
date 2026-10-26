import {adminHandler} from './admin-response.js';
import {adminIdentity,adminCsrf,AdminError} from '../lib/admin-identity.js';
import {readReviewJson} from './admin-validation.js';
import {jsonSuccess} from './response.js';
import {imageMaintenanceStatus,changeImageMaintenance} from '../lib/image-maintenance.js';
const handler=adminHandler(async(env,url,request)=>{
 const actor=await adminIdentity(request,env,request.method==='GET'?['admin','super_admin']:['super_admin']);
 if(url.search)throw new AdminError(400,'INVALID_STORAGE_REQUEST','不支援查詢參數。');
 if(request.method==='GET')return jsonSuccess(await imageMaintenanceStatus(env.DB));
 await adminCsrf(request,env,actor);
 return jsonSuccess(await changeImageMaintenance(env,actor,await readReviewJson(request)));
});
export function imageMaintenanceRoute(path,method){
 if(path==='/api/admin/storage/image-maintenance')return{method:method==='POST'?'POST':'GET',handler,allow:'GET, POST'};
}
