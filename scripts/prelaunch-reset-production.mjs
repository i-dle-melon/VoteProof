// Default is an offline dry-run. No credential reader, Cloudflare client or
// Production write mode is installed before the isolated atomicity gate passes.
import fs from 'node:fs';import{prepareAtomicReset,executePreparedReset}from'./lib/prelaunch-reset-production.mjs';
const args=process.argv.slice(2),take=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};
if(args.some(x=>['--execute','--remote','--production','--apply'].includes(x)))throw Error('PRODUCTION_EXECUTION_HOLD_CLOUD_ATOMICITY_AND_AUTHORIZATION_REQUIRED');
const file=k=>{const f=take(k);if(!f)throw Error('REQUIRED_PRIVATE_INPUT_'+k);return JSON.parse(fs.readFileSync(f,'utf8'));};
const out=take('--out');if(!out||fs.existsSync(out))throw Error('NEW_PRIVATE_OUTPUT_REQUIRED');
const prepared=prepareAtomicReset(file('--snapshot'),file('--manifest'),{approvedManifestHash:take('--approved-manifest-sha256'),recovery:file('--recovery')});
fs.writeFileSync(out,JSON.stringify(prepared,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(await executePreparedReset(prepared)));
