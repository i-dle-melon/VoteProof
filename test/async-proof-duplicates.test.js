import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {claimDuplicateJob,processDuplicateJob,failDuplicateJob,reconcileDuplicateGroup,CANONICAL_SQL} from '../src/lib/proof-duplicate-processor.js';
import {adminExactEvidence} from '../src/lib/proof-exact-hash.js';
import {backfillExactHashes} from '../src/lib/proof-exact-hash.js';
import {guestBody} from '../scripts/lib/local-case-runtime.mjs';
import {exactProofCorpus,syntheticProofBytes} from './fixtures/exact-proof-corpus.js';
let h,local;const secret=randomBytes(32).toString('hex');
before(async()=>{h=await localAdminRuntime({duplicateProcessorSecret:secret});local=h.local;});
after(async()=>await local?.runtime.dispose());
const now=()=>Math.floor(Date.now()/1000);
async function proof(member,campaign='LOCAL-TEST'){
  const c=await h.makeCase({member,metadata:{campaign_id:campaign}});
  const job=await local.db.prepare('SELECT j.* FROM proof_duplicate_jobs j WHERE case_internal_id=?').bind(c.id).first();
  assert.equal(job.state,member?'pending':'not_applicable');return {...c,job};
}
async function claimFile(file,token=randomUUID(),at=now()){
  // Isolate one synthetic job while exercising the actual race-safe claim SQL.
  await local.db.prepare("UPDATE proof_duplicate_jobs SET next_attempt_at=? WHERE state IN('pending','failed') AND file_id!=?").bind(at+100000,file).run();
  await local.db.prepare("UPDATE proof_duplicate_jobs SET lease_until=? WHERE state='processing' AND file_id!=?").bind(at+100000,file).run();
  await local.db.prepare('UPDATE proof_duplicate_jobs SET next_attempt_at=0 WHERE file_id=?').bind(file).run();
  const job=await claimDuplicateJob(local.db,token,at);assert.equal(job?.file_id,file);return job;
}
async function finish(p){const job=await claimFile(p.job.file_id);return processDuplicateJob(local.db,job);}
const saved=file=>local.db.prepare('SELECT * FROM proof_duplicate_jobs WHERE file_id=?').bind(file).first();
for(const [label,otherMember,otherCampaign,expected] of [
  ['same member same Campaign',false,false,'exact_duplicate'],
  ['same member different Campaign',false,true,'clear'],
  ['different member same Campaign',true,false,'clear'],
  ['different member different Campaign',true,true,'clear'],
])test('V1 scope: '+label,async()=>{
  const m=await h.identity(),n=otherMember?await h.identity():m,campaign='SCOPE-'+randomUUID(),a=await proof(m,campaign),b=await proof(n,otherCampaign?'OTHER-'+randomUUID():campaign);
  await finish(b);await finish(a);const result=await saved(b.job.file_id);assert.equal(result.state,expected);
  assert.equal(result.canonical_file_id,expected==='exact_duplicate'?a.job.file_id:null);
  const evidence=await adminExactEvidence(local.db,b.id);assert.equal(evidence.matches.length,expected==='exact_duplicate'?1:0);
  assert.ok(!JSON.stringify(evidence).includes(m.memberId));assert.ok(!JSON.stringify(evidence).includes(result.sha256));
  assert.ok(evidence.matches.every(x=>x.relationship==='same_member_same_campaign'));
});
for(const count of [2,5,20])for(const order of ['forward','reverse','random'])test(`${count} rapid identical copies / ${order}: canonical is independent of processing`,async()=>{
  const member=await h.identity(),campaign='RACE-'+randomUUID(),all=[];
  for(let i=0;i<count;i++)all.push(await proof(member,campaign));
  const canonical=[...all].sort((a,b)=>a.job.case_created_at.localeCompare(b.job.case_created_at)||a.id.localeCompare(b.id)||a.job.file_id.localeCompare(b.job.file_id))[0];
  const sequence=order==='reverse'?[...all].reverse():order==='random'?[...all].sort((a,b)=>a.job.file_id.localeCompare(b.job.file_id)):all;
  for(const p of sequence)await finish(p);
  for(const p of all){const row=await saved(p.job.file_id);assert.equal(row.state,p===canonical?'clear':'exact_duplicate');assert.equal(row.canonical_file_id,p===canonical?null:canonical.job.file_id);}
  const replay=await local.fetch('/api/cases','POST',all[0].body,all[0].headers);assert.equal(replay.status,201);assert.equal((await replay.json()).data.case_id,all[0].case_id);
});
test('same timestamp tie uses stable case ID; late earlier source invalidates results and active leases',async()=>{
  const member=await h.identity(),campaign='TIE-'+randomUUID(),a=await proof(member,campaign),b=await proof(member,campaign);
  await finish(a);const active=await claimFile(b.job.file_id);
  // Recreate trusted hash metadata after an authoritative equal timestamp, as a
  // synthetic delayed hash/backfill. No fake client SHA enters the source table.
  await local.db.prepare('DELETE FROM proof_exact_hashes WHERE file_id IN (?,?)').bind(a.job.file_id,b.job.file_id).run();
  const date='2020-01-01T00:00:00.000Z';
  await local.db.prepare('UPDATE cases SET created_at=? WHERE id IN (?,?)').bind(date,a.id,b.id).run();
  const enqueue=async p=>local.db.prepare(`INSERT INTO proof_exact_hashes(file_id,sha256,verified_at,source_etag,source_size,case_created_at,case_internal_id)
    VALUES(?,?,?,?,?,?,?)`).bind(p.job.file_id,p.job.sha256,date,(await local.db.prepare('SELECT etag FROM case_files WHERE id=?').bind(p.job.file_id).first()).etag,
      (await local.db.prepare('SELECT size FROM case_files WHERE id=?').bind(p.job.file_id).first()).size,date,p.id).run();
  const first=a.id<b.id?a:b,last=first===a?b:a;
  await enqueue(last);await finish(last);assert.equal((await saved(last.job.file_id)).state,'clear');
  await enqueue(first);assert.equal((await adminExactEvidence(local.db,last.id)).analyses[0].state,'pending');
  for(let i=0;i<3;i++)await reconcileDuplicateGroup(local.db);assert.equal((await saved(last.job.file_id)).state,'pending');
  assert.equal((await processDuplicateJob(local.db,active)).state,'lease_conflict');
  await finish(last);await finish(first);assert.equal((await saved(last.job.file_id)).canonical_file_id,first.job.file_id);
});
test('duplicate enqueue is idempotent; double claim, active lease, crash, expiry and lost ACK recover',async()=>{
  const p=await proof(await h.identity(),'LEASE-'+randomUUID()),token=randomUUID(),t=now();
  const row=await local.db.prepare('SELECT * FROM proof_exact_hashes WHERE file_id=?').bind(p.job.file_id).first();
  await local.db.prepare('INSERT INTO proof_exact_hashes(file_id,sha256,verified_at,source_etag,source_size,case_created_at,case_internal_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(file_id) DO NOTHING')
    .bind(row.file_id,row.sha256,row.verified_at,row.source_etag,row.source_size,row.case_created_at,row.case_internal_id).run();
  assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM proof_duplicate_jobs WHERE file_id=?').bind(row.file_id).first()).n,1);
  const job=await claimFile(row.file_id,token,t);
  const [same,other]=await Promise.all([claimDuplicateJob(local.db,token,t),claimDuplicateJob(local.db,randomUUID(),t)]);
  assert.equal(same.attempts,1);assert.notEqual(other?.file_id,job.file_id);
  const reclaimed=await claimFile(row.file_id,randomUUID(),t+121);assert.equal(reclaimed.attempts,2);
  assert.equal((await processDuplicateJob(local.db,job,t+121)).state,'lease_expired');
  assert.equal((await processDuplicateJob(local.db,reclaimed,t+121)).state,'clear');
  const replay=await claimDuplicateJob(local.db,reclaimed.lease_token,t+122);assert.equal(replay.state,'clear');assert.equal(replay.attempts,2);
  assert.equal((await processDuplicateJob(local.db,replay,t+122)).state,'clear');
  assert.equal((await saved(row.file_id)).attempts,2);
});
test('concurrent DISTINCT requests can claim the same available proof only once',async()=>{
  const p=await proof(await h.identity(),'CLAIM-'+randomUUID()),t=now();
  await local.db.prepare("UPDATE proof_duplicate_jobs SET next_attempt_at=? WHERE state IN('pending','failed') AND file_id!=?").bind(t+100000,p.job.file_id).run();
  const jobs=await Promise.all(Array.from({length:8},()=>claimDuplicateJob(local.db,randomUUID(),t)));
  assert.equal(jobs.filter(j=>j?.file_id===p.job.file_id).length,1);
});
test('failure does not change case/review/points/Drive; retry succeeds; unknown never becomes clear',async()=>{
  const p=await proof(await h.identity(),'FAIL-'+randomUUID()),t=now(),job=await claimFile(p.job.file_id,randomUUID(),t);
  const snapshot=async()=>({case:await local.db.prepare('SELECT status,points_awarded,duplicate_flag FROM cases WHERE id=?').bind(p.id).first(),
    points:(await local.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,backups:(await local.db.prepare('SELECT COUNT(*) n FROM proof_backups').first()).n});
  const before=await snapshot();await failDuplicateJob(local.db,job,'raw secret SQL failure',t);
  let row=await saved(job.file_id);assert.equal(row.state,'failed');assert.equal(row.last_error,'PROCESSOR_UNAVAILABLE');assert.ok(row.next_attempt_at>t);
  assert.equal((await adminExactEvidence(local.db,p.id)).analyses[0].state,'failed');assert.deepEqual(await snapshot(),before);
  const retry=await claimFile(job.file_id,randomUUID(),row.next_attempt_at);await processDuplicateJob(local.db,retry,row.next_attempt_at);
  assert.equal((await saved(job.file_id)).state,'clear');assert.deepEqual(await snapshot(),before);
});
test('max attempts and final crashed lease become terminal failed; no permanent processing',async()=>{
  const p=await proof(await h.identity(),'MAX-'+randomUUID());let t=now();
  for(let i=0;i<5;i++){const job=await claimFile(p.job.file_id,randomUUID(),t);assert.equal(job.attempts,i+1);if(i<4)await failDuplicateJob(local.db,job,'PROCESSOR_UNAVAILABLE',t);t+=121;}
  await claimDuplicateJob(local.db,randomUUID(),t);const row=await saved(p.job.file_id);
  assert.equal(row.state,'failed');assert.equal(row.last_error,'ATTEMPTS_EXHAUSTED');assert.equal(row.next_attempt_at,null);
});
test('processor SQL exception keeps valid submission and sanitized retryable failure',async()=>{
  const p=await proof(await h.identity(),'ERROR-'+randomUUID()),job=await claimFile(p.job.file_id);
  const facade={prepare(sql){if(sql.startsWith('WITH original'))throw Error(secret);return local.db.prepare(sql);}};
  assert.equal((await processDuplicateJob(facade,job)).state,'failed');assert.equal((await saved(job.file_id)).last_error,'PROCESSOR_UNAVAILABLE');
  assert.equal((await local.db.prepare('SELECT status FROM cases WHERE id=?').bind(p.id).first()).status,'pending');
  const malformed=await proof(await h.identity(),'BAD-'+randomUUID()),bad=await claimFile(malformed.job.file_id);
  assert.equal((await processDuplicateJob(local.db,{...bad,sha256:'0'.repeat(64)})).state,'failed');
  assert.equal((await saved(bad.file_id)).last_error,'SOURCE_CHANGED');assert.equal((await saved(bad.file_id)).next_attempt_at,null);
});
test('authenticated bounded endpoint: disabled, no job, authorization, Origin, query, replay; no secrets in response/source logs',async()=>{
  const path='/api/internal/proof-duplicates/process',body={request_id:randomUUID()},authorization={Authorization:'Bearer '+secret};
  assert.equal((await local.fetch(path,'POST',body)).status,401);
  assert.equal((await local.fetch(path,'POST',body,{Authorization:'Bearer '+randomBytes(32).toString('hex')})).status,401);
  assert.equal((await local.fetch(path+'?secret=forbidden','POST',body,authorization)).status,403);
  assert.equal((await local.fetch(path,'POST',body,{...authorization,Origin:'https://voteproof.example'})).status,403);
  assert.equal((await local.fetch(path,'POST',{...body,sha256:'0'.repeat(64)},authorization)).status,400);
  const p=await proof(await h.identity(),'ENDPOINT-'+randomUUID());await local.db.prepare("UPDATE proof_duplicate_jobs SET next_attempt_at=? WHERE state IN('pending','failed') AND file_id!=?").bind(now()+100000,p.job.file_id).run();
  const request={request_id:randomUUID()},first=await local.fetch(path,'POST',request,authorization),text=await first.text();assert.equal(first.status,200);assert.ok(!text.includes(secret));assert.ok(!text.includes(p.job.sha256));
  const second=await local.fetch(path,'POST',request,authorization);assert.deepEqual(await second.json(),JSON.parse(text));
  assert.equal((await (await local.fetch(path,'POST',{request_id:randomUUID()},authorization)).json()).data.state,'idle');
  const source=await readFile(new URL('../src/api/internal-proof-duplicates.js',import.meta.url),'utf8');assert.doesNotMatch(source,/console\.|searchParams/);
  const off=await localAdminRuntime();try{assert.equal((await off.local.fetch(path,'POST',body,authorization)).status,503);}finally{await off.local.runtime.dispose();}
});
test('scope index is a bounded covering seek; schema blocks cross-scope canonical and forged job',async()=>{
  const p=await proof(await h.identity(),'INDEX-'+randomUUID()),q=await proof(await h.identity(),'INDEX-'+randomUUID());
  const plan=(await local.db.prepare('EXPLAIN QUERY PLAN '+CANONICAL_SQL).bind(p.job.member_id,p.job.campaign_id,p.job.sha256).all()).results.map(r=>r.detail).join('\n');
  assert.match(plan,/SEARCH proof_duplicate_jobs USING COVERING INDEX idx_duplicate_scope/);assert.doesNotMatch(plan,/SCAN proof_duplicate_jobs/);
  await assert.rejects(local.db.prepare("UPDATE proof_duplicate_jobs SET state='exact_duplicate',canonical_file_id=?,canonical_case_id=? WHERE file_id=?").bind(q.job.file_id,q.id,p.job.file_id).run());
  await assert.rejects(local.db.prepare('UPDATE proof_duplicate_jobs SET sha256=? WHERE file_id=?').bind('a'.repeat(64),p.job.file_id).run());
  assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await local.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
});
test('mixed batch 20: renamed exact file only; same-size/one-byte/reencoded/unique files clear',async()=>{
  const member=await h.identity(),campaign='MIXED-'+randomUUID(),corpus=exactProofCorpus();await local.campaign({campaign_id:campaign});
  const files=[corpus.original.bytes,corpus.renamed.bytes,corpus.equal_size_different.bytes,corpus.one_byte.bytes,corpus.reencoded_visual_equivalent.bytes,
    ...Array.from({length:15},(_,i)=>syntheticProofBytes(1024,500+i))],all=[];
  for(const [i,bytes] of files.entries()){
    const prepared=await local.fetch('/api/uploads/prepare','POST',{turnstile_token:randomUUID(),files:[{name:'renamed-'+i+'.png',type:'image/png',size:bytes.length,algorithm:'sha256',sha256:createHash('sha256').update(bytes).digest('hex')}]});
    assert.equal(prepared.status,200);const upload=(await prepared.json()).data,u=upload.uploads[0],ref={session_id:upload.session_id,keys:[u.key]};await local.put(u,bytes);assert.equal((await local.fetch('/api/uploads/complete','POST',ref)).status,200);
    const body={...guestBody(ref),campaign_id:campaign},headers={...member.headers,'Idempotency-Key':randomUUID()},response=await local.fetch('/api/cases','POST',body,headers);assert.equal(response.status,201);const data=(await response.json()).data;
    const job=await local.db.prepare('SELECT j.* FROM proof_duplicate_jobs j JOIN cases c ON c.id=j.case_internal_id WHERE c.case_id=?').bind(data.case_id).first();all.push({job,body,headers,case_id:data.case_id});
  }
  for(const p of [...all].reverse())await finish(p);
  for(let i=0;i<20;i++){const row=await saved(all[i].job.file_id);assert.equal(row.state,i===1?'exact_duplicate':'clear');if(i===1)assert.equal(row.canonical_file_id,all[0].job.file_id);}
  for(const p of all){const replay=await local.fetch('/api/cases','POST',p.body,p.headers);assert.equal((await replay.json()).data.case_id,p.case_id);}
  assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases WHERE member_id=?').bind(member.memberId).first()).n,20);
});
test('historical synthetic dry-run/exclusion/resume changes no review or points; enqueue once',async()=>{
  const a=await proof(await h.identity(),'HISTORY-'+randomUUID()),b=await proof(await h.identity(),'HISTORY-'+randomUUID());
  await local.db.prepare('DELETE FROM proof_exact_hashes WHERE file_id IN (?,?)').bind(a.job.file_id,b.job.file_id).run();
  const preview=await backfillExactHashes({db:local.db,bucket:local.bucket},{dryRun:true,limit:20,excludeCases:[a.case_id]});assert.equal(preview.written,0);assert.ok(!preview.results.some(x=>x.file_id===a.job.file_id));assert.ok(preview.results.some(x=>x.file_id===b.job.file_id));
  const result=await backfillExactHashes({db:local.db,bucket:local.bucket},{dryRun:false,limit:20,excludeCases:[a.case_id]});assert.ok(result.results.some(x=>x.file_id===b.job.file_id&&x.written===1));
  assert.equal(await saved(a.job.file_id),null);assert.equal((await saved(b.job.file_id)).state,'pending');assert.equal((await backfillExactHashes({db:local.db,bucket:local.bucket},{dryRun:false,excludeCases:[a.case_id]})).written,0);
  assert.equal((await local.db.prepare('SELECT status,points_awarded FROM cases WHERE id=?').bind(b.id).first()).status,'pending');
});
test('classification lost commit ACK is replay-safe and failure callback cannot overwrite completed result',async()=>{
  const p=await proof(await h.identity(),'ACK-'+randomUUID()),job=await claimFile(p.job.file_id);
  const facade={prepare(sql){const statement=local.db.prepare(sql);if(!sql.startsWith('WITH original'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async run(){await bound.run();throw Error('lost synthetic acknowledgement');}};}};}};
  assert.equal((await processDuplicateJob(facade,job)).state,'clear');await failDuplicateJob(local.db,job);assert.equal((await saved(job.file_id)).state,'clear');
  assert.equal((await processDuplicateJob(local.db,await claimDuplicateJob(local.db,job.lease_token))).state,'clear');assert.equal((await saved(job.file_id)).attempts,1);
});
