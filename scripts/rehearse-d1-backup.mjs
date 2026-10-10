// Operator-invoked rehearsal only. Remote access is deliberately unavailable.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)), wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
const env={...process.env,CI:'true',WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false'};
for(const name of Object.keys(env))if(/^(AUTH_|SUPABASE_|GMAIL_|MAIL_RELAY_|R2_|TURNSTILE_)/.test(name)||['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CASE_QUERY_KEY_SECRET','GOOGLE_PUBLIC_API_URL'].includes(name))delete env[name];
try {
  const args=process.argv.slice(2), opts={};
  for(let i=0;i<args.length;i+=2){const key=args[i]?.replace(/^--/,'');if(!['backup','manifest'].includes(key)||opts[key]||!args[i+1])throw Error();opts[key]=args[i+1];}
  if(!opts.backup||!opts.manifest)throw Error();
  const backup=resolve(root,opts.backup), manifestFile=resolve(root,opts.manifest);
  for(const p of [backup,manifestFile]){
    if(!existsSync(p))throw Error();
    const rel=relative(root,p);if(!isAbsolute(rel)&&!rel.startsWith('..'))execFileSync('git',['check-ignore','--quiet','--',rel],{cwd:root,stdio:'ignore',windowsHide:true});
  }
  const expected=JSON.parse(readFileSync(manifestFile,'utf8'));
  if(!expected.tables||!Object.keys(expected.tables).length||Object.entries(expected.tables).some(([k,v])=>!/^[a-z][a-z0-9_]*$/.test(k)||!Number.isSafeInteger(v)||v<0))throw Error();
  execFileSync('git',['check-ignore','--quiet','--','.wrangler/b7-restore-probe'],{cwd:root,stdio:'ignore',windowsHide:true});
  const folder=mkdtempSync(resolve(root,'.wrangler/b7-restore-'));
  const config=join(folder,'wrangler.json'), persist=join(folder,'state');
  writeFileSync(config,JSON.stringify({name:'voteproof-local-restore',compatibility_date:'2026-10-07',d1_databases:[{binding:'DB',database_name:'voteproof-rehearsal',database_id:randomUUID()}]}));
  const run=extra=>execFileSync(process.execPath,[wrangler,'d1','execute','voteproof-rehearsal','--config',config,'--local','--persist-to',persist,...extra],{cwd:folder,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});
  run(['--file',backup]);
  const query=sql=>JSON.parse(run(['--command',sql,'--json'])).flatMap(r=>{if(!r.success)throw Error();return r.results});
  const fk=query('PRAGMA foreign_key_check'), quick=query('PRAGMA quick_check');
  if(fk.length||quick.length!==1||quick[0].quick_check!=='ok')throw Error();
  const tables=query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").map(r=>r.name);
  if(JSON.stringify(tables)!==JSON.stringify(Object.keys(expected.tables).sort()))throw Error();
  const counts={};for(const name of tables){counts[name]=query(`SELECT COUNT(*) n FROM "${name}"`)[0].n;if(counts[name]!==expected.tables[name])throw Error();}
  const result={result:'PASS',local_only:true,remote_access:false,schema_table_names_match:true,row_counts:counts,foreign_key_check:'PASS',quick_check:'ok',private_restore_retained:true};
  writeFileSync(join(folder,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result));
} catch {console.error('LOCAL_RESTORE_REHEARSAL_STOPPED');process.exitCode=1;}
