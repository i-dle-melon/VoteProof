// Local/operator REST executor. Never used by the website, never retries.
import fs from 'node:fs';import {digest,stable} from './prelaunch-reset-snapshot.mjs';
import {assessResetCLI} from './prelaunch-reset-cli-plan.mjs';import {verifyRecoveryPoint} from './prelaunch-reset-production.mjs';
export const REST_ATOMIC_PROOF_SHA256='aa9b5d12990d3031a8e42561bcdc2b201e7365ff094074053f136891813b5679';
export const REST_COMPILER_SHA256='d2bdea96de0fab7f466a64a770e6accab10157fb332f12add5012fdca2887d6d';
function verifyProof(file){const r=file?JSON.parse(fs.readFileSync(file)):null;if(!r||digest(r)!==REST_ATOMIC_PROOF_SHA256)throw Error('EXACT_REST_ATOMIC_PROOF_REQUIRED');if(r.status!=='PASS'||r.atomicity!=='PASS_FOR_TESTED_REST_48_BATCHES'||r.parameters!=='PASS_FOR_USED_TYPES'||r.cleanup!=='PASS')throw Error('REST_PROOF_NOT_PASS');if(digest(fs.readFileSync(new URL('./prelaunch-reset-production.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n'))!==REST_COMPILER_SHA256)throw Error('TESTED_COMPILER_CHANGED');}
function checkPlan(p,options){assessResetCLI(p,options);verifyProof(options.proofFile);}
function append(file,state,initial=false){const fd=fs.openSync(file,initial?'wx':'a');try{fs.writeFileSync(fd,stable(state)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function createD1RestTransport({account,database,credential,send=fetch}={}) {
 if(!/^[a-f0-9]{32}$/.test(account??'')||!/^[-a-f0-9]{36}$/.test(database??'')||typeof credential!=='string'||!credential)throw Error('EXPLICIT_D1_TARGET_AND_EXISTING_CREDENTIAL_REQUIRED');
 const endpoint='https://api.cloudflare.com/client/v4/accounts/'+account+'/d1/database/'+database+'/query';
 return {kind:'cloudflare-rest',account,database,async query(statements){
   const response=await send(endpoint,{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},body:JSON.stringify({batch:statements}),redirect:'error',signal:AbortSignal.timeout(30000)});
   const result=await response.json();
   if(!response.ok||result.success!==true||result.errors?.length||!Array.isArray(result.result)||result.result.length!==statements.length||result.result.some(r=>r.success!==true))throw Error('REST_RESPONSE_UNKNOWN_NO_RETRY');
   return result.result;
 }};
}
function authorize(p,{mode,authority,recovery,manifest,transport}){
 if(mode==='local-transport-test'&&transport?.kind==='local-synthetic-rest')return;
 if(mode!=='execute'||transport?.kind!=='cloudflare-rest'||authority?.scope!=='production-selective-reset-once'||authority.operation!=='keep-members-no-r2-delete'||authority.prepared_sha256!==p.sha256||authority.manifest_sha256!==p.manifest_sha256||authority.account!==p.account||authority.database!==p.database||transport.account!==p.account||transport.database!==p.database||!authority.operator_approval_reference||!Number.isFinite(Date.parse(authority.expires_utc))||Date.parse(authority.expires_utc)<=Date.now())throw Error('EXPLICIT_PRODUCTION_RESET_AUTHORITY_REQUIRED');
 const sha=authority.approved_release_sha;
 if(!/^[a-f0-9]{40}$/.test(sha??'')||authority.ci_sha!==sha||authority.deployed_worker_sha!==sha||authority.reset_schema_sha256!=='19054e1e954a03456b7e93052cc3f051f79817380828f35f607ebb5231e04cbe')throw Error('NEW_RELEASE_CI_AND_DEPLOYED_FENCE_EVIDENCE_REQUIRED');
 if(!manifest||manifest.sha256!==p.manifest_sha256||!Array.isArray(manifest.blockers)||manifest.blockers.length||manifest.source_hash!==p.source_hash||!manifest.evidence||manifest.evidence.legacy_io==='LOCAL_SYNTHETIC_ALL_INVOCATIONS_ENDED')throw Error('FROZEN_REVIEWED_NON_SYNTHETIC_MANIFEST_REQUIRED');
 const {sha256,status,...body}=manifest;if(digest(body)!==sha256)throw Error('MANIFEST_HASH_MISMATCH');
 if(manifest.evidence.legacy_io!=='UNKNOWN_ISOLATED_RETAINED_OLD_KEYS'||digest(manifest.evidence.cutover)!==authority.cutover_evidence_sha256||manifest.evidence.cutover.release_sha!==sha||manifest.evidence.cutover.deployment.sha!==sha||manifest.evidence.cutover.ci.sha!==sha||manifest.evidence.cutover.release_ref!==authority.approved_release_ref||manifest.evidence.cutover.ci.ref!==authority.approved_release_ref||manifest.evidence.cutover.deployment.ref!==authority.approved_release_ref)throw Error('APPROVED_CUTOVER_EVIDENCE_LINK_REQUIRED');
 if(recovery?.platform==='native-synthetic')throw Error('PRODUCTION_PRIVATE_RESTORE_PROOF_REQUIRED');
 const verified=verifyRecoveryPoint({hash:p.source_hash},recovery);
 if(verified.account!==p.account||verified.source_database!==p.database||verified.artifact_sha256!==p.restore.artifact_sha256)throw Error('RESTORE_TARGET_MISMATCH');
}
export async function reconcileRestReset(p,{transport}={}) {
 const receipt={sql:'SELECT id,action,detail FROM prelaunch_reset_audit WHERE id=?',params:[p.run_id]};
 const r=await transport.query([p.statements[46],p.statements[47],{sql:'PRAGMA foreign_key_check',params:[]},receipt]);
 if(r[0]?.results?.[0]?.reset_check!=='ok'||r[1]?.results?.[0]?.reset_check!=='ok'||r[2]?.results?.length||r[3]?.results?.length!==1)throw Error('REST_POSTCONDITION_UNVERIFIED');
 const row=r[3].results[0],detail=JSON.parse(row.detail);
 if(row.id!==p.run_id||row.action!=='reset_commit'||detail.manifest!==p.manifest_sha256||detail.old_epoch!==p.epoch||detail.next_epoch!==p.epoch+1)throw Error('IMMUTABLE_RECEIPT_MISMATCH');
 return {status:'COMMIT_VERIFIED',receipt_sha256:digest(row),prepared_sha256:p.sha256,manifest_sha256:p.manifest_sha256,expected_postcondition_sha256:p.postcondition_expected_sha256,epoch:p.epoch+1};
}
export async function executeRestReset(p,options={}) {
 checkPlan(p,options);
 if((options.mode??'dry-run')==='dry-run')return {status:'DRY_RUN',transport:'one parameterized REST batch',statements:48,worker_invocations:0,production_authorized:false,execution_prerequisites:'new approved/deployed fence SHA and same-SHA CI; reviewed non-synthetic frozen Manifest; fresh private restore point; exact one-shot authority'};
 authorize(p,options);
 const file=options.journalFile;if(!file||fs.existsSync(file))throw Error('EXISTING_JOURNAL_REQUIRES_READONLY_RECONCILIATION');
 const state={prepared_sha256:p.sha256,manifest_sha256:p.manifest_sha256,status:'DISPATCHED',utc:new Date().toISOString(),attempts:1};append(file,state,true);
 try{
  const result=await options.transport.query(p.statements);
  if(result.length!==48||result.some(r=>r.success!==true)||[1,46,47].some(i=>result[i].results?.[0]?.reset_check!=='ok'))throw Error('REST_BATCH_ACK_UNVERIFIED');
  const receipt=await reconcileRestReset(p,options);append(file,{...state,status:'COMMITTED',receipt,utc:new Date().toISOString()});return receipt;
 }catch{append(file,{...state,status:'UNKNOWN',automatic_retry:false,utc:new Date().toISOString()});throw Error('RESET_ACK_UNKNOWN_STOP_AND_RECONCILE');}
}
export async function reconcileRestJournal(p,options={}){
 checkPlan(p,options);if(!options.journalFile||!fs.existsSync(options.journalFile))throw Error('EXISTING_JOURNAL_REQUIRED');
 const events=fs.readFileSync(options.journalFile,'utf8').trim().split('\n').map(x=>JSON.parse(x));if(events.some(x=>x.prepared_sha256!==p.sha256||x.manifest_sha256!==p.manifest_sha256))throw Error('JOURNAL_PLAN_MISMATCH');
 const receipt=await reconcileRestReset(p,options),out=options.journalFile+'.readonly-reconciliation.json';if(fs.existsSync(out))throw Error('RECONCILIATION_ALREADY_SAVED');fs.writeFileSync(out,stable(receipt)+'\n',{flag:'wx'});return receipt;
}
