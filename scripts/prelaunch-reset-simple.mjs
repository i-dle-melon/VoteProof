// Defaults to offline dry-run. All inputs/outputs containing IDs stay private.
import fs from 'node:fs';import path from 'node:path';
import{digest}from'./lib/prelaunch-reset-snapshot.mjs';
import{prepareSimpleReset,executeSimpleReset,reconcileSimpleReset,validateSimpleExecution,createD1RestTransport}from'./lib/prelaunch-reset-simple.mjs';
const load=f=>JSON.parse(fs.readFileSync(f,'utf8'));
try{
 const args=process.argv.slice(2);if(args.length<2||args.length>3||args[0]!=='--package'||args[2]&&!['--prepare','--execute','--reconcile'].includes(args[2]))throw Error('PRIVATE_PACKAGE_REQUIRED');
 const pack=load(args[1]);
 if(args[2]==='--prepare'){
  const p=prepareSimpleReset(load(pack.snapshot_file),load(pack.manifest_file),{approvedManifestHash:pack.approved_manifest_sha256,recovery:load(pack.recovery_file),approvedCutoverHash:pack.approved_cutover_sha256});
  fs.writeFileSync(pack.prepared_file,JSON.stringify(p)+'\n',{flag:'wx'});console.log(JSON.stringify({status:'PREPARED_NOT_AUTHORIZED',prepared_sha256:p.sha256,body_bytes:p.body_bytes,statements:p.statement_count}));
 }else{
  const p=load(pack.prepared_file),o={approvedPreparedHash:pack.approved_prepared_sha256,approvedManifestHash:pack.approved_manifest_sha256,mode:'dry-run'};
  if(!args[2])console.log(JSON.stringify(await executeSimpleReset(p,o)));
  else{
   const a=load(pack.authorization_file),read=args[2]==='--reconcile';
   const{sha256,...body}=p;if(digest(body)!==sha256||pack.approved_prepared_sha256!==sha256||pack.approved_manifest_sha256!==p.manifest_sha256||a.prepared_sha256!==p.sha256||a.manifest_sha256!==p.manifest_sha256||a.scope!==(read?'production-simple-reset-reconcile':'production-simple-reset-once')||!a.operator_approval_reference||!(Date.parse(a.expires_utc)>Date.now()))throw Error('NEW_EXPLICIT_AUTHORITY_REQUIRED');
   Object.assign(o,{mode:'execute',authority:a,transport:{kind:'cloudflare-rest',account:p.account,database:p.database},journalFile:pack.journal_file,simpleProof:load(pack.simple_cloud_proof_file),freeze:load(pack.freeze_file),recovery:read?undefined:load(pack.recovery_file)});
   validateSimpleExecution(p,o,read); // Reject missing proof/restore before auth.
   const resolver=fs.readFileSync(pack.existing_auth_resolver_file,'utf8');if(digest(resolver)!=='e9f279eab7b6a819c0dc0523c08868c45f7a4ace7d19931b10eef24fe9be90bc')throw Error('APPROVED_EXISTING_AUTH_RESOLVER_REQUIRED');
   const candidate=path.resolve(new URL('../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));let credential;
   try{
    credential=await new Function('p','fs','candidate','H','save','stop',`return(async()=>{let credential;${resolver}\nreturn credential})()`)(path,fs,candidate,digest,()=>{},c=>{throw Error(c);});
    o.transport=createD1RestTransport({account:p.account,database:p.database,credential});
    console.log(JSON.stringify(read?await reconcileSimpleReset(p,o):await executeSimpleReset(p,o)));
   }finally{credential=undefined;}
  }
 }
}catch(e){console.error(JSON.stringify({status:'HOLD',code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'SIMPLE_CLI_ERROR_NO_RETRY'}));process.exitCode=1;}
