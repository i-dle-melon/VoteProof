// OFFLINE ONLY. No login, API calls, deploy, migrations apply, or resource creation.
import {build} from 'esbuild';
import {writeFile,mkdir,readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {samplePlan} from './lib/archive-canary-harness.mjs';
import {fixtures,fixtureSchema,fixtureSQL,image,digest} from './lib/archive-isolated-fixtures.mjs';
import {unstable_splitSqlQuery} from 'wrangler';
export const harnessSchema=`CREATE TABLE canary_harness_budget(role TEXT PRIMARY KEY,used INTEGER NOT NULL DEFAULT 0,ceiling INTEGER NOT NULL,paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1)));
INSERT INTO canary_harness_budget(role,ceiling) VALUES('request',36),('relay',18),('seed',18),('snapshot',18);
CREATE TABLE canary_harness_nonces(nonce TEXT PRIMARY KEY);`;
export async function buildHarness(){
  return(await build({entryPoints:[fileURLToPath(new URL('./lib/archive-canary-cloud-worker.mjs',import.meta.url))],
    inject:[fileURLToPath(new URL('./lib/archive-canary-fetch-inject.mjs',import.meta.url))],
    bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:async_hooks'],
    define:{fetch:'canaryFetch'}})).outputFiles[0].text;
}
export function isolatedConfig({name,account,accountId,databaseId,expires,writerEvidenceHash}){
  if(!/^voteproof-archive-canary-test-[a-z0-9-]+$/.test(name)||!Number.isFinite(expires)||expires<=Date.now()||expires-Date.now()>86400000||
     !/^[a-z0-9-]+$/.test(account)||!/^[a-f0-9]{32}$/.test(accountId??'')||!/^[a-f0-9]{64}$/.test(writerEvidenceHash??'')||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(databaseId)||databaseId==='9e2b885d-66e2-4e4d-b768-4bded261296a')throw Error('ISOLATED_CONFIG_REQUIRED');
  const origin=`https://${name}.${account}.workers.dev`;
  return{name,account_id:accountId,main:'worker.mjs',compatibility_date:'2026-10-07',compatibility_flags:['nodejs_compat'],
    observability:{enabled:true,head_sampling_rate:1},
    d1_databases:[{binding:'DB',database_name:name,database_id:databaseId}],
    r2_buckets:[{binding:'PROOFS_BUCKET',bucket_name:name}],services:[{binding:'MOCK_RELAY',service:name}],
    vars:{TEST_ENVIRONMENT:'isolated',TEST_PROFILE:'native',TEST_EXPIRES:String(expires),TEST_ORIGIN:origin,TEST_WRITER_EVIDENCE_SHA256:writerEvidenceHash,
      GOOGLE_DRIVE_BACKUP_ENABLED:'true',STORAGE_CLEANUP_LIVE_ENABLED:'true',STORAGE_ALERT_ENABLED:'false',
      R2_EXCLUSIVE_WRITER_CONFIRMED:'true',STORAGE_ARCHIVE_CANARY_ENABLED:'true',STORAGE_ARCHIVE_CANARY_ENVIRONMENT:'isolated',
      STORAGE_ARCHIVE_CANARY_ORIGIN:origin,DRIVE_COLD_RELAY_URL:new URL('/macros/s/isolated_canary/exec','https://script.google.com').href}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3)throw Error('Usage: node scripts/prepare-archive-canary-harness.mjs <new-local-output-directory>');
  const out=resolve(process.argv[2]);await mkdir(out); // refuses overwrite
  await writeFile(resolve(out,'worker.mjs'),await buildHarness());
  await writeFile(resolve(out,'test-schema.sql'),harnessSchema);
  const samples=samplePlan(),specs=[...samples.map(s=>[s.label,s.mib]),...[1,3,5].map(m=>['ops-'+m+'m',m])],items=fixtures(specs);
  const migrationNames=(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>/^\d+_.+\.sql$/.test(n)).sort();
  await mkdir(resolve(out,'migrations'));
  const gateNames=['submissions_cases_insert','submissions_uploads_insert','submissions_upload_files_insert'],gateMap=new Map();
  for(const name of migrationNames){const content=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');await writeFile(resolve(out,'migrations',name),content);
    for(const sql of unstable_splitSqlQuery(content))for(const g of gateNames)if(new RegExp('CREATE TRIGGER(?: IF NOT EXISTS)? '+g+'\\b','i').test(sql))gateMap.set(g,sql);}
  const gates=[...gateMap.values()]; // latest schema replaces the original 0008 case gate in 0018
  if(gates.length!==3)throw Error('EXACT_GATE_RESTORE_REQUIRED');
  const stamp=new Date().toISOString(),records=[];
  let setup=fixtureSchema+'\n'+harnessSchema+`\nINSERT INTO campaigns(campaign_id,name,category,solo_target,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at) VALUES('ISOLATED','Synthetic','Solo','synthetic','2000-01-01','2100-01-01','UTC','2000-01-01','2099-12-31',0,NULL,'active','${stamp}','${stamp}');\nINSERT INTO drive_backup_folders VALUES('synthetic_root','campaign:synthetic','synthetic_campaign','synthetic_root','Synthetic',0);\n`+
    gateNames.map(g=>'DROP TRIGGER '+g+';').join('\n');
  for(const f of items){const bytes=image(f.size),sha=digest(bytes);await writeFile(resolve(out,f.label+'.png'),bytes);setup+='\n'+fixtureSQL(f,sha);records.push({label:f.label,mib:f.mib,size:f.size,sha256:sha,file:f.label+'.png'});}
  setup+='\n'+gates.map(s=>s+';').join('\n');await writeFile(resolve(out,'synthetic-setup.sql'),setup);await writeFile(resolve(out,'FIXTURES.json'),JSON.stringify(records,null,2));
  await writeFile(resolve(out,'PLAN.json'),JSON.stringify({cloud_authorized:false,cpu:'UNKNOWN',samples:samplePlan(),
    resources:['1 Free Worker (self service binding mock)','1 synthetic D1','1 synthetic R2 bucket'],
    secrets_required:['TEST_ACCESS','DRIVE_BACKUP_RELAY_SECRET'],max_client_cpu_requests:30,max_mock_invocations:15,
    operations_profile_additional_client_requests:6,setup_and_snapshot_requests:36,max_total_worker_invocations:90,
    note:'native CPU includes budget CAS and mock transport; operation profile CPU excluded; no resources created'},null,2));
  console.log('Offline build complete; Cloudflare CPU UNKNOWN; no cloud operations.');
}
