// Prepared for a FUTURE separately authorized isolated run. Never provisions/deploys.
import {readFile,open,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {samplePlan,runPair,ARCHIVE_PATH} from './lib/archive-canary-harness.mjs';
export function durableJournal(file){
  return{
    async read(){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;return{state:'operator_hold'};}},
    async write(value){const fd=await open(file,value.phase==='A'?'wx':'r+');try{await fd.truncate(0);await fd.writeFile(JSON.stringify(value));await fd.sync();}finally{await fd.close();}},
    // Keep the file; a terminal marker avoids delete/recreate races.
    async clear(){const fd=await open(file,'r+');try{await fd.truncate(0);await fd.writeFile('null');await fd.sync();}finally{await fd.close();}}
  };
}
async function main(){
  const [flag,configFile,fixtureDir,outputDir]=process.argv.slice(2);
  if(flag!=='--authorized-isolated'||!configFile||!fixtureDir||!outputDir)throw Error('FUTURE_EXPLICIT_ISOLATED_AUTHORIZATION_REQUIRED');
  const config=JSON.parse(await readFile(configFile,'utf8')),v=config.vars;
  const u=new URL(v.TEST_ORIGIN),name=config.name,expiry=Number(v.TEST_EXPIRES);
  if(!/^voteproof-archive-canary-test-[a-z0-9-]+$/.test(name)||u.protocol!=='https:'||!u.hostname.startsWith(name+'.')||!u.hostname.endsWith('.workers.dev')||u.href!==u.origin+'/'||
     v.TEST_ENVIRONMENT!=='isolated'||v.STORAGE_ARCHIVE_CANARY_ORIGIN!==u.origin||v.STORAGE_ARCHIVE_CANARY_ENVIRONMENT!=='isolated'||v.STORAGE_ALERT_ENABLED!=='false'||
     !Number.isFinite(expiry)||expiry<=Date.now()||expiry-Date.now()>86400000||
     !['native','operations'].includes(v.TEST_PROFILE)||config.r2_buckets?.length!==1||config.r2_buckets[0].bucket_name!==name||
     config.d1_databases?.length!==1||config.d1_databases[0].database_name!==name||config.d1_databases[0].database_id==='9e2b885d-66e2-4e4d-b768-4bded261296a')throw Error('ISOLATION_GUARD_FAILED');
  const access=process.env.CANARY_TEST_ACCESS,secret=process.env.CANARY_RELAY_SECRET;
  if(!/^[a-f0-9]{64}$/.test(access??'')||!/^[a-f0-9]{64}$/.test(secret??''))throw Error('SECURE_ENV_INPUT_REQUIRED');
  const out=resolve(outputDir);await mkdir(out); // refuses an accidental rerun
  const ledger=[],snapshots=[],fixtures=JSON.parse(await readFile(resolve(fixtureDir,'FIXTURES.json'),'utf8'));
  const samples=v.TEST_PROFILE==='native'?samplePlan():[1,3,5].map(mib=>({label:'ops-'+mib+'m',mib,A:`ops-${mib}m-1-A`,B:`ops-${mib}m-1-B`}));
  for(const s of samples){
    const f=fixtures.find(f=>f.label===s.label);if(!f||f.file!==s.label+'.png')throw Error('SYNTHETIC_FIXTURE_REQUIRED');
    // Input bytes must be from the offline builder, never a production/image URL.
    const bytes=await readFile(resolve(fixtureDir,f.file));
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    if(bytes.length!==s.mib*1048576||Buffer.from(digest).toString('hex')!==f.sha256)throw Error('FIXTURE_DIGEST_MISMATCH');
    const headers={'X-Isolated-Access':access,'X-Canary-Fixture':s.label};
    const seed=await fetch(u.origin+'/__canary_seed',{method:'POST',headers,body:bytes,redirect:'error',signal:AbortSignal.timeout(30000)});
    if(seed.status!==200||(await seed.json()).seeded!==true)throw Error('SEED_HOLD_NO_RETRY');
    const journal=durableJournal(resolve(out,s.label+'.journal'));
    const result=await runPair(async(body,id)=>{
      let response,text='',success=false,http1102=null;
      const started=Date.now();try{
        response=await fetch(u.origin+ARCHIVE_PATH,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
          headers:{'Content-Type':'application/json','X-Isolated-Access':access,'X-Isolated-Sample':id,Authorization:'Bearer '+secret},body:JSON.stringify(body)});
        text=await response.text();if(text.length>8192)throw Error('BOUNDED_RESPONSE_REQUIRED');
        http1102=/\berror(?:\s+code)?\s*[:=]?\s*1102\b/i.test(text);const parsed=JSON.parse(text),cleanup=parsed?.data?.cleanup;
        success=response.status===200&&parsed.ok===true&&cleanup?.state===(body.handoff?'cold':'verification_ready');
        return{status:response.status,body:parsed};
      }finally{
        const ops=response?.headers.get('X-Canary-Operations');
        ledger.push({sample:id,mib:s.mib,phase:body.handoff?'B':'A',profile:v.TEST_PROFILE,path:ARCHIVE_PATH,success,status:response?.status??null,http1102,client_wall_ms:Date.now()-started,
          operations:ops?JSON.parse(ops):null});
        await writeFile(resolve(out,'requests.json'),JSON.stringify(ledger,null,2));
      }
    },journal,s);
    if(result.state!=='complete')throw Error('PERSISTENT_OPERATOR_HOLD_NO_RETRY');
    const snap=await fetch(u.origin+'/__canary_snapshot',{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(30000)});
    const row=await snap.json();snapshots.push({label:s.label,...row});await writeFile(resolve(out,'snapshots.json'),JSON.stringify(snapshots,null,2));
    if(snap.status!==200||row.exists||row.state!=='cold'||row.backup!=='confirmed'||row.terminal_audits!==1)throw Error('SNAPSHOT_MISMATCH_HOLD');
  }
  console.log(JSON.stringify({completed:samples.length,profile:v.TEST_PROFILE,cpu:'Requires separate native trace reconciliation; UNKNOWN until then'}));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  try{await main();}catch(e){console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'ISOLATED_RUN_FAILED_NO_RETRY');process.exitCode=1;}
}
