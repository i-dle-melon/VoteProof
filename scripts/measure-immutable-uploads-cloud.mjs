// Explicit opt-in only. Creates/deletes its OWN synthetic, uniquely named
// Worker/D1/R2 resources. No Production config, credentials or routes are used.
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomBytes,randomUUID,createHash,createHmac} from 'node:crypto';
import {build} from 'esbuild';
import {syntheticProofBytes} from '../test/fixtures/exact-proof-corpus.js';
import assert from 'node:assert/strict';
if(!process.argv.includes('--isolated-synthetic-only'))throw Error('Explicit isolated validation opt-in required');
const repo=process.cwd(),dir=resolve('.wrangler/immutable-final-v1'),sha=x=>createHash('sha256').update(x).digest('hex');await mkdir(dir,{recursive:true});
const phases=process.argv.includes('--after-only')?['after']:['before','after'];
const casesPerGroup=process.argv.includes('--short-matrix')?5:10;
const baseline=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
// Read only account ID from the existing isolated harness config. Do not load
// any private-state file or Production .dev.vars. CLI auth stays in RAM.
const accountArgument=process.argv.find(value=>value.startsWith('--account-id='));
const account=accountArgument?accountArgument.slice('--account-id='.length)
  :JSON.parse(await readFile('.wrangler/fixed-cpu-opt/config.json','utf8')).account_id;
