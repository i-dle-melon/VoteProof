// Offline verification of Operator-approved, freshly collected evidence.
// Never declares historical DELETE/ACK complete and never changes D1.
import fs from'node:fs';import{digest}from'./prelaunch-reset-snapshot.mjs';import{RESET_V1_SQL_SHA256}from'../../src/lib/prelaunch-reset-schema.js';
const sql=x=>x.replace(/\r\n/g,'\n').trim().replace(/;$/,'');
export function verifyProductionCutover(snapshot,record,approvedHash){
 if(!record||!approvedHash||digest(record)!==approvedHash)throw Error('EXACT_APPROVED_CUTOVER_EVIDENCE_REQUIRED');
 const c=snapshot.tables.prelaunch_reset_control?.[0],sha=record.release_sha;
 if(record.format!=='reset-cutover-evidence-v1'||record.account!=='7a1ae5a3d1e51008d0880ac526740717'||record.database!=='9e2b885d-66e2-4e4d-b768-4bded261296a'||record.worker!=='voteproof'||!record.operator_approval_reference||!/^[a-f0-9]{40}$/.test(sha??'')||sha==='b3d00e7b2cda988d0c91a166515ce6ebacb0a322')throw Error('NEW_DEPLOYED_SAFETY_RELEASE_REQUIRED');
 const ci=record.ci,deploy=record.deployment;
 if(ci?.sha!==sha||ci.conclusion!=='success'||!record.release_ref||ci.ref!==record.release_ref||!['push','workflow_dispatch'].includes(ci.event)||deploy?.sha!==sha||deploy.ref!==record.release_ref||deploy.active_versions?.length!==1||deploy.active_versions[0].percentage!==100||!/^[a-f0-9-]{36}$/.test(deploy.active_versions[0].id??''))throw Error('SAME_REF_CI_AND_SINGLE_ACTIVE_DEPLOYMENT_REQUIRED');
 if(!Number.isFinite(Date.parse(record.collected_utc))||Date.now()-Date.parse(record.collected_utc)>300000||Date.parse(record.collected_utc)>Date.now()+1000||record.source_hash!==snapshot.hash||record.epoch!==c?.epoch||record.control_version!==c?.version||record.run_id!==c?.run_id||c.mode!=='maintenance')throw Error('FRESH_FROZEN_SOURCE_EVIDENCE_REQUIRED');
 if(record.reset_fence_enabled!==true||record.cleanup_live!==false||record.old_delete_terminal!=='UNKNOWN'||record.old_objects!=='RETAINED'||record.proof_key_protocol!=='trusted-d1-epoch-v1'||record.public_r2?.r2_dev_enabled!==false||!Array.isArray(record.public_r2.custom_domains)||record.public_r2.custom_domains.length)throw Error('ISOLATION_AND_PUBLIC_READ_BARRIER_REQUIRED');
 for(const name of['deployment_metadata','ci_run','bindings_and_flags','public_r2_access'])if(!/^[a-f0-9]{64}$/.test(record.artifact_sha256?.[name]??''))throw Error('RETAINED_RAW_READONLY_EVIDENCE_HASHES_REQUIRED');
 const extension=fs.readFileSync(new URL('../../migrations-reset-v1/0001_reset_fence.sql',import.meta.url),'utf8');
 if(digest(extension.replace(/\r\n/g,'\n'))!==RESET_V1_SQL_SHA256||snapshot.tables.prelaunch_reset_schema_versions?.length!==1||snapshot.tables.prelaunch_reset_schema_versions[0].sql_sha256!==RESET_V1_SQL_SHA256)throw Error('EXACT_RESET_SCHEMA_REQUIRED');
 const expected=[...extension.matchAll(/CREATE TRIGGER\s+(\w+)[\s\S]*?END;/g)];if(expected.length!==199)throw Error('RESET_GUARD_SOURCE_CHANGED');
 for(const match of expected)if(!snapshot.schema.some(r=>r.type==='trigger'&&r.name===match[1]&&sql(r.sql)===sql(match[0])))throw Error('INSTALLED_RESET_GUARD_MISMATCH');
 const baseline=JSON.parse(fs.readFileSync(new URL('../../test/fixtures/reset-0028-schema-reference.json',import.meta.url))).rows.filter(r=>r.sql);
 for(const old of baseline)if(!snapshot.schema.some(r=>r.type===old.type&&r.name===old.name&&sql(r.sql)===sql(old.sql)))throw Error('ORIGINAL_0028_SCHEMA_CHANGED');
 return{approved_cutover_sha256:approvedHash,historical_delete_terminal:'UNKNOWN',isolation:'old objects retained; installed D1 fence and trusted new-key generations',evidence_scope:'Operator-approved readonly artifacts; not newly fetched or authenticated by this offline verifier'};
}
