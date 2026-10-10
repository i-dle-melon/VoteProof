// Offline exact-file staging only. No migration/deploy execution.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DATABASE, DATABASE_ID } from './lib/release-plans.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const names=['0001_cases.sql','0002_case_idempotency.sql','0003_member_identity.sql','0004_admin_review.sql','0005_campaign_point_ledger.sql','0006_leaderboards.sql','0007_member_tiers.sql'];
try {
  const opts={target:'local'},seen=new Set(),args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2){const key=args[i]?.replace(/^--/,'');if(!['target','database','confirm-database-id'].includes(key)||seen.has(key)||!args[i+1])throw Error();seen.add(key);opts[key]=args[i+1];}
  if(!['local','production'].includes(opts.target))throw Error();
  if(opts.target==='production'&&(opts.database!==DATABASE||opts['confirm-database-id']!==DATABASE_ID))throw Error();
  if(opts.target==='local'&&(opts.database||opts['confirm-database-id']))throw Error();
  const databaseName=opts.target==='production'?DATABASE:'voteproof-release-local';
  const databaseId=opts.target==='production'?DATABASE_ID:randomUUID();
  const outputs=[3,4,5,6,7].map(n=>resolve(root,`.wrangler/${opts.target==='production'?'b7.1':'b7-local'}/migrate-${String(n).padStart(4,'0')}`));
  for(const p of outputs){if(existsSync(p))throw Error();execFileSync('git',['check-ignore','--quiet','--',p],{cwd:root,stdio:'ignore',windowsHide:true});}
  const contents=names.map(name=>readFileSync(join(root,'migrations',name)));
  outputs.forEach((folder,index)=>{
    const dir=join(folder,'migrations');mkdirSync(dir,{recursive:true});
    const manifest={};for(let n=0;n<index+3;n++){writeFileSync(join(dir,names[n]),contents[n],{flag:'wx'});manifest[names[n]]=createHash('sha256').update(contents[n]).digest('hex');}
    writeFileSync(join(folder,'wrangler.json'),JSON.stringify({name:'voteproof-release-plan',compatibility_date:'2026-10-07',d1_databases:[{binding:'DB',database_name:databaseName,database_id:databaseId,migrations_dir:dir}]},null,2)+'\n',{flag:'wx'});
    writeFileSync(join(folder,'file-hashes.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  });
  console.log(JSON.stringify({result:'MIGRATION_STAGES_PREPARED_NOT_APPLIED',target:opts.target,remote_execution:false}));
} catch {console.error('MIGRATION_STAGE_PREPARATION_REFUSED');process.exitCode=1;}
