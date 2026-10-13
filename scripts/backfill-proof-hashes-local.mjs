import path from 'node:path';
import {localCaseRuntime} from './lib/local-case-runtime.mjs';
import {backfillExactHashes} from '../src/lib/proof-exact-hash.js';
// Only an isolated local runtime is available. No Production URL, DB ID or remote switch.
let local;
try{
 const args=process.argv.slice(2),option=name=>args.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
 if(args.some(x=>x!=='--apply-local'&&!/^--(state|limit|after)=/.test(x)))throw Error();
 const root=path.resolve('.wrangler/proof-hash-local'),state=path.resolve(option('state')??root);
 if(state!==root&&!state.startsWith(root+path.sep))throw Error();
 const limit=Number(option('limit')??10),after=option('after')??'';
 local=await localCaseRuntime({seedCampaign:false,submissionsEnabled:false,resourcePersistencePath:state});
 const result=await backfillExactHashes({db:local.db,bucket:local.bucket},{dryRun:!args.includes('--apply-local'),limit,after});
 console.log(JSON.stringify({environment:'LOCAL_ONLY',...result}));
}catch{console.error('LOCAL_PROOF_HASH_BACKFILL_FAILED');process.exitCode=1;}finally{await local?.runtime.dispose();}
