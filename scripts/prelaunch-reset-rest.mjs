// Default OFFLINE dry-run. Execution/reconciliation needs an explicit private
// package; this command does not deploy, freeze, migrate, reopen or touch R2.
import fs from'node:fs';import path from'node:path';import{digest}from'./lib/prelaunch-reset-snapshot.mjs';
import{createD1RestTransport,executeRestReset,reconcileRestJournal}from'./lib/prelaunch-reset-rest.mjs';
try{
const args=process.argv.slice(2);if(![2,3].includes(args.length)||args[0]!=='--package'||args[2]&&!['--execute','--reconcile'].includes(args[2]))throw Error('PRIVATE_PACKAGE_REQUIRED_DEFAULT_DRY_RUN');
const load=file=>JSON.parse(fs.readFileSync(file,'utf8')),pack=load(args[1]),prepared=load(pack.prepared_file),options={approvedPreparedHash:pack.approved_prepared_sha256,approvedManifestHash:pack.approved_manifest_sha256,proofFile:pack.rest_atomic_proof_file,mode:'dry-run'};
if(args.length===2){console.log(JSON.stringify(await executeRestReset(prepared,options)));}
else{
 const mode=args[2],authority=load(pack.authorization_file);
 // Reject missing human write/read scope BEFORE credential resolution.
 if(authority.prepared_sha256!==prepared.sha256||authority.manifest_sha256!==prepared.manifest_sha256||!authority.operator_approval_reference||!Number.isFinite(Date.parse(authority.expires_utc))||Date.parse(authority.expires_utc)<=Date.now()||authority.scope!==(mode==='--execute'?'production-selective-reset-once':'production-reset-reconcile-readonly'))throw Error('NEW_EXPLICIT_OPERATOR_AUTHORIZATION_REQUIRED');
 const resolver=fs.readFileSync(pack.existing_auth_resolver_file,'utf8');if(digest(resolver)!=='e9f279eab7b6a819c0dc0523c08868c45f7a4ace7d19931b10eef24fe9be90bc')throw Error('APPROVED_WRANGLER_AUTH_RESOLVER_REQUIRED');
 const candidate=path.resolve(new URL('../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')),H=digest,stop=c=>{throw Error(c);},save=()=>{};
 let credential;try{
  credential=await new Function('p','fs','candidate','H','save','stop',`return(async()=>{let credential;${resolver}\nreturn credential})()`)(path,fs,candidate,H,save,stop);
  const transport=createD1RestTransport({account:prepared.account,database:prepared.database,credential});
  const input={...options,transport,journalFile:pack.journal_file,mode:'execute',authority,manifest:load(pack.manifest_file),recovery:mode==='--execute'?load(pack.recovery_file):undefined};
  const result=mode==='--execute'?await executeRestReset(prepared,input):await reconcileRestJournal(prepared,input);console.log(JSON.stringify(result));
 }finally{credential=undefined;}
}
}catch(error){const code=/^[A-Z0-9_]+$/.test(error.message)?error.message:'REST_CLI_LOCAL_OR_AUTH_ERROR';console.error(JSON.stringify({status:'HOLD',code}));process.exitCode=1;}
