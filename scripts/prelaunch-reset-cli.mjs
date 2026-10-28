// One-command offline dry-run. Remote/execute stays locked pending new proof.
import fs from 'node:fs';import path from 'node:path';
import {assessResetCLI} from './lib/prelaunch-reset-cli-plan.mjs';
const args=process.argv.slice(2),allowed=new Set(['--prepared','--approved-prepared-sha256','--approved-manifest-sha256','--out']);
if(args.some(x=>['--execute','--remote','--apply','--production'].includes(x)))throw Error('CLI_EXECUTION_HOLD_TRANSPORT_ATOMICITY_AND_AUTHORIZATION_REQUIRED');
if(args.length!==8||args.some((v,i)=>i%2===0&&!allowed.has(v)))throw Error('EXACT_DRY_RUN_ARGUMENTS_REQUIRED');
const take=k=>{if(args.filter(x=>x===k).length!==1)throw Error('EXACT_DRY_RUN_ARGUMENTS_REQUIRED');return args[args.indexOf(k)+1];};
const output=path.resolve(take('--out')),repo=path.resolve(new URL('../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')),relative=path.relative(repo,output);
if(fs.existsSync(output)||!output.endsWith('.private')||(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)))throw Error('NEW_PROTECTED_PRIVATE_OUTPUT_OUTSIDE_GIT_REQUIRED');
const p=JSON.parse(fs.readFileSync(take('--prepared'),'utf8'));
const {report,rest}=assessResetCLI(p,{approvedPreparedHash:take('--approved-prepared-sha256'),approvedManifestHash:take('--approved-manifest-sha256')});
// Inherit access protection from Operator-selected private parent directory.
// No SQL file is exported: oversized import statements must never be split.
fs.mkdirSync(output);fs.writeFileSync(output+'/REST-BATCH.private.json',JSON.stringify(rest),{flag:'wx'});fs.writeFileSync(output+'/DRY-RUN.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,mode:report.mode,statements:48,wrangler_file:report.wrangler_file.eligible,oversized_statement_indices:report.wrangler_file.oversized_statement_indices,cloud_requests:0}));
