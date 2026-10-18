// One-off authorized isolated Free-plan E2E/CPU validation. No Production config.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {fixtures,fixtureSQL,fixtureSchema,image,digest,quote} from './lib/archive-isolated-fixtures.mjs';
import {scenarios,runScenario} from './lib/archive-acceptance.mjs';
if(!process.argv.includes('--isolated-synthetic-only'))throw Error('ISOLATED_OPT_IN_REQUIRED');
const account=process.argv.find(x=>x.startsWith('--account-id='))?.slice(13);assert.match(account??'',/^[a-f0-9]{32}$/);
const inventoryOnly=process.argv.includes('--inventory-only');
const samples=Number(process.argv.find(x=>x.startsWith('--samples='))?.slice(10)??40);assert.ok(Number.isInteger(samples)&&samples>=1&&samples<=100);
const cliEnv={...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false'};
const token=JSON.parse(execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','auth','token','--json'],{env:cliEnv,windowsHide:true,stdio:['ignore','pipe','pipe']})).token;
const base='/accounts/'+account,name='voteproof-archive-e2e-'+randomBytes(6).toString('hex'),relay=name+'-relay',bucket=name+'-data';
const dir=resolve('docs/evidence/storage-archive-7d',name),tmp=resolve('.wrangler/archive-validation',name);await mkdir(dir,{recursive:true});await mkdir(tmp,{recursive:true});
const access=randomBytes(32).toString('hex'),relayAccess=randomBytes(32).toString('hex'),secret=randomBytes(32).toString('hex');
const state={name,relay,bucket,database:null,workers:[],bucket_created:false,db_created:false};
const report={inventory_only:inventoryOnly,seed_attempt_errors:[],baseline:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),started_at:new Date().toISOString(),state,samples,
  source_sha256:Object.fromEntries(['src/lib/storage-archive.js','migrations/0025_storage_cold_v1.sql','scripts/lib/archive-isolated-worker.mjs'].map(p=>[p,null])),
  api:[],deployments:[],requests:[],traces:[],e2e:[],cleanup:{},collector:{starts:0,parse_errors:0,stderr_chunks:0,error_signals:0,sampling_text_matches:0,sampling_rates:[],connection_lost_signals:0,reconnect_signals:0,exits:[]},
  methodology:{path:'authenticateRelay + cleanupArchive + verifyDriveArchive + real isolated D1/R2 HEAD/DELETE',
    relay:'Independent Free Worker verifies request HMAC; signs an independently precomputed synthetic SHA receipt. No image bytes returned to reader; no real Drive calls.',
    images:'High-entropy valid synthetic PNGs, native R2 PUT SHA-256 verified; decimal capacity simulated in isolated D1.',
    cpu:'Cloudflare tail cpuTime in milliseconds; missing UNKNOWN, not zero. Harness budget UPDATE and trace log overhead included.',
    cpu_profile:'Raw DB/R2 bindings without Proxy instrumentation. SDK operation counts are measured in a separate instrumented phase.',
    memory:'Not measured; no heap or memory peak claim',production_mutations:0,google_api_calls:0,paid_features_enabled:0}};
for(const p of Object.keys(report.source_sha256))report.source_sha256[p]=digest(await readFile(p));
const images=Object.fromEntries([1,3,5].map(n=>[n,image(n*1048576)]));
const cpuSpecs=[];for(let i=0;i<samples;i++)for(const n of (i%2?[5,3,1]:[1,3,5]))cpuSpecs.push(['cpu-'+n+'-'+i,n]);
const opSpecs=[1,3,5].flatMap(n=>Array.from({length:3},(_,i)=>['ops-'+n+'-'+i,n]));
const pool=fixtures(inventoryOnly?[['inventory-delete',5],['inventory-retain',1]]:[...scenarios.map(([n])=>[n,1]),...opSpecs,...cpuSpecs]);
let origin,mockOrigin,collector,phase='setup',label=null,sequence=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms)),save=()=>writeFile(resolve(dir,'results.json'),JSON.stringify(report,null,2));
async function api(path,method='GET',body){
  if(method!=='GET')assert.ok(path===base+'/d1/database'||path===base+'/r2/buckets'||
    [name,relay].some(n=>path===base+'/workers/scripts/'+n||path.startsWith(base+'/workers/scripts/'+n+'/'))||
    (state.database&&path.startsWith(base+'/d1/database/'+state.database+'/'))||path===base+'/d1/database/'+state.database||path===base+'/r2/buckets/'+bucket,'ISOLATED_MUTATION_GUARD');
  const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+token,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},
    ...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
  const record={path:path.replace(account,':account'),method,status:r.status};report.api.push(record);
  if(r.status===404)return {missing:true};if(r.status===204)return {};
  const v=await r.json();if(!r.ok||!v.success){record.errors=v.errors?.map(x=>({code:x.code,message:String(x.message).slice(0,250)}));throw Error('ISOLATED_API_'+r.status+'_'+v.errors?.map(x=>x.code).join('_'));}return v.result;
}
async function sql(sql,params=[]){const r=await api(base+'/d1/database/'+state.database+'/query','POST',{sql,params});assert.ok(r.every(x=>x.success));return r.flatMap(x=>x.results);}
async function deploy(worker,role){
  const bundle=await build({entryPoints:[resolve('scripts/lib/archive-isolated-worker.mjs')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  const version=report.source_sha256['src/lib/storage-archive.js'].slice(0,12)+'-'+role;
  const bindings=[{type:'d1',name:'DB',id:state.database},...(role==='reader'?[{type:'r2_bucket',name:'PROOFS_BUCKET',bucket_name:bucket}]:[]),
    ...Object.entries({TEST_ACCESS:role==='reader'?access:relayAccess,RELAY_ACCESS:relayAccess,DRIVE_BACKUP_RELAY_SECRET:secret}).map(([name,text])=>({type:'secret_text',name,text})),
    ...Object.entries({TEST_ROLE:role,TEST_ORIGIN:role==='reader'?origin:mockOrigin,MOCK_ORIGIN:mockOrigin,TEST_EXPIRES:String(Date.now()+3600000),TEST_VERSION:version,
      GOOGLE_DRIVE_BACKUP_ENABLED:'true',R2_EXCLUSIVE_WRITER_CONFIRMED:'true',STORAGE_CLEANUP_LIVE_ENABLED:'true',DRIVE_COLD_RELAY_URL:'https://script.google.com/macros/s/isolated_archive/exec'}).map(([name,text])=>({type:'plain_text',name,text}))];
  const data=new FormData();data.set('metadata',new Blob([JSON.stringify({main_module:'worker.mjs',compatibility_date:'2026-10-07',compatibility_flags:['global_fetch_strictly_public'],usage_model:'standard',bindings,logpush:false})],{type:'application/json'}));
  data.set('worker.mjs',new Blob([bundle.outputFiles[0].text],{type:'application/javascript+module'}),'worker.mjs');
  await api(base+'/workers/scripts/'+worker,'PUT',data);state.workers.push(worker);await save();
  await api(base+'/workers/scripts/'+worker+'/subdomain','POST',{enabled:true,previews_enabled:false});
  const settings=await api(base+'/workers/scripts/'+worker+'/settings');
  assert.equal(settings.bindings.find(x=>x.name==='DB')?.id,state.database);
  if(role==='reader')assert.equal(settings.bindings.find(x=>x.name==='PROOFS_BUCKET')?.bucket_name,bucket);
  report.deployments.push({worker,role,version,bundle_sha256:digest(bundle.outputFiles[0].text),bindings:settings.bindings.filter(x=>['d1','r2_bucket'].includes(x.type)),usage_model:settings.usage_model});
  const url=role==='reader'?origin:mockOrigin,key=role==='reader'?access:relayAccess;
  for(let i=0;i<30;i++){try{const r=await fetch(url+'/ready',{headers:{'X-Isolated-Access':key},signal:AbortSignal.timeout(5000)});if(r.ok&&(await r.json()).version===version)return;}catch{}await delay(1200);}throw Error('ISOLATED_DEPLOY_NOT_READY');
}
async function observe(){
  const config=resolve(tmp,'tail.json');await writeFile(config,JSON.stringify({name,account_id:account,compatibility_date:'2026-10-07'}));
  collector=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','tail',name,'--config',config,'--format','json'],{env:cliEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});report.collector.starts++;
  let depth=0,quoted=false,escaped=false,buffer='';
  collector.stdout.setEncoding('utf8');collector.stdout.on('data',s=>{if(/sampling|truncated/i.test(s))report.collector.sampling_text_matches++;for(const ch of s){if(!depth){if(ch!=='{')continue;depth=1;buffer='{';continue;}buffer+=ch;
    if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}else if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&!--depth){try{
      const v=JSON.parse(buffer);if(Number.isFinite(v.samplingRate)&&!report.collector.sampling_rates.includes(v.samplingRate))report.collector.sampling_rates.push(v.samplingRate);const headers=v.event?.request?.headers??{},sample=headers['x-isolated-sample']??headers['X-Isolated-Sample'];
      if(/^archive-[0-9]+$/.test(sample??''))report.traces.push({sample,event_timestamp:v.eventTimestamp,script_name:v.scriptName,cpu_ms:Number.isFinite(v.cpuTime)?v.cpuTime:null,
        wall_ms:Number.isFinite(v.wallTime)?v.wallTime:null,outcome:v.outcome,status:v.event?.response?.status??null,exception_count:v.exceptions?.length??0,
        logs:v.logs?.flatMap(x=>x.message??[]).filter(x=>typeof x==='string'&&x.startsWith('{"sample":')).map(x=>JSON.parse(x))??[]});
    }catch{report.collector.parse_errors++;}buffer='';}}});
  collector.stderr.on('data',s=>{report.collector.stderr_chunks++;const diagnostic=String(s);if(/error|disconnect|reconnect/i.test(diagnostic))report.collector.error_signals++;if(/connection lost|disconnected/i.test(diagnostic))report.collector.connection_lost_signals++;if(/reconnecting|reconnected|reconnect attempt/i.test(diagnostic))report.collector.reconnect_signals++;});
  collector.on('exit',(code,signal)=>report.collector.exits.push({code,signal}));await delay(6000);assert.equal(collector.exitCode,null,'COLLECTOR_EXITED');
}
async function request(path,{method='POST',body,mode='normal',expected=200,measure=false}={}){
  const sample=measure?'archive-'+sequence++:undefined,start=performance.now();let record={sample,phase,label,mode,path,expected_status:expected};
  try{
    const r=await fetch(origin+path,{method,headers:{'X-Isolated-Access':access,Authorization:'Bearer '+secret,'X-Test-Mode':mode,'X-Test-Profile':phase==='cpu'?'pure':'instrumented',...(sample?{'X-Isolated-Sample':sample}:{})},...(body?{body}:{}),signal:AbortSignal.timeout(60000)});
    const text=await r.text();let value;try{value=JSON.parse(text);}catch{}
    Object.assign(record,{status:r.status,client_wall_ms:performance.now()-start,platform_codes:!value&&r.status>=500?['1101','1102','1027'].filter(x=>new RegExp(String.raw`\b${x}\b`).test(text)):[],value});
    if(measure)report.requests.push(record);
    if(phase==='cpu'&&path==='/archive'&&r.status!==expected)return {result:{state:'http_failure'},counters:null};
    assert.equal(r.status,expected,'ISOLATED_HTTP_'+r.status+'_'+JSON.stringify(value??{}));return value;
  }catch(e){if(measure&&!report.requests.includes(record))report.requests.push({...record,client_error:e.name,client_wall_ms:performance.now()-start});throw e;}
}
const adapter={sql,
  seed:async f=>{for(let attempt=1;;attempt++){try{const v=await request('/seed/'+f.label,{method:'PUT',body:images[f.mib]});assert.equal(v.sha256,digest(images[f.mib]));return;}
    catch(e){if(e.name!=='TypeError'||attempt>=3)throw e;report.seed_attempt_errors.push({label:f.label,attempt,name:e.name,code:e.cause?.code??'UNKNOWN'});await save();await delay(attempt*1000);}}},
  call:(mode,expected=200)=>request('/archive',{mode,expected,measure:true}),
  putProbe:()=>request('/capacity-put'),
  snapshot:async f=>request('/snapshot/'+f.label,{method:'GET'}),
};
function stats(v){v=v.filter(Number.isFinite).sort((a,b)=>a-b);return {n:v.length,p50:v.length?v[Math.ceil(v.length*.5)-1]:null,p95:v.length?v[Math.ceil(v.length*.95)-1]:null,p99:v.length?v[Math.ceil(v.length*.99)-1]:null,max:v.at(-1)??null,over10:v.filter(x=>x>10).length};}
function summarize(){
  report.cpu=[];for(const mib of [1,3,5]){
    const rows=report.requests.filter(x=>x.phase==='cpu'&&x.label?.startsWith('cpu-'+mib+'-')),traces=rows.map(x=>report.traces.find(t=>t.sample===x.sample));
    report.cpu.push({mib,requests:rows.length,success:rows.filter(x=>x.value?.result.state==='cold').length,
      cpu_ms:stats(traces.map(x=>x?.cpu_ms)),missing_cpu:traces.filter(x=>!Number.isFinite(x?.cpu_ms)).length,wall_ms:stats(rows.map(x=>x.client_wall_ms)),
      exceeded_cpu:traces.filter(x=>x?.outcome==='exceededCpu').length,exceeded_memory:traces.filter(x=>x?.outcome==='exceededMemory').length,
      http1102:rows.filter(x=>x.platform_codes?.includes('1102')).length,
      operations:{source:'Separate instrumented operations phase, not per-request pure CPU counters',samples:report.requests.filter(x=>x.phase==='operations'&&x.label?.startsWith('ops-'+mib+'-')).map(x=>x.value?.counters??null)}});
  }
  report.cpu_readiness=report.cpu.some(x=>x.cpu_ms.over10||x.exceeded_cpu||x.http1102)?'FAIL':report.cpu.every(x=>x.requests>=40&&x.success===x.requests&&x.missing_cpu<=x.requests*.1)?'PASS':'UNKNOWN';
}
try{
  report.free_settings=await api(base+'/workers/settings');assert.equal(report.free_settings.free_tier,true,'FREE_PLAN_REQUIRED');
  const sub=await api(base+'/workers/subdomain');origin='https://'+name+'.'+sub.subdomain+'.workers.dev';mockOrigin='https://'+relay+'.'+sub.subdomain+'.workers.dev';
  for(const n of [name,relay])assert.ok((await api(base+'/workers/scripts/'+n+'/settings')).missing);
  assert.ok((await api(base+'/r2/buckets/'+bucket)).missing);
  await api(base+'/r2/buckets','POST',{name:bucket});state.bucket_created=true;await save();
  const database=await api(base+'/d1/database','POST',{name:name+'-db'});state.database=database.uuid;state.db_created=true;assert.notEqual(state.database,'9e2b885d-66e2-4e4d-b768-4bded261296a');await save();
  const config=resolve(tmp,'migration.json');await writeFile(config,JSON.stringify({name,account_id:account,compatibility_date:'2026-10-07',d1_databases:[{binding:'DB',database_name:name+'-db',database_id:state.database,migrations_dir:resolve('migrations')}]}));
  execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply',name+'-db','--remote','--config',config],{env:cliEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await sql(fixtureSchema);
  const at=new Date().toISOString();
  await sql("INSERT INTO campaigns(campaign_id,name,category,solo_target,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at) VALUES('ISOLATED','Synthetic','Solo','synthetic','2000-01-01','2100-01-01','UTC','2000-01-01','2099-12-31',0,NULL,'active',?,?)",[at,at]);
  await sql("INSERT INTO members(id,member_id,login_name,nickname,player_id,status,created_at,updated_at,last_login_at) VALUES(?,'SYNTHETIC-ADMIN',?,'Synthetic','synthetic_archive_admin','active',?,?,?)",[randomUUID(),randomUUID().replaceAll('-',''),at,at,at]);
  await sql("INSERT INTO drive_backup_folders VALUES('synthetic_root','campaign:synthetic','synthetic_campaign','synthetic_root','Synthetic',?)",[Math.floor(Date.now()/1000)]);
  const triggers=await sql("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN('submissions_cases_insert','submissions_uploads_insert','submissions_upload_files_insert') ORDER BY name");assert.equal(triggers.length,3);
  for(const t of triggers)await sql('DROP TRIGGER '+t.name);
  for(let i=0;i<pool.length;i+=5)await sql(pool.slice(i,i+5).map(f=>fixtureSQL(f,digest(images[f.mib]))).join('\n'));
  for(const t of triggers)await sql(t.sql);
  assert.deepEqual(await sql("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN('submissions_cases_insert','submissions_uploads_insert','submissions_upload_files_insert') ORDER BY name"),triggers);
  report.offline_fixture_import={gate_off:(await sql('SELECT submissions_enabled FROM submission_settings'))[0].submissions_enabled===0,gate_triggers_restored:true,fk_errors:(await sql('PRAGMA foreign_key_check')).length};
  await deploy(relay,'relay');await deploy(name,'reader');await observe();console.log(JSON.stringify({stage:'deployed',name,free:true}));
  if(!inventoryOnly){
  phase='e2e';for(const [n,run] of scenarios){label=n;const result=await runScenario(adapter,pool.find(f=>f.label===n),n,run);report.e2e.push(result);await save();console.log(JSON.stringify({stage:'e2e',...result}));}
  phase='operations';for(const [n,mib] of opSpecs){label=n;const f=pool.find(f=>f.label===n);await adapter.seed(f);const r=await adapter.call('normal');
    assert.equal(r.result.state,'cold');assert.equal(r.result.size,mib*1048576);assert.equal(r.counters.r2.get,0);assert.equal(r.counters.r2.delete,1);}
  phase='cpu';let i=0;for(const [n,mib] of cpuSpecs){label=n;const f=pool.find(f=>f.label===n);await adapter.seed(f);const r=await adapter.call('normal');
    if(r.result.state==='cold'){assert.equal(r.result.size,mib*1048576);assert.equal(r.file_id,f.file);assert.equal(r.counters.instrumented,false);}
    else {const snap=await adapter.snapshot(f);if(snap.archive?.state==='deleting')await sql('UPDATE cold_proofs SET lease_until=? WHERE file_id=?',[Math.floor(Date.now()/1000)+86400,f.file]);
      else await sql('UPDATE cases SET status_updated_at=? WHERE id=?',[new Date(Date.now()+86400000).toISOString(),f.id]);}
    if(++i%15===0){await save();console.log(JSON.stringify({stage:'cpu',completed:i,total:cpuSpecs.length,traces:report.traces.length}));}await delay(250);}
  }else{
    phase='inventory-setup';label='inventory-delete';await adapter.seed(pool[0]);const archived=await adapter.call('normal');assert.equal(archived.result.state,'cold');
    assert.equal((await adapter.snapshot(pool[0])).exists,false);label='inventory-retain';await adapter.seed(pool[1]);
    await sql('UPDATE cases SET status_updated_at=? WHERE id=?',[new Date(Date.now()+86400000).toISOString(),pool[1].id]);
  }
  phase='inventory';label=null;const before=(await sql('SELECT count(*) n FROM proof_backups'))[0].n;
  await sql('UPDATE storage_capacity SET used_bytes=9500000000,blocked=1,reserved_bytes=0,observed_at=?,trusted_until=0 WHERE id=1',[Math.floor(Date.now()/1000)]);
  report.inventory=await request('/inventory');report.final_capacity=(await sql('SELECT * FROM storage_capacity'))[0];
  const snapshot=await request('/bucket-summary',{method:'GET'});assert.equal(report.final_capacity.used_bytes,snapshot.bytes);assert.equal(report.final_capacity.cleanup_requested,0);
  assert.equal(report.final_capacity.blocked,0);assert.equal((await sql('SELECT count(*) n FROM proof_backups'))[0].n,before);
  report.integrity={quick_check:(await sql('PRAGMA quick_check'))[0].quick_check,fk_errors:(await sql('PRAGMA foreign_key_check')).length,
    submissions:(await sql('SELECT submissions_enabled FROM submission_settings'))[0].submissions_enabled,backups:before,budget:await sql('SELECT * FROM isolated_budget')};
  await delay(10000);summarize();await save();
}catch(e){report.failure={name:e.name,message:String(e.message).slice(0,300)};process.exitCode=1;console.error(JSON.stringify({stage:'failed',...report.failure}));}
finally{
  if(collector)await delay(6000);collector?.kill();
  if(state.workers.includes(name))try{report.cleanup.objects=await request('/cleanup');}catch{report.cleanup.objects='FAILED';}
  for(const worker of [...state.workers].reverse())try{await api(base+'/workers/scripts/'+worker,'DELETE');report.cleanup[worker]='removed';}catch{report.cleanup[worker]='FAILED';}
  if(state.bucket_created)try{await api(base+'/r2/buckets/'+bucket,'DELETE');report.cleanup.bucket='removed';}catch{report.cleanup.bucket='FAILED';}
  if(state.db_created)try{await api(base+'/d1/database/'+state.database,'DELETE');report.cleanup.database='removed';}catch{report.cleanup.database='FAILED';}
  report.cleanup_verification=[];for(const path of [...state.workers.map(n=>base+'/workers/scripts/'+n+'/settings'),...(state.bucket_created?[base+'/r2/buckets/'+bucket]:[]),...(state.db_created?[base+'/d1/database/'+state.database]:[])]){
    try{report.cleanup_verification.push({path:path.replace(account,':account'),removed:!!(await api(path)).missing});}catch{report.cleanup_verification.push({path:path.replace(account,':account'),removed:false});}}
  report.finished_at=new Date().toISOString();summarize();if((!inventoryOnly&&report.cpu_readiness!=='PASS')||report.cleanup_verification.some(x=>!x.removed))process.exitCode=1;await save();console.log(JSON.stringify({stage:'finished',report:resolve(dir,'results.json'),e2e:report.e2e.length,cpu:report.cpu,cleanup:report.cleanup}));
}
