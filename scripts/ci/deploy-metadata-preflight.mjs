// Read only. Match Wrangler 4.156.2's no-route scope; never log payloads.
import {mkdir,writeFile,appendFile,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const account='7a1ae5a3d1e51008d0880ac526740717';
const database='9e2b885d-66e2-4e4d-b768-4bded261296a';
export function assertLocalRoutingScope(local){
 if(!local||local.name!=='voteproof'||Object.hasOwn(local,'route')||
  (Object.hasOwn(local,'routes')&&(!Array.isArray(local.routes)||local.routes.length))||
  (Object.hasOwn(local,'workers_dev')&&local.workers_dev!==true)||
  (Object.hasOwn(local,'preview_urls')&&local.preview_urls!==false)||
  (Object.hasOwn(local,'env')&&(!local.env||typeof local.env!=='object'||Array.isArray(local.env)||Object.keys(local.env).length)))
  throw Error('LOCAL_ROUTING_SCOPE_REQUIRES_REVIEW');
}
export async function metadataPreflight({accountId,token,localConfig,fetcher=fetch}){
 assertLocalRoutingScope(localConfig);
 if(accountId!==account||typeof token!=='string'||!token.trim())throw Error('DEPLOY_ACCOUNT_OR_TOKEN_CONFIGURATION_INVALID');
 const checks=[];
 const routing={
  local_intent:'WORKERS_DEV_ON_PREVIEW_OFF_NO_DECLARED_ROUTES',
  remote_zone_routes:'NOT_REQUESTED_NOT_MODIFIED',remote_custom_domains:'NOT_REQUESTED_NOT_MODIFIED',
  remote_route_inventory_verified:false,remote_workers_dev:'UNKNOWN',
  wrangler_version:'4.156.2',wrangler_routes_read_required:false
 };
 const read=async(label,path)=>{
  let response,data;
  try{
   response=await fetcher('https://api.cloudflare.com/client/v4'+path,{method:'GET',
    headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
   data=await response.json();
  }catch{
   checks.push({endpoint:label,http_status:response?.status??null,error_codes:[],result:'NETWORK_OR_RESPONSE_UNKNOWN'});return null;
  }
  const ok=response.ok&&data?.success===true;
  checks.push({endpoint:label,http_status:response.status,
   error_codes:Array.isArray(data?.errors)?data.errors.map(e=>e.code).filter(Number.isSafeInteger):[],
   result:ok?'PASS':'HOLD'});
  return ok?{data:data.result}:null;
 };
 const finish=(ok,reason)=>({ok,worker:'voteproof',reason,checks,requests:checks.length,mutations:0,routing});
 const base='/accounts/'+account+'/workers';
 const service=await read('worker_service',base+'/services/voteproof');
 if(!service)return finish(false,'REMOTE_SERVICE_READ_FAILED');
 const remote=service.data?.default_environment;
 if(!remote||typeof remote.environment!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(remote.environment))
  return finish(false,'REMOTE_ENVIRONMENT_UNKNOWN');
 if(remote.environment!=='production')return finish(false,'REMOTE_ENVIRONMENT_MISMATCH');
 if(service.data.name!==undefined&&service.data.name!=='voteproof')return finish(false,'REMOTE_WORKER_MISMATCH');
 if(!['dash','api','wrangler'].includes(remote.script?.last_deployed_from))return finish(false,'REMOTE_DEPLOY_SOURCE_UNKNOWN');
 // If metadata exposes routing declarations, conflicts still HOLD. Missing
 // fields are not evidence of a successful remote route inventory.
 for(const data of[service.data,remote]){
  if(Object.hasOwn(data,'route')||
   ['routes','custom_domains'].some(key=>Object.hasOwn(data,key)&&(!Array.isArray(data[key])||data[key].length)))
   return finish(false,'REMOTE_ROUTING_SCOPE_REQUIRES_REVIEW');
 }
 const environment=encodeURIComponent(remote.environment),prefix=base+'/services/voteproof/environments/'+environment;
 const bindings=await read('bindings',prefix+'/bindings');
 if(!bindings)return finish(false,'REMOTE_BINDINGS_READ_FAILED');
 if(!Array.isArray(bindings.data))return finish(false,'REMOTE_BINDINGS_SHAPE_UNKNOWN');
 const db=bindings.data.filter(b=>b.name==='DB'),r2=bindings.data.filter(b=>b.name==='PROOFS_BUCKET'),assets=bindings.data.filter(b=>b.name==='ASSETS');
 if(db.length!==1||db[0].type!=='d1'||db[0].id!==database||
  r2.length!==1||r2[0].type!=='r2_bucket'||r2[0].bucket_name!=='voteproof-proofs'||
  assets.length!==1||assets[0].type!=='assets')return finish(false,'PRODUCTION_BINDINGS_MISMATCH');
 // No local route categories means 4.156.2 neither reads nor modifies them.
 // All other relevant metadata stays mandatory, independent of deploy source.
 const paths=[['subdomain',prefix+'/subdomain'],['environment',prefix],
  ['schedules',base+'/scripts/voteproof/schedules']];
 for(const [label,path]of paths){
  const result=await read(label,path);
  if(!result)return finish(false,'REQUIRED_METADATA_READ_FAILED');
  if(label==='subdomain'){
   if(typeof result.data?.enabled!=='boolean'||typeof result.data?.previews_enabled!=='boolean')
    return finish(false,'REMOTE_SUBDOMAIN_UNKNOWN');
   routing.remote_workers_dev=result.data.enabled?'ON':'OFF';
   if(!result.data.enabled||result.data.previews_enabled)return finish(false,'UNEXPECTED_WORKERS_DEV_SETTING');
  }
  if(label==='environment'&&(!result.data?.script||typeof result.data.script!=='object'||Array.isArray(result.data.script)))
   return finish(false,'REMOTE_ENVIRONMENT_METADATA_UNKNOWN');
  if(label==='schedules'){
   if(!Array.isArray(result.data?.schedules))return finish(false,'REMOTE_SCHEDULES_UNKNOWN');
   if(result.data.schedules.length)return finish(false,'UNEXPECTED_REMOTE_SCHEDULES');
  }
 }
 return finish(true,'REQUIRED_METADATA_READABLE_NO_ROUTING_CHANGES');
}
async function main(){
 const localConfig=JSON.parse(await readFile('wrangler.jsonc','utf8'));
 const result=await metadataPreflight({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,localConfig});
 await mkdir('.wrangler',{recursive:true});
 await writeFile('.wrangler/deploy-metadata-preflight.json',JSON.stringify(result,null,2));
 for(const check of result.checks)console.log('Metadata '+check.endpoint+': HTTP '+check.http_status+' '+check.result+
  (check.error_codes.length?' codes='+check.error_codes.join(','):''));
 if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,
  'Metadata preflight: '+(result.ok?'PASS':'HOLD')+' ('+result.reason+'). Payloads and credentials omitted.\n'+
  'Routes/Custom Domains: not requested and not modified; remote inventory was not queried. Wrangler 4.156.2.\n');
 if(!result.ok)throw Error('DEPLOY_METADATA_HOLD: '+result.reason+'; inspect endpoint/status above. No deployment was started.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(()=>{console.error('Deployment preflight stopped; no automatic retry, permission change or deployment.');process.exitCode=1;});
