// Explicitly authorized disposable Free-plan validation. Credentials stay outside Git.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {observeInventory,reconcileInventoryTraces} from './lib/inventory-tail.mjs';
const action=process.argv[2],privateDir=process.argv[3];
assert.ok(['setup','cpu','status','cleanup','recheck','targeted','segmented'].includes(action)&&privateDir,'ACTION_AND_PRIVATE_DIRECTORY_REQUIRED');
assert.ok(!resolve(privateDir).startsWith(process.cwd()),'PRIVATE_DIRECTORY_OUTSIDE_REPO');
await mkdir(privateDir,{recursive:true});
const privatePath=join(privateDir,'inventory-cloud-private.json');
const env={...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false'};
const token=JSON.parse(execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','auth','token','--json'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})).token;
const account='7a1ae5a3d1e51008d0880ac526740717',base='/accounts/'+account;
let s=action==='setup'?{name:'voteproof-inventory-test-'+randomBytes(5).toString('hex'),access:randomBytes(32).toString('hex'),relay:randomBytes(32).toString('hex'),database:null,created:{},report:{requests:[],traces:[],collector:{starts:0,parse_errors:0,errors:0,exits:[]}}}:JSON.parse(await readFile(privatePath));
assert.match(s.name,/^voteproof-inventory-test-[a-f0-9]{10}$/);
assert.notEqual(s.database,'9e2b885d-66e2-4e4d-b768-4bded261296a');
const save=()=>writeFile(privatePath,JSON.stringify(s,null,2));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,method='GET',body){
  if(method!=='GET')assert.ok(path===base+'/d1/database'||path===base+'/r2/buckets'||path===base+'/r2/buckets/'+s.name||
    path===base+'/workers/scripts/'+s.name||path.startsWith(base+'/workers/scripts/'+s.name+'/')||
    (s.database&&path.startsWith(base+'/d1/database/'+s.database)),'ISOLATED_MUTATION_GUARD');
  const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+token,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
  if(r.status===404)return{missing:true};if(r.status===204)return{};
  const v=await r.json();if(!r.ok||!v.success)throw Error('CLOUDFLARE_'+r.status+'_'+v.errors?.map(x=>x.code).join('_'));return v.result;
}
async function sql(text,params=[]){const v=await api(base+'/d1/database/'+s.database+'/query','POST',{sql:text,params});return v.flatMap(x=>x.results);}
async function call(path,body,extra={}){
  const r=await fetch(s.origin+path,{method:body===undefined?'GET':'POST',headers:{'X-Isolated-Access':s.access,Authorization:'Bearer '+s.relay,'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
  const v=await r.json().catch(()=>null);assert.equal(r.status,200,'HTTP_'+r.status);return v;
}
let collector;
let observation;
try{
if(action==='recheck'){
  // Preserve the original measurements; correct harness-only double JSON work.
  await writeFile(join(privateDir,'baseline-report.json'),JSON.stringify(s.report,null,2));
  s.report.previous_methodology={cpu:s.report.cpu,readiness:s.report.cpu_readiness,
    correction:'Removed harness-only request.clone().json() and response.clone().json(); product code unchanged.'};
  s.report.requests=[];s.report.traces=[];s.report.collector={starts:0,parse_errors:0,errors:0,exits:[]};
  const bundle=await build({entryPoints:[resolve('scripts/lib/inventory-isolated-worker.mjs')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  const settings=await api(base+'/workers/scripts/'+s.name+'/settings');
  assert.equal(settings.bindings.find(x=>x.name==='DB')?.id,s.database);
  assert.equal(settings.bindings.find(x=>x.name==='PROOFS_BUCKET')?.bucket_name,s.name);
  const bindings=settings.bindings.map(b=>b.type==='secret_text'?{type:b.type,name:b.name,text:b.name==='TEST_ACCESS'?s.access:s.relay}:b);
  assert.deepEqual(bindings.filter(b=>b.type==='secret_text').map(b=>b.name).sort(),['DRIVE_BACKUP_RELAY_SECRET','TEST_ACCESS']);
  const form=new FormData();form.set('metadata',new Blob([JSON.stringify({main_module:'worker.mjs',compatibility_date:'2026-10-07',usage_model:'standard',bindings,logpush:false})],{type:'application/json'}));form.set('worker.mjs',new Blob([bundle.outputFiles[0].text],{type:'application/javascript+module'}),'worker.mjs');
  await api(base+'/workers/scripts/'+s.name,'PUT',form);
  s.report.bundle_sha256=createHash('sha256').update(bundle.outputFiles[0].text).digest('hex');
  await save();console.log(JSON.stringify({stage:'harness-corrected',product_changes:0}));
}
if(action==='setup'){
  assert.equal((await api(base+'/workers/settings')).free_tier,true,'FREE_REQUIRED');
  assert.ok((await api(base+'/workers/scripts/'+s.name+'/settings')).missing);
  assert.ok((await api(base+'/r2/buckets/'+s.name)).missing);await save();
  await api(base+'/r2/buckets','POST',{name:s.name});s.created.bucket=true;await save();
  s.database=(await api(base+'/d1/database','POST',{name:s.name})).uuid;s.created.database=true;await save();
  const config=join(privateDir,'wrangler.json');await writeFile(config,JSON.stringify({name:s.name,account_id:account,compatibility_date:'2026-10-07',d1_databases:[{binding:'DB',database_name:s.name,database_id:s.database,migrations_dir:resolve('migrations')}]}));
  execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply',s.name,'--remote','--config',config],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await sql('CREATE TABLE isolated_budget(n INTEGER NOT NULL); INSERT INTO isolated_budget VALUES(0)');
  const sub=(await api(base+'/workers/subdomain')).subdomain;s.origin='https://'+s.name+'.'+sub+'.workers.dev';
  const bundle=await build({entryPoints:[resolve('scripts/lib/inventory-isolated-worker.mjs')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  s.report.bundle_sha256=createHash('sha256').update(bundle.outputFiles[0].text).digest('hex');
  const bindings=[{type:'d1',name:'DB',id:s.database},{type:'r2_bucket',name:'PROOFS_BUCKET',bucket_name:s.name},
    ...Object.entries({TEST_ACCESS:s.access,DRIVE_BACKUP_RELAY_SECRET:s.relay}).map(([name,text])=>({type:'secret_text',name,text})),
    ...Object.entries({TEST_NAME:s.name,TEST_BUCKET:s.name,TEST_DATABASE:s.database,TEST_EXPIRES:String(Date.now()+4*3600000),GOOGLE_DRIVE_BACKUP_ENABLED:'true',R2_EXCLUSIVE_WRITER_CONFIRMED:'true',STORAGE_CLEANUP_LIVE_ENABLED:'false',STORAGE_ALERT_ENABLED:'false'}).map(([name,text])=>({type:'plain_text',name,text}))];
  const form=new FormData();form.set('metadata',new Blob([JSON.stringify({main_module:'worker.mjs',compatibility_date:'2026-10-07',usage_model:'standard',bindings,logpush:false,observability:{enabled:true,head_sampling_rate:1}})],{type:'application/json'}));form.set('worker.mjs',new Blob([bundle.outputFiles[0].text],{type:'application/javascript+module'}),'worker.mjs');
  await api(base+'/workers/scripts/'+s.name,'PUT',form);s.created.worker=true;await save();
  await api(base+'/workers/scripts/'+s.name+'/subdomain','POST',{enabled:true,previews_enabled:false});
  s.report.started_at=new Date().toISOString();await save();console.log(JSON.stringify({stage:'setup',name:s.name,origin:s.origin,free:true}));
}
if(action==='segmented'){
  const config=join(privateDir,'tail.json');await writeFile(config,JSON.stringify({name:s.name,account_id:account,compatibility_date:'2026-10-07'}));
  const settings=await api(base+'/workers/scripts/'+s.name+'/settings');
  assert.equal(settings.bindings.find(x=>x.name==='DB')?.id,s.database);
  assert.equal(settings.bindings.find(x=>x.name==='PROOFS_BUCKET')?.bucket_name,s.name);
  const run=randomBytes(8).toString('hex'),headers={'x-inventory-run':run};
  observation=await observeInventory({api,base,name:s.name,run,config,env});
  const split=s.report.segmented={requests:[],direct:observation.direct,cli:observation.cli,references:[],checks:[],observability:settings.observability};
  for(let n=0;n<12;n++){
    await call('/ready',undefined,{...headers,'x-isolated-sample':'inv-barrier-'+n});await delay(1000);
    if(observation.direct.events.length&&observation.cli.events.length)break;
  }
  assert.ok(observation.direct.events.length&&observation.cli.events.length,'BOTH_TAILS_MUST_BE_READY');
  let lastAt=0;
  const measured=async(stage,count,scan,page,path,body)=>{
    await delay(Math.max(0,lastAt+1500-Date.now()));lastAt=Date.now();
    const sample='inv-split-'+count+'-'+stage+'-'+scan+'-'+page,start=performance.now();
    const record={stage,count,scan,page,sample,started_at:new Date().toISOString()};let v;
    try{
      const r=await fetch(s.origin+path,{method:'POST',headers:{...headers,Authorization:'Bearer '+s.relay,'Content-Type':'application/json','x-isolated-sample':sample},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
      const raw=await r.text();try{v=JSON.parse(raw);}catch{}
      Object.assign(record,{status:r.status,ray:r.headers.get('cf-ray'),http1102:/\b1102\b/.test(raw),wall_ms:performance.now()-start,data:v?.data??null});
    }catch(e){Object.assign(record,{status:null,error:e.name,wall_ms:performance.now()-start});}
    split.requests.push(record);assert.equal(record.status,200,'SPLIT_HTTP_'+record.status);
    assert.equal(v.data.inventory_only,true);assert.equal(v.data.cleanup,null);assert.equal(v.data.alerts.sent,0);
    assert.equal(v.data.alerts.state,'skipped_inventory_only');return v.data.inventory;
  };
  const tick='/api/internal/drive-backup/storage/tick',finalPath='/api/internal/drive-backup/storage/inventory/finalize';
  const snapshot=async()=> (await sql('SELECT * FROM storage_capacity'))[0];
  const comparable=row=>Object.fromEntries(['used_bytes','inventory_count','inventory_staging','inventory_other','blocked','anomaly','cleanup_requested'].map(k=>[k,row[k]]));
  const reset=()=>sql("UPDATE storage_capacity SET inventory_phase=NULL,inventory_id=NULL,inventory_cursor=NULL,inventory_bytes=0,inventory_count=0,inventory_staging=0,inventory_other=0,inventory_version=0,used_bytes=0,observed_at=NULL,blocked=1,trusted_until=0,anomaly=NULL,episode=1,cleanup_requested=0 WHERE id=1");
  let existing=0;
  for(const count of [34,201]){
    for(let start=existing;start<count;start+=25)await call('/seed',{start,count:Math.min(25,count-start)});existing=count;
    await reset();let original;do{original=await call(tick,{});}while(!original.data.inventory.complete);
    const reference=comparable(await snapshot());split.references.push({count,capacity:reference});await reset();
    for(let scan=0;scan<20;scan++){
      const before=await snapshot();let page=0,ready;
      do{ready=await measured('scan',count,scan,page,tick,{inventory_only:true});page++;assert.ok(page<=5);assert.equal(ready.complete,false);}while(ready.phase==='scan');
      assert.equal(ready.phase,'finalize');assert.equal(page,Math.ceil(count/50));
      const pinned=await snapshot();assert.equal(pinned.inventory_phase,'ready');assert.equal(pinned.trusted_until,0);
      assert.equal(pinned.used_bytes,before.used_bytes);assert.equal(pinned.inventory_bytes,count*68);
      assert.equal((await sql('SELECT COUNT(*) n FROM storage_history WHERE id=?',[ready.inventory_id]))[0].n,0);
      const body={inventory_id:ready.inventory_id,inventory_version:ready.inventory_version};
      if(scan===0){const again=await call(tick,{inventory_only:true});assert.deepEqual(again.data.inventory,ready);}
      const final=await measured('finalize',count,scan,0,finalPath,body);assert.equal(final.complete,true);assert.equal(final.bytes,count*68);assert.equal(final.anomaly,null);
      const committed=await snapshot();assert.deepEqual(comparable(committed),reference);assert.equal(committed.trusted_until-committed.observed_at,600);
      assert.equal(committed.inventory_phase,null);assert.equal(committed.inventory_id,null);assert.equal(committed.reserved_bytes,0);
      assert.equal((await sql('SELECT COUNT(*) n FROM storage_audit WHERE id=?',[ready.inventory_id]))[0].n,1);
      if(scan===0){const replay=await call(finalPath,body);assert.equal(replay.data.inventory.replayed,true);assert.deepEqual(await snapshot(),committed);}
      split.checks.push({count,scan,scan_invocations:page,finalize_invocations:1,capacity_matches_reference:true,no_early_trust:true,audit_once:true});
      if(scan%5===0){await save();console.log(JSON.stringify({stage:'segmented',objects:count,scan,scan_pages:page,traces:split.direct.events.length}));}
    }
  }
  const quota=await call('/api/internal/drive-backup/storage/quota',{id:crypto.randomUUID(),observed_at:Math.floor(Date.now()/1000),state:'known',total_bytes:15000000000,used_bytes:7000000000});assert.equal(quota.data.accepted,true);
  const expected=split.requests.map(x=>x.sample);
  for(let n=0;n<20;n++){if(expected.every(id=>split.direct.events.some(x=>x.sample===id)&&split.cli.events.some(x=>x.sample===id)))break;await delay(1000);}
  const stats=v=>{v=v.filter(Number.isFinite).sort((a,b)=>a-b);return{n:v.length,p50:v[Math.ceil(v.length*.5)-1]??null,p95:v[Math.ceil(v.length*.95)-1]??null,max:v.at(-1)??null,over10:v.filter(x=>x>10).length};};
  const summarize=(stage,count)=>{
    const requests=split.requests.filter(x=>x.stage===stage&&(count===undefined||x.count===count));
    const reconciled=reconcileInventoryTraces(requests,split.direct.events,split.cli.events),rows=reconciled.rows;
    return{stage,...(count===undefined?{}:{objects:count}),requests:requests.length,valid:rows.length,
      missing:reconciled.missing_ids.length,missing_ids:reconciled.missing_ids,
      direct_missing:requests.filter(r=>!split.direct.events.some(t=>t.sample===r.sample&&Number.isFinite(t.cpu_ms))).length,
      cli_missing:requests.filter(r=>!split.cli.events.some(t=>t.sample===r.sample&&Number.isFinite(t.cpu_ms))).length,
      cpu_mismatches:reconciled.conflicts.length,
      cpu:stats(rows.map(x=>x.cpu_ms)),first:rows.filter(x=>requests.find(r=>r.sample===x.sample).scan===0),failures:requests.filter(x=>x.status!==200).length,
      http1102:requests.filter(x=>x.http1102).length,exceededCpu:rows.filter(x=>x?.outcome==='exceededCpu').length,wall:stats(requests.map(x=>x.wall_ms))};
  };
  split.summary=['scan','finalize'].map(stage=>summarize(stage));split.by_count=[34,201].flatMap(n=>['scan','finalize'].map(stage=>summarize(stage,n)));
  split.integrity={capacity:await snapshot(),quick_check:await sql('PRAGMA quick_check'),fk:await sql('PRAGMA foreign_key_check'),submissions:await sql('SELECT submissions_enabled FROM submission_settings'),deliveries:await sql('SELECT COUNT(*) n FROM storage_alert_deliveries'),cold:await sql('SELECT COUNT(*) n FROM cold_proofs'),quota:await sql('SELECT state,COUNT(*) n FROM drive_quota_snapshots GROUP BY state')};
  split.readiness=split.summary.some(x=>x.cpu.over10||x.failures||x.http1102||x.exceededCpu)?'FAIL':split.summary.every(x=>x.missing===0&&x.cpu_mismatches===0)?'PASS':'UNKNOWN';
  await observation.stop();observation=null;await save();if(split.readiness!=='PASS')process.exitCode=1;
  console.log(JSON.stringify({stage:'segmented-finished',readiness:split.readiness,summary:split.summary,by_count:split.by_count,integrity:split.integrity,raw:split.direct.diagnostics,cli:split.cli.diagnostics}));
}
if(action==='targeted'){
  const config=join(privateDir,'tail.json');await writeFile(config,JSON.stringify({name:s.name,account_id:account,compatibility_date:'2026-10-07'}));
  const settings=await api(base+'/workers/scripts/'+s.name+'/settings');
  assert.equal(settings.bindings.find(x=>x.name==='DB')?.id,s.database);
  assert.equal(settings.bindings.find(x=>x.name==='PROOFS_BUCKET')?.bucket_name,s.name);
  s.report.observability=settings.observability??null;
  const run=randomBytes(8).toString('hex');
  observation=await observeInventory({api,base,name:s.name,run,config,env});
  s.report.targeted={requests:[],direct:observation.direct,cli:observation.cli,barriers:[]};
  const headers={'x-inventory-run':run};
  for(let n=0;n<12;n++){
    const sample='inv-barrier-'+n;await call('/ready',undefined,{...headers,'x-isolated-sample':sample});
    await delay(1000);
    if(observation.direct.events.length&&observation.cli.events.length)break;
  }
  assert.ok(observation.direct.events.length&&observation.cli.events.length,'BOTH_TAILS_MUST_BE_READY');
  const measured=async(group,path,sample,scan,page)=>{
    const started=performance.now();let status=null,value=null,error=null,http1102=false;
    try{const r=await fetch(s.origin+path,{method:'POST',headers:{...headers,'X-Isolated-Access':s.access,Authorization:'Bearer '+s.relay,'Content-Type':'application/json','x-isolated-sample':sample},body:'{"inventory_only":true}',signal:AbortSignal.timeout(30000)});
      status=r.status;const raw=await r.text();http1102=/\b1102\b/.test(raw);try{value=JSON.parse(raw);}catch{}
    }catch(e){error=e.name;}
    s.report.targeted.requests.push({group,sample,scan,page,status,error,http1102,wall_ms:performance.now()-started,data:value?.data??value});
    assert.equal(status,200,'TARGETED_HTTP_'+status);return value;
  };
  let existing=0;
  for(const count of [34,201]){
    for(let start=existing;start<count;start+=25)await call('/seed',{start,count:Math.min(25,count-start)});existing=count;
    await sql('UPDATE storage_capacity SET observed_at=NULL,used_bytes=0,blocked=1,trusted_until=0,anomaly=NULL WHERE id=1');
    for(let scan=0;scan<30;scan++){
      let page=0,v;do{
        v=await measured('native-'+count,'/api/internal/drive-backup/storage/tick','inv-native-'+count+'-'+scan+'-'+page,scan,page);
        assert.equal(v.data.inventory_only,true);assert.equal(v.data.cleanup,null);assert.equal(v.data.alerts.sent,0);assert.equal(v.data.alerts.state,'skipped_inventory_only');
        page++;assert.ok(page<=5);
      }while(!v.data.inventory.complete);
      assert.equal(page,Math.ceil(count/50));assert.equal(v.data.inventory.bytes,count*68);assert.equal(v.data.inventory.anomaly,null);
      if(scan%10===0){await save();console.log(JSON.stringify({stage:'targeted',objects:count,scan,pages:page,traces:observation.direct.events.length}));}
    }
  }
  // Diagnostic invocations are separate; never sum their CPU into a request.
  for(let n=0;n<12;n++)for(const kind of ['control','auth-json','list-50','list-200'])
    await measured(kind,'/probe/'+kind,'inv-probe-'+kind+'-'+n,n,0);
  for(let scan=0;scan<4;scan++){
    let page=0,v;do{v=await measured('d1-memory','/probe/d1-scan','inv-d1-'+scan+'-'+page,scan,page);page++;assert.ok(page<=5);}while(!v.data.inventory.complete);
    assert.equal(v.data.inventory.bytes,201*68);assert.equal(v.data.inventory.anomaly,null);
  }
  const expected=s.report.targeted.requests.map(x=>x.sample);
  for(let n=0;n<30;n++){
    if(expected.every(id=>observation.direct.events.some(x=>x.sample===id)&&observation.cli.events.some(x=>x.sample===id)))break;
    await delay(1000);
  }
  const stats=v=>{v=v.filter(Number.isFinite).sort((a,b)=>a-b);return{n:v.length,p50:v[Math.ceil(v.length*.5)-1]??null,p95:v[Math.ceil(v.length*.95)-1]??null,max:v.at(-1)??null,over10:v.filter(x=>x>10).length};};
  const t=s.report.targeted;
  t.summary=[...new Set(t.requests.map(x=>x.group))].map(group=>{
    const req=t.requests.filter(x=>x.group===group),direct=req.map(x=>t.direct.events.find(e=>e.sample===x.sample)),cli=req.map(x=>t.cli.events.find(e=>e.sample===x.sample));
    return{group,requests:req.length,valid:direct.filter(x=>Number.isFinite(x?.cpu_ms)).length,missing:direct.filter(x=>!Number.isFinite(x?.cpu_ms)).length,
      cpu:stats(direct.map(x=>x?.cpu_ms)),cli_valid:cli.filter(x=>Number.isFinite(x?.cpu_ms)).length,cli_missing:cli.filter(x=>!Number.isFinite(x?.cpu_ms)).length,
      cpu_mismatches:direct.filter((x,i)=>Number.isFinite(x?.cpu_ms)&&Number.isFinite(cli[i]?.cpu_ms)&&x.cpu_ms!==cli[i].cpu_ms).length,
      first:direct.filter((x,i)=>req[i].scan===0),wall:stats(req.map(x=>x.wall_ms)),failures:req.filter(x=>x.status!==200).length,http1102:req.filter(x=>x.http1102).length,
      exceededCpu:direct.filter(x=>x?.outcome==='exceededCpu').length};
  });
  t.integrity={capacity:(await sql('SELECT * FROM storage_capacity'))[0],quota_counts:await sql('SELECT state,COUNT(*) n FROM drive_quota_snapshots GROUP BY state'),quick_check:await sql('PRAGMA quick_check'),fk:await sql('PRAGMA foreign_key_check'),submissions:await sql('SELECT submissions_enabled FROM submission_settings'),deliveries:await sql('SELECT COUNT(*) n FROM storage_alert_deliveries'),cold:await sql('SELECT COUNT(*) n FROM cold_proofs')};
  const native=t.summary.filter(x=>x.group.startsWith('native-'));
  t.readiness=native.some(x=>x.cpu.over10||x.failures||x.http1102||x.exceededCpu)?'FAIL':native.every(x=>x.requests>0&&x.missing===0&&x.cli_missing===0&&x.cpu_mismatches===0)?'PASS':'UNKNOWN';
  if(t.readiness!=='PASS')process.exitCode=1;
  await observation.stop();observation=null;await save();console.log(JSON.stringify({stage:'targeted-finished',readiness:t.readiness,summary:t.summary,integrity:t.integrity,direct:t.direct.diagnostics,cli:t.cli.diagnostics}));
}
if(action==='cpu'||action==='recheck'){
  const config=join(privateDir,'tail.json');await writeFile(config,JSON.stringify({name:s.name,account_id:account,compatibility_date:'2026-10-07'}));
  collector=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','tail',s.name,'--config',config,'--format','json'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});s.report.collector.starts++;
  let depth=0,quoted=false,escaped=false,buffer='';collector.stdout.setEncoding('utf8');collector.stdout.on('data',chunk=>{for(const ch of chunk){if(!depth){if(ch!=='{')continue;depth=1;buffer='{';continue;}buffer+=ch;if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}else if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&!--depth){try{const v=JSON.parse(buffer),h=v.event?.request?.headers??{},sample=h['x-isolated-sample']??h['X-Isolated-Sample'];if(sample?.startsWith('inv-'))s.report.traces.push({sample,cpu_ms:Number.isFinite(v.cpuTime)?v.cpuTime:null,wall_ms:v.wallTime??null,outcome:v.outcome,status:v.event?.response?.status,exceptions:v.exceptions?.length??0});}catch{s.report.collector.parse_errors++;}buffer='';}}});
  collector.stderr.on('data',c=>{if(/error|disconnect|reconnect/i.test(String(c)))s.report.collector.errors++;});collector.on('exit',(code,signal)=>s.report.collector.exits.push({code,signal}));
  await delay(6000);assert.equal(collector.exitCode,null);
  for(const count of action==='recheck'?[401]:[0,34,201,401]){
    const current=(await sql('SELECT inventory_count n FROM storage_capacity'))[0].n;
    for(let start=current;start<count;start+=25)await call('/seed',{start,count:Math.min(25,count-start)});
    // Synthetic setup only: a larger fixture is not unaccounted Production growth.
    await sql('UPDATE storage_capacity SET observed_at=NULL,used_bytes=0,blocked=1,trusted_until=0,anomaly=NULL WHERE id=1');
    for(let scan=0;scan<40;scan++){
      let page=0,result;do{
        const sample='inv-'+count+'-'+scan+'-'+page,start=performance.now();
        const r=await fetch(s.origin+'/api/internal/drive-backup/storage/tick',{method:'POST',headers:{Authorization:'Bearer '+s.relay,'Content-Type':'application/json','X-Isolated-Sample':sample},body:'{"inventory_only":true}',signal:AbortSignal.timeout(60000)});
        const raw=await r.text();let v;try{v=JSON.parse(raw);}catch{}
        s.report.requests.push({sample,count,scan,page,status:r.status,wall_ms:performance.now()-start,complete:v?.data?.inventory?.complete??null,http1102:/\b1102\b/.test(raw),data:v?.data??null});
        assert.equal(r.status,200,'TICK_HTTP_'+r.status);assert.equal(v.data.inventory_only,true);assert.equal(v.data.cleanup,null);assert.deepEqual(v.data.alerts,{state:'skipped_inventory_only',sent:0});result=v.data.inventory;page++;
        assert.ok(page<=3);
      }while(!result.complete);
      assert.equal(page,Math.max(1,Math.ceil(count/200)));assert.equal(result.anomaly,null);
      if(scan%10===0){await save();console.log(JSON.stringify({stage:'cpu',objects:count,scan,pages:page,traces:s.report.traces.length}));}
    }
  }
  await delay(12000);await save();
}
if(action==='status'||action==='cpu'||action==='recheck'){
  const rows=await sql('SELECT * FROM storage_capacity');const quota=await sql('SELECT state,COUNT(*) n FROM drive_quota_snapshots GROUP BY state');
  s.report.capacity=rows[0];s.report.quota_counts=quota;s.report.integrity={quick_check:await sql('PRAGMA quick_check'),fk:await sql('PRAGMA foreign_key_check'),submissions:await sql('SELECT submissions_enabled FROM submission_settings'),deliveries:await sql('SELECT COUNT(*) n FROM storage_alert_deliveries'),cold:await sql('SELECT COUNT(*) n FROM cold_proofs')};
  const stats=v=>{v=v.filter(Number.isFinite).sort((a,b)=>a-b);return{n:v.length,p50:v[Math.ceil(v.length*.5)-1]??null,p95:v[Math.ceil(v.length*.95)-1]??null,p99:v[Math.ceil(v.length*.99)-1]??null,max:v.at(-1)??null,over10:v.filter(x=>x>10).length};};
  s.report.cpu=[...new Set(s.report.requests.map(x=>x.count))].map(count=>{const req=s.report.requests.filter(x=>x.count===count),traces=req.map(x=>s.report.traces.find(t=>t.sample===x.sample));return{objects:count,requests:req.length,valid:traces.filter(x=>Number.isFinite(x?.cpu_ms)).length,missing:traces.filter(x=>!Number.isFinite(x?.cpu_ms)).length,cpu:stats(traces.map(x=>x?.cpu_ms)),first:traces.filter((x,i)=>req[i].scan===0),wall:stats(req.map(x=>x.wall_ms)),http1102:req.filter(x=>x.http1102).length,failures:req.filter(x=>x.status!==200).length,exceededCpu:traces.filter(x=>x?.outcome==='exceededCpu').length};});
  s.report.cpu_readiness=s.report.cpu.some(x=>x.cpu.over10||x.http1102||x.failures||x.exceededCpu)?'FAIL':s.report.cpu.every(x=>x.requests>0&&x.missing===0)?'PASS':'UNKNOWN';
  await save();console.log(JSON.stringify({stage:action,cpu:s.report.cpu,cpu_readiness:s.report.cpu_readiness,capacity:s.report.capacity,quota_counts:quota,integrity:s.report.integrity}));
}
if(action==='cleanup'){
  s.report.cleanup={};if(s.created.worker){for(let i=0;i<5;i++){const r=await call('/cleanup',{});if(!r.more)break;}await api(base+'/workers/scripts/'+s.name,'DELETE');s.report.cleanup.worker=!!(await api(base+'/workers/scripts/'+s.name+'/settings')).missing;}
  if(s.created.bucket){await api(base+'/r2/buckets/'+s.name,'DELETE');s.report.cleanup.bucket=!!(await api(base+'/r2/buckets/'+s.name)).missing;}
  if(s.created.database){await api(base+'/d1/database/'+s.database,'DELETE');s.report.cleanup.database=!!(await api(base+'/d1/database/'+s.database)).missing;}
  s.report.finished_at=new Date().toISOString();await save();console.log(JSON.stringify({stage:'cleanup',...s.report.cleanup}));
}
}catch(e){s.report.failure={action,name:e.name,message:String(e.message).slice(0,180)};await save();console.error(JSON.stringify(s.report.failure));process.exitCode=1;}
finally{collector?.kill();if(observation)try{await observation.stop();}catch{}await save();}
