import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {localCaseRuntime,guestBody} from '../scripts/lib/local-case-runtime.mjs';
import {exactProofCorpus,syntheticProofBytes} from './fixtures/exact-proof-corpus.js';
import {backfillExactHashes,adminExactEvidence,EXACT_EVIDENCE_SQL,verifiedProofObject} from '../src/lib/proof-exact-hash.js';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const corpus=exactProofCorpus(),digest=b=>createHash('sha256').update(b).digest('hex');let local;
before(async()=>{local=await localCaseRuntime();});after(async()=>await local?.runtime.dispose());
async function prepared(bytes,name='synthetic.png'){
 const r=await local.fetch('/api/uploads/prepare','POST',{turnstile_token:randomUUID(),files:[{name,type:'image/png',size:bytes.length,algorithm:'sha256',sha256:createHash('sha256').update(bytes).digest('hex')}]});assert.equal(r.status,200);
 const p=(await r.json()).data,ref={session_id:p.session_id,keys:p.uploads.map(u=>u.key)};
 // An upload retry overwrites only its own staging key with identical bytes.
 await local.put(p.uploads[0],bytes);
 await local.put(p.uploads[0],bytes);
 for(let n=0;n<2;n++)assert.equal((await local.fetch('/api/uploads/complete','POST',ref)).status,200);
 return ref;
}
async function submitted(bytes,name){const ref=await prepared(bytes,name),key=randomUUID(),body=guestBody(ref);
 const r=await local.fetch('/api/cases','POST',body,{'Idempotency-Key':key});assert.equal(r.status,201);const response=(await r.json()).data;
 const row=await local.db.prepare('SELECT c.id,c.status,c.points_awarded,c.duplicate_flag,f.id file_id,h.sha256 FROM cases c JOIN case_files f ON f.case_id=c.id JOIN proof_exact_hashes h ON h.file_id=f.id WHERE c.case_id=?').bind(response.case_id).first();
 assert.equal(row.sha256,digest(bytes));return {ref,key,body,response,row};
}
async function verifyTwenty(files){const before=(await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,transactions=(await local.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n;
 const results=[];for(const [i,bytes] of files.entries())results.push(await submitted(bytes,'fixture-'+i+'.png'));
 assert.equal(new Set(results.map(x=>x.row.id)).size,20);assert.equal(new Set(results.map(x=>x.row.file_id)).size,20);
 assert.ok(results.every(x=>x.row.status==='pending'&&x.row.points_awarded===0&&x.row.duplicate_flag===0));
 for(const x of results){const replay=(await (await local.fetch('/api/cases','POST',x.body,{'Idempotency-Key':x.key})).json()).data;assert.deepEqual(replay,x.response);}
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,before+20);assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,transactions);
 return results;
}
test('20 unique valid PNG files have 20 independent hashes/cases; successful batch replays never recreate them',async()=>{
 const rows=await verifyTwenty(Array.from({length:20},(_,i)=>syntheticProofBytes(1024,i+10)));assert.equal(new Set(rows.map(x=>x.row.sha256)).size,20);
 for(const x of rows)assert.equal((await adminExactEvidence(local.db,x.row.id)).exact_match_detected,false);
});
test('20 mixed files distinguish renamed exact bytes, equal-size differences, one byte and re-encoding',async()=>{
 const files=[corpus.original.bytes,corpus.renamed.bytes,corpus.equal_size_different.bytes,corpus.one_byte.bytes,corpus.reencoded_visual_equivalent.bytes,...Array.from({length:15},(_,i)=>syntheticProofBytes(1024,i+80))];
 const rows=await verifyTwenty(files),e=await adminExactEvidence(local.db,rows[1].row.id);assert.ok(e.matches.some(x=>x.previous_case_id===rows[0].response.case_id));
 assert.equal(rows[0].row.sha256,rows[1].row.sha256);for(let i=2;i<5;i++)assert.notEqual(rows[i].row.sha256,rows[0].row.sha256);
 assert.equal(new Set(rows.map(x=>x.row.sha256)).size,19);
});
test('native Workers path enforces the maximum 5 MiB and stores the independent correct digest',async()=>{
 const bytes=syntheticProofBytes(5242880,150),x=await submitted(bytes);assert.equal(x.row.sha256,digest(bytes));
 const r=await local.fetch('/api/uploads/prepare','POST',{turnstile_token:randomUUID(),files:[{name:'oversize.png',type:'image/png',size:5242881}]});assert.equal(r.status,400);
});
test('missing R2 is reported separately; after interruption/restart from empty cursor it recovers without business changes',async()=>{
 const x=await submitted(syntheticProofBytes(1024,210)),f=await local.db.prepare('SELECT * FROM case_files WHERE id=?').bind(x.row.file_id).first();
 await local.db.prepare('DELETE FROM proof_exact_hashes WHERE file_id=?').bind(f.id).run();
 const count=(await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,points=(await local.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n;
 const missing=await backfillExactHashes({db:local.db,bucket:{get:async()=>null}},{dryRun:false,limit:1});assert.equal(missing.results[0].code,'PROOF_HASH_SOURCE_MISSING');assert.equal(missing.written,0);
 const preview=await backfillExactHashes({db:local.db,bucket:local.bucket},{dryRun:true,limit:1});assert.equal(preview.written,0);
 const resumed=await backfillExactHashes({db:local.db,bucket:local.bucket},{dryRun:false,limit:1});assert.equal(resumed.written,1);
 assert.equal((await backfillExactHashes({db:local.db,bucket:local.bucket},{dryRun:false,limit:1})).scanned,0);
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,count);assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,points);
});
test('hash D1 failure rolls back case and hash; retry of same session/key creates exactly one valid proof',async()=>{
 const bytes=syntheticProofBytes(1024,220),ref=await prepared(bytes),body=guestBody(ref),key=randomUUID(),before=(await local.db.prepare('SELECT COUNT(*) n FROM proof_exact_hashes').first()).n;
 await local.db.prepare("CREATE TRIGGER readiness_abort_hash BEFORE INSERT ON proof_exact_hashes BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
 try{assert.equal((await local.fetch('/api/cases','POST',body,{'Idempotency-Key':key})).status,500);}finally{await local.db.prepare('DROP TRIGGER readiness_abort_hash').run();}
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM proof_exact_hashes').first()).n,before);assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases WHERE upload_session_id=?').bind(ref.session_id).first()).n,0);
 const first=(await (await local.fetch('/api/cases','POST',body,{'Idempotency-Key':key})).json()).data;
 await local.setQuerySecret(local.querySecret); // A real workerd restart, persistent local D1/R2.
 const replay=(await (await local.fetch('/api/cases','POST',body,{'Idempotency-Key':key})).json()).data;assert.deepEqual(replay,first);
 assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM proof_exact_hashes').first()).n,before+1);
});
test('Admin exact lookup uses a historical index range and limits candidates before joining/sorting',async()=>{
 const row=await submitted(syntheticProofBytes(1024,230));
 const plan=(await local.db.prepare('EXPLAIN QUERY PLAN '+EXACT_EVIDENCE_SQL).bind(row.row.id).all()).results.map(x=>x.detail).join('\n');
 assert.match(plan,/SEARCH prior USING COVERING INDEX idx_proof_exact_hash_lookup/);assert.doesNotMatch(plan,/SCAN prior/);
 const indexes=(await local.db.prepare("PRAGMA index_info('idx_proof_exact_hash_lookup')").all()).results;
 assert.deepEqual(indexes.map(x=>x.name),['sha256','case_created_at','case_internal_id','file_id']);
 assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await local.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
});
test('native Workers object read rejects truncated and excessive bytes before providing a verified digest',async()=>{
 const bundle=await build({stdin:{contents:`import {verifiedProofObject} from './src/lib/proof-exact-hash.js';export default {async fetch(){const results=[];for(const expected of [2,4]){let code;try{await verifiedProofObject({size:expected,body:new Response(new Uint8Array([1,2,3])).body,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer},expected);}catch(e){code=e.code;}results.push({code});}return Response.json(results);}};`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-07'}));
 try{assert.deepEqual(await (await runtime.dispatchFetch('https://synthetic.example')).json(),[{code:'PROOF_HASH_SOURCE_CHANGED'},{code:'PROOF_HASH_SOURCE_CHANGED'}]);}finally{await runtime.dispose();}
});
