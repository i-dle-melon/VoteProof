// Recover cleanup of one explicitly recorded, synthetic-only benchmark bucket.
// Never accepts arbitrary Worker/bucket/DB arguments or Production configuration.
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
const dir=resolve('.wrangler/immutable-final-v1'),state=JSON.parse(await readFile(resolve(dir,'resources.json'),'utf8')),
 config=JSON.parse(await readFile(resolve(dir,'config.json'),'utf8'));
assert.equal(state.kind,'ISOLATED_SYNTHETIC_ONLY');assert.match(state.name,/^voteproof-immutable-[a-f0-9]{12}$/);assert.equal(state.bucket,state.name+'-data');assert.equal(config.name,state.name);assert.equal(config.r2_buckets[0].bucket_name,state.bucket);
const token=JSON.parse(execFileSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'auth','token','--json'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']})).token,base='/accounts/'+config.account_id;
async function api(path,method='GET',body){assert.ok(method==='GET'||path.startsWith(base+'/workers/scripts/'+state.name)||path===base+'/r2/buckets/'+state.bucket);const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+token,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});if(r.status===404)return{missing:true};if(r.status===204)return{};const v=await r.json();if(!r.ok||!v.success)throw Error('ISOLATED_CLEANUP_API_'+r.status);return v.result;}
const remaining=await api(base+'/r2/buckets/'+state.bucket);if(remaining.missing){console.log('Owned bucket already removed');process.exit(0);}
const access=randomBytes(32).toString('hex'),sub=await api(base+'/workers/subdomain'),origin='https://'+state.name+'.'+sub.subdomain+'.workers.dev';
const script=`export default {async fetch(r,e){if(r.method!=='POST'||r.headers.get('X-Isolated-Access')!==e.ACCESS)return new Response(null,{status:404});let n=0;for(;;){let p=await e.BUCKET.list({limit:1000});if(!p.objects.length)break;await e.BUCKET.delete(p.objects.map(o=>o.key));n+=p.objects.length;}return Response.json({deleted:n});}};`;
const form=new FormData();form.set('metadata',new Blob([JSON.stringify({main_module:'worker.mjs',compatibility_date:'2026-10-07',bindings:[{type:'r2_bucket',name:'BUCKET',bucket_name:state.bucket},{type:'secret_text',name:'ACCESS',text:access}]})],{type:'application/json'}));form.set('worker.mjs',new Blob([script],{type:'application/javascript+module'}),'worker.mjs');
await api(base+'/workers/scripts/'+state.name,'PUT',form);await api(base+'/workers/scripts/'+state.name+'/subdomain','POST',{enabled:true,previews_enabled:false});
let result;try{for(let n=0;n<30;n++){try{const r=await fetch(origin+'/cleanup',{method:'POST',headers:{'X-Isolated-Access':access}});if(r.ok){result=await r.json();break;}}catch{}await new Promise(r=>setTimeout(r,2000));}assert.ok(result,'OWNED_CLEANUP_UNAVAILABLE');await api(base+'/r2/buckets/'+state.bucket,'DELETE');}
finally{await api(base+'/workers/scripts/'+state.name,'DELETE');}
await writeFile(resolve(dir,'cleanup-recovery.json'),JSON.stringify({name:state.name,bucket:state.bucket,...result,worker_removed:true,bucket_removed:true,production_operations:0},null,2));console.log('Owned synthetic Worker and bucket removed');
