// Generates a reviewable plan only. No fetch, Wrangler, DB or R2 execution.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { adminBootstrapPlan, campaignBootstrapPlan, legacyCleanupPlan, DATABASE, DATABASE_ID } from './lib/release-plans.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const builders={admin:adminBootstrapPlan,campaign:campaignBootstrapPlan,legacy:legacyCleanupPlan};
try {
  const args=process.argv.slice(2), opts={target:'local'}, seen=new Set();
  for(let i=0;i<args.length;i+=2){const name=args[i]?.replace(/^--/,'');if(!['kind','input','output','target','database','confirm-database-id','confirm-cleanup-plan'].includes(name)||seen.has(name)||!args[i+1])throw Error();seen.add(name);opts[name]=args[i+1];}
  if(!builders[opts.kind]||!opts.input||!opts.output||!['local','production'].includes(opts.target))throw Error();
  if(opts.target==='production'&&(opts.database!==DATABASE||opts['confirm-database-id']!==DATABASE_ID))throw Error();
  if(opts.target==='local'&&(opts.database||opts['confirm-database-id']))throw Error();
  if(opts.kind==='legacy'&&opts['confirm-cleanup-plan']!=='PREPARE_ONLY_NO_EXECUTION')throw Error();
  if(opts.kind!=='legacy'&&seen.has('confirm-cleanup-plan'))throw Error();
  const output=resolve(root,opts.output), rel=relative(root,output);
  if(isAbsolute(rel)||rel.startsWith('..')||!rel.replaceAll('\\','/').startsWith('.wrangler/')||existsSync(output))throw Error();
  execFileSync('git',['check-ignore','--quiet','--',rel],{cwd:root,stdio:'ignore',windowsHide:true});
  const input=resolve(root,opts.input), inputRel=relative(root,input);
  if(!isAbsolute(inputRel)&&!inputRel.startsWith('..'))execFileSync('git',['check-ignore','--quiet','--',inputRel],{cwd:root,stdio:'ignore',windowsHide:true});
  const plan=builders[opts.kind](JSON.parse(readFileSync(input,'utf8')));
  if(plan.r2_keys&&existsSync(output+'.r2.json'))throw Error();
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,`-- OFFLINE PLAN. Review and separately authorize execution. Target: ${opts.target}\n${plan.sql}\n`,{flag:'wx',mode:0o600});
  // Object keys remain in a private companion file; never console output.
  if(plan.r2_keys){const inventory=output+'.r2.json';if(existsSync(inventory))throw Error();writeFileSync(inventory,JSON.stringify({bucket:'voteproof-proofs',keys:plan.r2_keys},null,2)+'\n',{flag:'wx',mode:0o600});}
  console.log(JSON.stringify({result:'PREPARED_NOT_EXECUTED',kind:plan.kind,target:opts.target,remote_execution:false}));
} catch {console.error('RELEASE_PLAN_REFUSED');process.exitCode=1;}