const auth=JSON.parse(execFileSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'auth','token','--json'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']})).token;
assert.ok(typeof auth==='string'&&auth.length>20);assert.match(account,/^[0-9a-f]{32}$/);
const name='voteproof-immutable-'+randomBytes(6).toString('hex'),bucket=name+'-data',base='/accounts/'+account;
const state={kind:'ISOLATED_SYNTHETIC_ONLY',name,bucket,database_id:null,worker_created:false,bucket_created:false,db_created:false,production_bindings:0,paid_plan_added:false};
const report={source_baseline:baseline,started_at:new Date().toISOString(),scope:state,phases,cases_per_group:casesPerGroup,requests:[],traces:[],deployments:[],cleanup:{},readiness:'NO-GO_UNTIL_MEASURED'};
const access=randomBytes(32).toString('hex'),authSecret=randomBytes(32).toString('hex'),querySecret=randomBytes(32).toString('hex'),grantSecret=randomBytes(32).toString('hex'),relaySecret=randomBytes(32).toString('hex');
let origin,observing=false,tailProcess;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,method='GET',body){
 if(method!=='GET')assert.ok(path===base+'/d1/database'||path===base+'/r2/buckets'||path.startsWith(base+'/workers/scripts/'+name)||
   (state.database_id&&path.startsWith(base+'/d1/database/'+state.database_id))||path===base+'/r2/buckets/'+bucket,'ISOLATED_MUTATION_GUARD');
 const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+auth,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
 if(r.status===404)return {missing:true};if(r.status===204)return{};const v=await r.json();if(!r.ok||!v.success)throw Error('ISOLATED_API_'+r.status+'_'+(v.errors??[]).map(e=>e.code).join('_'));return v.result;
}
async function sql(sql,params=[]){assert.ok(state.database_id);const rows=await api(base+'/d1/database/'+state.database_id+'/query','POST',{sql,params});assert.ok(rows.every(r=>r.success));return rows.flatMap(r=>r.results);}
async function save(){await writeFile(resolve(dir,'results.json'),JSON.stringify(report,null,2));await writeFile(resolve(dir,'resources.json'),JSON.stringify(state,null,2));}
async function deploy(phase,round){
 const version=phase+'-'+round+'-'+Date.now();
 const bundle=await build({entryPoints:[resolve('scripts/lib/immutable-cpu-worker.mjs')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',plugins:phase==='before'?[{name:'read-baseline',setup(b){b.onLoad({filter:/[\\/]src[\\/].*\.js$/},a=>({contents:execFileSync('git',['show',baseline+':'+relative(repo,a.path).replaceAll('\\','/')],{encoding:'utf8'}),loader:'js'}));}}]:[]});
 const bindings=[{type:'d1',name:'DB',id:state.database_id},{type:'r2_bucket',name:'PROOFS_BUCKET',bucket_name:bucket},
  ...Object.entries({TEST_ACCESS:access,AUTH_SECRET:authSecret,CASE_QUERY_KEY_SECRET:querySecret,UPLOAD_GRANT_SECRET:grantSecret,DRIVE_BACKUP_RELAY_SECRET:relaySecret}).map(([name,text])=>({type:'secret_text',name,text})),
  ...Object.entries({PROFILE_VERSION:version,AUTH_ORIGIN:origin,R2_BUCKET_NAME:bucket,TURNSTILE_SECRET_KEY:'1x0000000000000000000000000000000AA',GOOGLE_DRIVE_BACKUP_ENABLED:'true',DRIVE_BACKUP_TRANSPORT:'apps_script_pull'}).map(([name,text])=>({type:'plain_text',name,text}))];
 const form=new FormData();form.set('metadata',new Blob([JSON.stringify({main_module:'worker.mjs',compatibility_date:'2026-10-07',bindings,logpush:false})],{type:'application/json'}));form.set('worker.mjs',new Blob([bundle.outputFiles[0].text],{type:'application/javascript+module'}),'worker.mjs');
 await api(base+'/workers/scripts/'+name,'PUT',form);state.worker_created=true;
 await api(base+'/workers/scripts/'+name+'/subdomain','POST',{enabled:true,previews_enabled:false});
 const settings=await api(base+'/workers/scripts/'+name+'/settings');assert.equal(settings.bindings.find(b=>b.name==='DB')?.id,state.database_id);assert.equal(settings.bindings.find(b=>b.name==='PROOFS_BUCKET')?.bucket_name,bucket);
 for(let n=0;n<20;n++){try{const r=await fetch(origin+'/__fixture/ready',{headers:{'X-Isolated-Access':access},signal:AbortSignal.timeout(10000)});if(r.ok&&(await r.json()).version===version)break;if(n===19)throw Error('VERSION_NOT_READY');}catch(e){if(n===19)throw e;}await delay(1500);}
 // A single ready response does not prove global version propagation. Do not
 // send a Case as a warm-up; wait for deployment distribution, then still
 // require the exact version header on every measured operation.
 await delay(30000);
 report.deployments.push({phase,round,version,bundle_sha256:sha(bundle.outputFiles[0].text),bytes:Buffer.byteLength(bundle.outputFiles[0].text)});await save();return version;
}
async function observe(){
 tailProcess=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'tail',name,'--config',resolve(dir,'config.json'),'--format','json'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let depth=0,quoted=false,escaped=false,buffer='';
 tailProcess.stdout.setEncoding('utf8');tailProcess.stdout.on('data',text=>{for(const ch of text){if(!depth){if(ch!=='{')continue;depth=1;buffer='{';continue;}buffer+=ch;if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}else if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&!--depth){try{const v=JSON.parse(buffer),h=v.event?.request?.headers??{},sample=h['x-isolated-sample']??h['X-Isolated-Sample'];if(/^b[0-9]+$/.test(sample??''))report.traces.push({sample,status:v.event?.response?.status??null,cpu_ms:v.cpuTime??null,wall_ms:v.wallTime??null,outcome:v.outcome,exceptions:v.exceptions?.length??0});}catch{}buffer='';}}});tailProcess.stderr.on('data',()=>{});await delay(6000);assert.equal(tailProcess.exitCode,null,'TAIL_OBSERVER_EXITED');observing=true;
}
let seq=0;
async function call(path,{body,actor,method='POST',headers={},group,size=0,phase,round,version,attempt=0}={}){
 const sample='b'+seq++,t=performance.now();const r=await fetch(origin+path,{method,headers:{Origin:origin,'X-Isolated-Access':access,'X-Isolated-Sample':sample,...actor?.headers,...(body&&!ArrayBuffer.isView(body)?{'Content-Type':'application/json'}:{}),...headers},...(body===undefined?{}:{body:ArrayBuffer.isView(body)?body:JSON.stringify(body)}),signal:AbortSignal.timeout(120000)});
 const text=await r.text();let value;try{value=JSON.parse(text);}catch{value={error:{code:'PLATFORM_NON_JSON'}};}
 report.requests.push({sample,phase,round,actor:actor?'member':'guest',group,size,attempt,status:r.status,wall_ms:performance.now()-t,metrics:r.headers.has('X-Isolated-Metrics')?JSON.parse(r.headers.get('X-Isolated-Metrics')):null,error:value.error?.code??null,platform_codes:['1102','1101','1015','1042'].filter(code=>text.includes(code))});
 if(!r.ok){await save();if(attempt<4&&(r.status>=500||r.status===429||(r.status===404&&value.error?.code==='PLATFORM_NON_JSON'))){await delay(2000);return call(path,{body,actor,method,headers,group,size,phase,round,version,attempt:attempt+1});}throw Error('SYNTHETIC_REQUEST_'+r.status+'_'+(value.error?.code??'UNKNOWN'));}
 if(version)assert.equal(r.headers.get('X-Isolated-Version'),version);return value.data??value;
}
try{
 const sub=await api(base+'/workers/subdomain');origin='https://'+name+'.'+sub.subdomain+'.workers.dev';
 assert.ok((await api(base+'/workers/scripts/'+name+'/settings')).missing);
 assert.ok((await api(base+'/r2/buckets/'+bucket)).missing);
 await api(base+'/r2/buckets','POST',{name:bucket});state.bucket_created=true;await save();
 const created=await api(base+'/d1/database','POST',{name:name+'-db'});state.database_id=created.uuid;state.db_created=true;
 assert.notEqual(state.database_id,'9e2b885d-66e2-4e4d-b768-4bded261296a');await save();
 // The configuration contains only this invocation's owned resources, no vars.
 const config={name,account_id:account,compatibility_date:'2026-10-07',d1_databases:[{binding:'DB',database_name:name+'-db',database_id:state.database_id,migrations_dir:resolve('migrations')}],r2_buckets:[{binding:'PROOFS_BUCKET',bucket_name:bucket}]};
 await writeFile(resolve(dir,'config.json'),JSON.stringify(config));
 execFileSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','migrations','apply',name+'-db','--remote','--config',resolve(dir,'config.json')],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
 await sql('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1');
 const stamp=new Date().toISOString(),member='M-'+randomUUID(),token=randomBytes(32).toString('base64url'),hash=sha('VoteProof/member-session/v1:'+token),now=Math.floor(Date.now()/1000);
 await sql("INSERT INTO campaigns(campaign_id,name,category,solo_target,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at) VALUES('ISOLATED','Synthetic only','Solo','synthetic-solo','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','UTC','2000-01-01','2099-12-31',10,NULL,'active',?,?)",[stamp,stamp]);
 await sql("INSERT INTO members(id,member_id,login_name,nickname,player_id,status,created_at,updated_at,last_login_at) VALUES(?,?,?,'Synthetic','synthetic_fan','active',?,?,?)",[randomUUID(),member,randomUUID().replaceAll('-',''),stamp,stamp,stamp]);
 await sql('INSERT INTO auth_sessions(token_hash,member_id,created_at,expires_at) VALUES(?,?,?,?)',[hash,member,now-60,now+7200]);
 const actor={headers:{Cookie:'__Host-vp-session='+token,'X-CSRF-Token':createHmac('sha256',Buffer.from(authSecret,'hex')).update(JSON.stringify(['VoteProof/auth/v1','csrf',hash])).digest('hex')}};
 for(const phase of phases)for(let round=0;round<3;round++){
  const version=await deploy(phase,round);if(!observing)await observe();
  // Alternation gives each identity a deployment-first Case in at least one
  // round. Version-ready/prepare/PUT/complete already run before first Case.
  for(const [actorKind,identity] of (round%2?[['guest',undefined],['member',actor]]:[['member',actor],['guest',undefined]]))for(const size of [13082,5242880]){
   const bytes=syntheticProofBytes(size,100+round),digest=sha(bytes);
   for(let i=0;i<casesPerGroup;i++){
    const meta={phase,round,size,actor:identity,version};
    const p=await call('/api/uploads/prepare',{...meta,group:'prepare',body:{...(phase==='after'?{storage_version:2,campaign_id:'ISOLATED'}:{}),turnstile_token:'XXXX.DUMMY.TOKEN.XXXX',files:[{name:'synthetic.png',type:'image/png',size,algorithm:'sha256',sha256:digest}]}}),u=p.uploads[0];
    await call(new URL(u.upload_url).pathname,{...meta,group:'put',headers:u.headers,body:bytes,method:'PUT'});
    const ref={session_id:p.session_id,keys:[u.key],...(p.capability?{capability:p.capability}:{})};await call('/api/uploads/complete',{...meta,group:'complete',body:ref});
    const body={campaign_id:'ISOLATED',vote_type:'Solo',vote_date:stamp.slice(0,10),upload_session:ref},key=randomUUID(),options={...meta,headers:{'Idempotency-Key':key},body};
    const first=await call('/api/cases',{...options,group:i===0?'first-case-in-group':'warm-case'});
    const replay=await call('/api/cases',{...options,group:'idempotent-retry'});assert.deepEqual(replay,first);
   }
   console.log(JSON.stringify({phase,round,actor:actorKind,size,cases:casesPerGroup,result:'PASS'}));await save();
  }
 }
 await delay(8000);
 report.points=(await sql('SELECT COUNT(*) n FROM point_transactions'))[0].n;assert.equal(report.points,0);
 report.integrity={foreign_key_violations:(await sql('PRAGMA foreign_key_check')).length,quick_check:(await sql('PRAGMA quick_check'))[0].quick_check};
 const stats=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b),n=v.length;return{n,min:v[0]??null,median:n?(v[Math.floor((n-1)/2)]+v[Math.ceil((n-1)/2)])/2:null,max:v.at(-1)??null,p95:n>=20?v[Math.ceil(.95*n)-1]:null,over10:v.filter(x=>x>10).length};};
 report.summary=[];for(const phase of phases)for(const actor of ['member','guest'])for(const size of [13082,5242880])for(const group of ['first-case-in-group','warm-case','idempotent-retry']){const rows=report.requests.filter(r=>r.phase===phase&&r.actor===actor&&r.size===size&&r.group===group);const traces=rows.map(r=>report.traces.find(t=>t.sample===r.sample));report.summary.push({phase,actor,size,group,requests:rows.length,cpu:stats(traces.map(t=>t?.cpu_ms)),missing:traces.filter(t=>!Number.isFinite(t?.cpu_ms)).length,wall:stats(rows.map(r=>r.wall_ms)),metrics:rows[0]?.metrics});}
 report.readiness='NO-GO_PENDING_FIRST_CASE_ANALYSIS';
}catch(error){report.failure={code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'ISOLATED_VALIDATION_FAILED',name:error.name};throw error;}
finally{
 if(observing)await delay(5000);
 tailProcess?.kill();
 if(state.worker_created){for(let n=0;n<12;n++){try{const r=await fetch(origin+'/__fixture/cleanup',{method:'POST',headers:{'X-Isolated-Access':access},signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('cleanup unavailable');report.cleanup.objects=await r.json();break;}catch{if(n===11)report.cleanup.objects_error=true;else await delay(2000);}}try{await api(base+'/workers/scripts/'+name,'DELETE');report.cleanup.worker_removed=true;}catch{report.cleanup.worker_error=true;}}
 if(state.bucket_created)try{await api(base+'/r2/buckets/'+bucket,'DELETE');report.cleanup.bucket_removed=true;}catch{report.cleanup.bucket_error=true;}
 if(state.db_created)try{await api(base+'/d1/database/'+state.database_id,'DELETE');report.cleanup.database_removed=true;}catch{report.cleanup.database_error=true;}
 report.finished_at=new Date().toISOString();await save();console.log(JSON.stringify({report:'.wrangler/immutable-final-v1/results.json',cleanup:report.cleanup}));
}
