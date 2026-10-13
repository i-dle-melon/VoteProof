import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {guestBody} from '../scripts/lib/local-case-runtime.mjs';
import {proofHashStream,exactRelationship,adminExactEvidence,backfillExactHashes} from '../src/lib/proof-exact-hash.js';
import {exactProofCorpus} from './fixtures/exact-proof-corpus.js';
const corpus=exactProofCorpus(),digest=b=>createHash('sha256').update(b).digest('hex');
async function streamed(bytes){const h=proofHashStream(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(new Uint8Array(bytes.slice(i,i+7)));c.close();}}),bytes.length);await new Response(h.stream).arrayBuffer();return h.digest();}
for(const key of ['original','identical','renamed','different_name_metadata'])test('Exact deterministic bytes independent of client name '+key,async()=>assert.equal(await streamed(corpus[key].bytes),digest(corpus.original.bytes)));
for(const key of ['equal_size_different','one_byte','reencoded_visual_equivalent'])test('Does not match '+key,async()=>assert.notEqual(await streamed(corpus[key].bytes),digest(corpus.original.bytes)));
test('Equal size alone is not evidence',()=>assert.equal(corpus.original.bytes.length,corpus.equal_size_different.bytes.length));
test('Rejects incomplete/overlong hash stream and digest before read',async()=>{
 const h=proofHashStream(new Response(new Uint8Array([1,2])).body,3);assert.throws(()=>h.digest(),/INCOMPLETE/);await assert.rejects(new Response(h.stream).arrayBuffer(),/SOURCE_CHANGED/);
 const over=proofHashStream(new Response(new Uint8Array([1,2])).body,1);await assert.rejects(new Response(over.stream).arrayBuffer(),/SOURCE_CHANGED/);
 assert.throws(()=>proofHashStream(new Response('x').body,5242881),/SOURCE_CHANGED/);
});
for(const [a,b,expected] of [[['A','C'],['A','C'],'same_member_same_campaign'],[['A','C'],['B','C'],'cross_member_exact'],[['A','C'],['A','D'],'same_member_other_campaign'],[[null,'C'],[null,'C'],'guest_exact_unknown']])test('Relationship '+expected,()=>assert.equal(exactRelationship({member_id:a[0],campaign_id:a[1]},{member_id:b[0],campaign_id:b[1]}).relationship,expected));

let h,local,admin;
before(async()=>{h=await localAdminRuntime();local=h.local;admin=await h.identity({role:'admin'});});
after(async()=>await local?.runtime.dispose());
async function prepare(fixture=corpus.original){const r=await local.fetch('/api/uploads/prepare','POST',{turnstile_token:randomUUID(),files:[{name:fixture.name,type:'image/png',size:fixture.bytes.length}]});assert.equal(r.status,200);const p=(await r.json()).data;
 const ref={session_id:p.session_id,keys:p.uploads.map(x=>x.key)};await local.bucket.put(ref.keys[0],fixture.bytes,{httpMetadata:{contentType:'image/png'}});
 assert.equal((await local.fetch('/api/uploads/complete','POST',ref)).status,200);return ref;}
async function submit({member,fixture=corpus.original,campaign='LOCAL-TEST',reference,key=randomUUID()}={}){if(campaign!=='LOCAL-TEST')await local.campaign({campaign_id:campaign});const ref=reference??await prepare(fixture);
 const r=await local.fetch('/api/cases','POST',{...guestBody(ref),campaign_id:campaign},{...member?.headers,'Idempotency-Key':key});assert.equal(r.status,201);const created=(await r.json()).data;
 const row=await local.db.prepare('SELECT * FROM cases WHERE case_id=?').bind(created.case_id).first();return {created,row,ref,key};}
