// Full-schema native LOCAL D1 comparison. No remote access or Cloudflare CPU claim.
import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {archiveCanaryRuntime} from './helpers/archive-canary-runtime.mjs';
let h,oldSql,newSql;const items=[],at=Math.floor(Date.now()/1000);
const stamp=i=>new Date(Date.UTC(2020,0,1,0,0,i)).toISOString();
before(async()=>{
 oldSql=(await readFile(new URL('./fixtures/archive-candidate-v3.sql',import.meta.url),'utf8')).trim().replace(/;$/,'');
 const source=await readFile(new URL('../src/lib/storage-archive.js',import.meta.url),'utf8');
 const expr=source.match(/\.first\(\):await db\.prepare\(\s*([\s\S]+?)\)\s*\.bind\(at-86400,at\)\.first\(\)/)?.[1];assert.ok(expr);
 newSql=Function('return ('+expr+')')();h=await archiveCanaryRuntime();
 for(let i=0;i<18;i++)items.push(await h.seed('candidate-'+i));
});
after(async()=>{await h?.close();});
beforeEach(async()=>{
 await h.db.prepare('DELETE FROM cold_proofs').run();
 await h.db.prepare("UPDATE proof_backups SET status='confirmed',lease_until=NULL").run();
 for(let i=0;i<items.length;i++)await h.db.prepare("UPDATE cases SET status='completed',reviewed_at=?,status_updated_at=?,updated_at=? WHERE id=?").bind(stamp(i),stamp(i),stamp(i),items[i].id).run();
});
async function compare(expected){
 const query=async(sql,limit)=>h.db.prepare(limit?sql:sql.replace(/LIMIT 1$/,'LIMIT 100')).bind(at-86400,at).all();
 const before=await query(oldSql,false),after=await query(newSql,false);
 assert.deepEqual(after.results,before.results);
 if(expected)assert.deepEqual(after.results.map(x=>x.object_key),expected.map(x=>x.key));
 const b=await query(oldSql,true),a=await query(newSql,true);assert.deepEqual(a.results,b.results);assert.equal(a.meta.rows_written,0);return{before:b.meta.rows_read,after:a.meta.rows_read};
}
async function pin(i,state,changes={}){
 await h.db.prepare('INSERT INTO cold_proofs(file_id,state,updated_at,lease_until,verification_context) VALUES(?,?,?,?,?)')
  .bind(items[i].file,state,changes.updated_at??at,changes.lease_until??null,changes.context??null).run();
}
test('oldest closed first and file-id tie order exactly match V3',async()=>{
 await h.db.prepare('UPDATE cases SET status_updated_at=? WHERE id=?').bind(stamp(0),items[1].id).run();
 const first=items.slice(0,2).sort((a,b)=>a.file<b.file?-1:1);await compare([...first,...items.slice(2)]);
});
test('pending/processing/failed backups excluded; confirmed-only unchanged',async()=>{
 for(const [i,status]of ['pending','processing','failed'].entries())await h.db.prepare('UPDATE proof_backups SET status=? WHERE file_id=?').bind(status,items[i].file).run();
 await compare(items.slice(3));
});
test('all three closed statuses retained; pending/approved/unreviewed excluded',async()=>{
 for(const [i,status]of ['pending','approved','rejected','revoked'].entries())await h.db.prepare('UPDATE cases SET status=? WHERE id=?').bind(status,items[i].id).run();
 await h.db.prepare('UPDATE cases SET reviewed_at=NULL WHERE id=?').bind(items[4].id).run();
 await compare([items[2],items[3],...items.slice(5)]);
});
test('seven-day eligibility, invalid dates and coalesce fallback preserved',async()=>{
 await h.db.prepare("UPDATE cases SET status_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days') WHERE id=?").bind(items[0].id).run();
 await h.db.prepare("UPDATE cases SET status_updated_at='invalid-date' WHERE id=?").bind(items[1].id).run();
 await h.db.prepare('UPDATE cases SET status_updated_at=NULL WHERE id=?').bind(items[2].id).run();
 await h.db.prepare("UPDATE cases SET status_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') WHERE id=?").bind(items[17].id).run();
 await compare(items.slice(2));
 // The exact inclusive julianday predicate itself is identical to V3.
 const predicate="julianday(coalesce(c.status_updated_at,c.updated_at))<=julianday('now','-7 days')";
 assert.ok(oldSql.includes(predicate)&&newSql.includes(predicate));
});
test('blocked/verifying retry boundaries, dry-run, cold and deleting eligibility unchanged',async()=>{
 await pin(0,'cold');await pin(1,'deleting',{lease_until:at-1});
 await pin(2,'blocked',{updated_at:at-86400});await pin(3,'blocked',{updated_at:at-86401});
 await pin(4,'verifying',{lease_until:at});await pin(5,'verifying',{lease_until:at-1});
 await pin(6,'verifying');await pin(7,'dry_run');
 await compare([items[3],items[5],...items.slice(7)]);
});
test('existing saved-context priority retained before oldest/file order',async()=>{
 await pin(17,'verifying',{lease_until:0,context:'{"source":"synthetic-only"}'});
 await compare([items[17],...items.slice(0,17)]);
});
for(const cold of [0,15,18])test(`18 candidates / ${cold} cold: identical result and bounded read improvement`,async()=>{
 for(let i=0;i<cold;i++)await pin(i,'cold');const cost=await compare(items.slice(cold));
 assert.ok(cost.after<=cost.before);if(cold)assert.ok(cost.after<cost.before);
 const plan=(await h.db.prepare('EXPLAIN QUERY PLAN '+newSql).bind(at-86400,at).all()).results.map(x=>x.detail);
 assert.ok(plan.findIndex(x=>x.startsWith('SEARCH p '))<plan.findIndex(x=>x.startsWith('SEARCH f ')));
 assert.ok(plan.findIndex(x=>x.startsWith('SEARCH f '))<plan.findIndex(x=>x.startsWith('SEARCH c ')));
 assert.ok(!plan.some(x=>/^SCAN [fc] /.test(x)));assert.ok(plan.some(x=>x.includes('idx_backup_status_created')));
 console.log(JSON.stringify({local_candidate_cost:true,cases:18,cold,...cost}));
});
test('nonclosed rows with old eligible pins: semantics preserved and cost tradeoff exposed',async()=>{
 for(let i=0;i<18;i++){await pin(i,'dry_run');await h.db.prepare("UPDATE cases SET status='pending' WHERE id=?").bind(items[i].id).run();}
 const cost=await compare([]);console.log(JSON.stringify({local_candidate_tradeoff:true,shape:'18 pending cases with dry-run pins',...cost}));
 // No universal saving claim: a data distribution can favor the old join order.
 assert.ok(cost.after>=cost.before);
});
