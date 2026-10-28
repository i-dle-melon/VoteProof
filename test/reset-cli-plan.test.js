import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {digest} from '../scripts/lib/prelaunch-reset-snapshot.mjs';
import {renderBoundStatement,assessResetCLI} from '../scripts/lib/prelaunch-reset-cli-plan.mjs';
const plan=statements=>{const value={manifest_sha256:'a'.repeat(64),statements,statement_count:48,transaction_count:1,split_batches:false};return{...value,sha256:digest(value)};};
test('CLI renderer matches SQLite bind semantics, quotes, comments and hostile values without extra SQL',()=>{
 const db=new DatabaseSync(':memory:');try{
 const s={sql:`SELECT ?1 AS a,?1 AS again,?2 AS b,'?' AS literal,"?name" AS quoted /* ? */ -- ?\n,? AS c`,params:["'); DROP TABLE members; --",'NUL\0with quote\'雪',17]};
 // A quoted identifier is not a parameter; create a matching real column.
 s.sql=s.sql.replace(' /* ? */',' /* ? */').replace(',? AS c',',? AS c FROM (SELECT 4 AS "?name")');
 const bound=db.prepare(s.sql).get(...s.params),rendered=renderBoundStatement(s);assert.deepEqual(db.prepare(rendered).get(),bound);
 assert.throws(()=>renderBoundStatement({sql:'SELECT ?',params:[]}),/INDEX_MISMATCH/);
 assert.throws(()=>renderBoundStatement({sql:'SELECT 1',params:['unused']}),/UNUSED/);
 assert.throws(()=>renderBoundStatement({sql:'SELECT :named',params:['x']}),/NAMED/);
 assert.throws(()=>renderBoundStatement({sql:'SELECT ?',params:[Number.MAX_SAFE_INTEGER+1]}),/UNSUPPORTED/);
 }finally{db.close();}
});
test('CLI exposes inlined 100KB limit without splitting or changing the bound REST request',()=>{
 const statements=Array.from({length:48},()=>({sql:'SELECT ?',params:['ok']}));statements[1]={sql:'SELECT ?1,?1',params:['z'.repeat(100001)]};const p=plan(statements);
 const x=assessResetCLI(p,{approvedPreparedHash:p.sha256,approvedManifestHash:p.manifest_sha256});assert.deepEqual(x.rest.batch,statements);assert.deepEqual(x.report.wrangler_file.oversized_statement_indices,[2]);assert.equal(x.report.statement_count,48);assert.equal(x.report.status,'HOLD');assert.equal(x.report.wrangler_file.sql_exported,false);
 assert.throws(()=>assessResetCLI({...p,split_batches:true},{approvedPreparedHash:p.sha256,approvedManifestHash:p.manifest_sha256}),/EXACT_PREPARED/);
 assert.throws(()=>assessResetCLI(p,{approvedPreparedHash:p.sha256,approvedManifestHash:'b'.repeat(64)}),/EXACT_MANIFEST/);
});
test('CLI is offline dry-run only, protects private payload and never offers remote execution',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vp-reset-cli-')),p=plan(Array.from({length:48},()=>({sql:'SELECT ?',params:['synthetic-only']})));
 try{const input=dir+'/plan.private.json',out=dir+'/output.private';fs.writeFileSync(input,JSON.stringify(p));const run=args=>spawnSync(process.execPath,['scripts/prelaunch-reset-cli.mjs',...args],{encoding:'utf8'});
 const args=['--prepared',input,'--approved-prepared-sha256',p.sha256,'--approved-manifest-sha256',p.manifest_sha256,'--out',out];
 const result=run(args);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).cloud_requests,0);assert.deepEqual(JSON.parse(fs.readFileSync(out+'/REST-BATCH.private.json')).batch,p.statements);assert.equal(fs.readdirSync(out).some(n=>n.endsWith('.sql')),false);
 assert.notEqual(run(args).status,0);assert.match(run(['--execute']).stderr,/CLI_EXECUTION_HOLD/);assert.match(run(['--remote']).stderr,/CLI_EXECUTION_HOLD/);
 const blocked=[...args];blocked[7]='scripts/forbidden.private';assert.notEqual(run(blocked).status,0);assert.equal(fs.existsSync('scripts/forbidden.private'),false);
 }finally{if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('vp-reset-cli-'))throw Error('BAD_LOCAL_TEST_PATH');fs.rmSync(dir,{recursive:true,force:true});}
});