test('Server archival computes exact hash; public response contains neither digest nor match identities',async()=>{
 const x=await submit(),f=await local.db.prepare('SELECT h.*,f.object_key FROM proof_exact_hashes h JOIN case_files f ON f.id=h.file_id WHERE f.case_id=?').bind(x.row.id).first();
 assert.equal(f.sha256,digest(corpus.original.bytes));assert.equal(f.algorithm,'sha256');assert.equal(f.version,1);assert.ok(f.verified_at);assert.ok(f.source_etag);
 assert.deepEqual(Object.keys(x.created).sort(),['case_id','query_key','status']);assert.equal(x.row.duplicate_flag,0);assert.equal(x.row.status,'pending');assert.equal(x.row.points_awarded,0);
 const publicCase=await (await local.fetch('/api/cases/'+x.created.case_id+'?key='+x.created.query_key)).text();assert.ok(!publicCase.includes(f.sha256));
});
for(const [name,otherMember,otherCampaign,expected] of [['same member/campaign',false,false,'same_member_same_campaign'],['different member',true,false,'cross_member_exact'],['different campaign',false,true,'same_member_other_campaign']])test('Admin exact evidence '+name,async()=>{
 const m=await h.identity(),n=otherMember?await h.identity():m,first=await submit({member:m}),second=await submit({member:n,fixture:corpus.renamed,campaign:otherCampaign?'LOCAL-OTHER':'LOCAL-TEST'});
 const response=await local.fetch('/api/admin/cases/'+second.created.case_id,'GET',undefined,admin.headers);assert.equal(response.status,200);
 const e=(await response.json()).data.duplicate_evidence,match=e.matches.find(x=>x.previous_case_id===first.created.case_id);assert.equal(match.relationship,expected);assert.equal(e.policy,'review_evidence_only');
 assert.ok(match.previous_submitted_at);assert.equal(match.previous_status,'pending');assert.ok(!JSON.stringify(e).includes(m.memberId));assert.ok(!JSON.stringify(e).includes(n.memberId));assert.ok(!JSON.stringify(e).includes(digest(corpus.original.bytes)));
 assert.equal(second.row.status,'pending');assert.equal(second.row.duplicate_flag,0);assert.equal(second.row.points_awarded,0);
});
test('Future proof never appears in an older case evidence and current proof is excluded',async()=>{const m=await h.identity(),old=await submit({member:m}),later=await submit({member:m});const e=await adminExactEvidence(local.db,old.row.id);assert.ok(!e.matches.some(x=>x.previous_case_id===old.created.case_id||x.previous_case_id===later.created.case_id));});
test('Twenty independent image cases preserve independent hashes, review, points and replay',async()=>{
 await local.campaign({campaign_id:'LOCAL-SCORING',points_per_proof:10,daily_limit:null});
 const m=await h.identity(),all=[];for(let i=0;i<20;i++)all.push(await submit({member:m,campaign:'LOCAL-SCORING',fixture:i%2?corpus.renamed:corpus.original}));
 assert.equal(new Set(all.map(x=>x.created.case_id)).size,20);const replay=await submit({member:m,campaign:'LOCAL-SCORING',reference:all[0].ref,key:all[0].key});assert.deepEqual(replay.created,all[0].created);
 const rows=(await local.db.prepare('SELECT c.status,c.points_awarded,c.duplicate_flag,f.id,h.sha256 FROM cases c JOIN case_files f ON f.case_id=c.id JOIN proof_exact_hashes h ON h.file_id=f.id WHERE c.member_id=?').bind(m.memberId).all()).results;
 assert.equal(rows.length,20);assert.ok(rows.every(x=>x.status==='pending'&&x.points_awarded===0&&x.duplicate_flag===0&&x.sha256===digest(corpus.original.bytes)));
 const evidence=await adminExactEvidence(local.db,all.at(-1).row.id);assert.equal(evidence.matches.filter(x=>x.same_member).length,19);
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM point_transactions WHERE member_id=?').bind(m.memberId).first()).n,0);
 const review=await local.fetch('/api/admin/cases/'+all[0].created.case_id+'/review','POST',{action:'approve',expected_version:0,reason:'Independent synthetic review'},admin.headers);assert.equal(review.status,200);
 const states=(await local.db.prepare('SELECT status,COUNT(*) n FROM cases WHERE member_id=? GROUP BY status').bind(m.memberId).all()).results;
 assert.equal(states.find(x=>x.status==='approved').n,1);assert.equal(states.find(x=>x.status==='pending').n,19);
 assert.equal((await local.db.prepare('SELECT SUM(points) points FROM point_transactions WHERE member_id=?').bind(m.memberId).first()).points,10);
});
test('Failed prepare and complete create no business duplicate event',async()=>{
 const before=(await local.db.prepare('SELECT COUNT(*) n FROM proof_exact_hashes').first()).n;
 assert.equal((await local.fetch('/api/uploads/prepare','POST',{files:[]})).status,400);
 const r=await local.fetch('/api/uploads/complete','POST',{session_id:randomUUID(),keys:[]});assert.equal(r.status,400);
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM proof_exact_hashes').first()).n,before);
});
test('Additive migration has non-unique lookup and rejects digest forgery/source mismatch',async()=>{
 const x=await submit(),f=await local.db.prepare('SELECT h.* FROM proof_exact_hashes h JOIN case_files f ON f.id=h.file_id WHERE f.case_id=?').bind(x.row.id).first();
 assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM proof_exact_hashes WHERE sha256=?").bind(f.sha256).first()).n>1,true);
 const index=(await local.db.prepare("PRAGMA index_list('proof_exact_hashes')").all()).results.find(x=>x.name==='idx_proof_exact_hash_lookup');assert.equal(index.unique,0);
 await assert.rejects(local.db.prepare('UPDATE proof_exact_hashes SET sha256=? WHERE file_id=?').bind('a'.repeat(64),f.file_id).run());
 await local.db.prepare('DELETE FROM proof_exact_hashes WHERE file_id=?').bind(f.file_id).run();
 for(const [hash,etag] of [['z'.repeat(64),f.source_etag],['a'.repeat(64),'changed']])await assert.rejects(local.db.prepare('INSERT INTO proof_exact_hashes(file_id,sha256,verified_at,source_etag,source_size) VALUES(?,?,?,?,?)').bind(f.file_id,hash,new Date().toISOString(),etag,f.source_size).run());
});
test('Local dry-run/bounded/resumable hash backfill changes only hashes and is idempotent',async()=>{
 const targets=[await submit(),await submit(),await submit()];for(const x of targets)await local.db.prepare('DELETE FROM proof_exact_hashes WHERE file_id IN (SELECT id FROM case_files WHERE case_id=?)').bind(x.row.id).run();
 const before={cases:(await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,points:(await local.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,r2:(await local.bucket.list()).objects.map(x=>[x.key,x.etag])};
 const facade={db:local.db,bucket:{get:(...args)=>local.bucket.get(...args),put(){throw Error('FORBIDDEN_R2_WRITE');},delete(){throw Error('FORBIDDEN_R2_DELETE');}}};
 const preview=await backfillExactHashes(facade,{dryRun:true,limit:2});assert.equal(preview.scanned,2);assert.equal(preview.written,0);assert.ok(preview.next_cursor);
 let cursor='',written=0;do{const r=await backfillExactHashes(facade,{dryRun:false,limit:2,after:cursor});assert.ok(r.results.every(x=>x.state==='verified'));written+=r.written;cursor=r.next_cursor;}while(cursor);
 assert.equal(written,4);assert.equal((await backfillExactHashes(facade,{dryRun:false})).scanned,0);
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,before.cases);assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,before.points);
 assert.deepEqual((await local.bucket.list()).objects.map(x=>[x.key,x.etag]),before.r2);assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await local.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
});
test('Local backfill source change fails closed, no digest persisted',async()=>{const x=await submit();const file=await local.db.prepare('SELECT id,object_key FROM case_files WHERE case_id=?').bind(x.row.id).first();await local.db.prepare('DELETE FROM proof_exact_hashes WHERE file_id=?').bind(file.id).run();await local.bucket.put(file.object_key,new Uint8Array([9,8]),{httpMetadata:{contentType:'image/png'}});const r=await backfillExactHashes({db:local.db,bucket:local.bucket},{dryRun:false});assert.equal(r.results.find(x=>x.file_id===file.id).code,'PROOF_HASH_SOURCE_CHANGED');assert.equal(await local.db.prepare('SELECT file_id FROM proof_exact_hashes WHERE file_id=?').bind(file.id).first(),null);});
test('Admin evidence requires existing server Admin/MFA protection',async()=>{const x=await submit(),member=await h.identity();assert.equal((await local.fetch('/api/admin/cases/'+x.created.case_id)).status,401);assert.equal((await local.fetch('/api/admin/cases/'+x.created.case_id,'GET',undefined,member.headers)).status,403);const expired=await h.identity({role:'admin',elevated:false});assert.equal((await local.fetch('/api/admin/cases/'+x.created.case_id,'GET',undefined,expired.headers)).status,403);});
