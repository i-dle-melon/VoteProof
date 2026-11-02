// Read only. Mirrors Wrangler's Dashboard-config reads without logging payloads.
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const account='7a1ae5a3d1e51008d0880ac526740717';
const database='9e2b885d-66e2-4e4d-b768-4bded261296a';
export async function metadataPreflight({accountId,token,fetcher=fetch}){
 if(accountId!==account||typeof token!=='string'||!token.trim())throw Error('DEPLOY_ACCOUNT_OR_TOKEN_CONFIGURATION_INVALID');
 const checks=[];
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
 const finish=(ok,reason)=>({ok,worker:'voteproof',reason,checks,requests:checks.length,mutations:0});
 const base='/accounts/'+account+'/workers';
 const service=await read('worker_service',base+'/services/voteproof');
 if(!service)return finish(false,'REMOTE_SERVICE_READ_FAILED');
 const remote=service.data?.default_environment;
 if(!remote||typeof remote.environment!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(remote.environment))
  return finish(false,'REMOTE_ENVIRONMENT_UNKNOWN');
 const environment=encodeURIComponent(remote.environment),prefix=base+'/services/voteproof/environments/'+environment;
 const bindings=await read('bindings',prefix+'/bindings');
 if(!bindings)return finish(false,'REMOTE_BINDINGS_READ_FAILED');
 if(!Array.isArray(bindings.data))return finish(false,'REMOTE_BINDINGS_SHAPE_UNKNOWN');
 const db=bindings.data.filter(b=>b.name==='DB'),r2=bindings.data.filter(b=>b.name==='PROOFS_BUCKET'),assets=bindings.data.filter(b=>b.name==='ASSETS');
 if(db.length!==1||db[0].type!=='d1'||db[0].id!==database||
  r2.length!==1||r2[0].type!=='r2_bucket'||r2[0].bucket_name!=='voteproof-proofs'||
  assets.length!==1||assets[0].type!=='assets')return finish(false,'PRODUCTION_BINDINGS_MISMATCH');
 // This branch is what triggers the opaque Wrangler message after a Dashboard edit.
 // Do not bypass it, substitute credentials, retry, or request broader permissions.
 if(remote.script?.last_deployed_from==='dash'){
  const paths=[
   ['routes',prefix+'/routes?show_zonename=true'],
   ['custom_domains',base+'/domains/records?page=0&per_page=5&service=voteproof&environment='+environment],
   ['subdomain',prefix+'/subdomain'],
   ['environment',prefix],
   ['schedules',base+'/scripts/voteproof/schedules']
  ];
  for(const [label,path]of paths)if(!await read(label,path))return finish(false,'DASHBOARD_METADATA_READ_FAILED');
 }
 else if(!['api','wrangler'].includes(remote.script?.last_deployed_from))
  return finish(false,'REMOTE_DEPLOY_SOURCE_UNKNOWN');
 return finish(true,'METADATA_READABLE_NOT_A_DEPLOYMENT');
}
async function main(){
 const result=await metadataPreflight({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN});
 await mkdir('.wrangler',{recursive:true});
 await writeFile('.wrangler/deploy-metadata-preflight.json',JSON.stringify(result,null,2));
 for(const check of result.checks)console.log('Metadata '+check.endpoint+': HTTP '+check.http_status+' '+check.result+
  (check.error_codes.length?' codes='+check.error_codes.join(','):''));
 if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,
  'Metadata preflight: '+(result.ok?'PASS':'HOLD')+' ('+result.reason+'). Payloads and credentials omitted.\n');
 if(!result.ok)throw Error('DEPLOY_METADATA_HOLD: '+result.reason+'; inspect endpoint/status above. No deployment was started.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(()=>{console.error('Deployment preflight stopped; no automatic retry, permission change or deployment.');process.exitCode=1;});
