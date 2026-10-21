import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localAdminRuntime } from '../scripts/lib/local-admin-runtime.mjs';

let h,admin;
before(async()=>{
  h=await localAdminRuntime();
  admin=await h.identity({role:'admin'});
  // Isolated D1 fixture only: 23 immutable audit entries, never actual queue jobs.
  const when=1792000000;
  await h.local.db.batch(Array.from({length:23},(_,i)=>h.local.db.prepare(
    "INSERT INTO backup_admin_audit(id,created_at,admin_member_id,action,target_id,affected_count) VALUES(?,?,?,?,?,?)"
  ).bind(randomUUID(),when+i,admin.memberId,i%3?'backfill':'retry','private-target-'+i,i+1)));
});
after(async()=>{await h?.local.runtime.dispose();});
const read=(q='',headers=admin.headers)=>h.local.fetch('/api/admin/backups/audit'+q,'GET',undefined,headers);

test('backup operation audit is read-only and paginates 10/10/3 in descending stable order',async()=>{
  const seen=[];
  for(const page of [3,1,2]){
    const response=await read('?page='+page);
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const {data}=await response.json();
    assert.equal(data.page,page);assert.equal(data.page_size,10);assert.equal(data.total,23);assert.equal(data.total_pages,3);
    assert.equal(data.audit.length,page===3?3:10);
    for(const entry of data.audit){
      assert.deepEqual(Object.keys(entry).sort(),['action','affected_count','created_at']);
      assert.ok(['retry','backfill'].includes(entry.action));seen.push(entry.created_at);
    }
    assert.doesNotMatch(JSON.stringify(data),/private-target|member_id|admin_member_id|email|secret/i);
  }
  assert.equal(new Set(seen).size,23);
  assert.deepEqual([...seen].sort((a,b)=>b-a),Array.from({length:23},(_,i)=>1792000022-i));
  assert.equal((await h.local.db.prepare('SELECT COUNT(*) AS n FROM backup_admin_audit').first()).n,23);
  assert.equal((await h.local.db.prepare('SELECT COUNT(*) AS n FROM proof_backups').first()).n,0);
  const summary=await h.local.fetch('/api/admin/backups','GET',undefined,admin.headers);
  assert.equal(summary.status,200);assert.equal((await summary.json()).data.audit_total,23);
});
test('backup operation audit enforces MFA and role, never exposes details to anonymous or reviewer',async()=>{
  assert.equal((await h.local.fetch('/api/admin/backups/audit','GET')).status,401);
  for(const opts of [{role:'reviewer'},{role:'admin',elevated:false},{role:'admin',membershipStatus:'disabled'},{role:'admin',revoked:true},{role:'admin',status:'suspended'}]){
    const identity=await h.identity(opts),res=await read('',identity.headers);
    assert.ok([401,403].includes(res.status),JSON.stringify(opts));
    assert.doesNotMatch(await res.text(),/private-target/);
  }
  const owner=await h.identity({role:'super_admin'});assert.equal((await read('',owner.headers)).status,200);
});
test('backup audit query validates pagination, rejects writes and returns empty beyond last page',async()=>{
  for(const q of ['page=0','page=-1','page=1.5','page=01','page=9007199254740991','page=','page=1&page=2','cursor=abc','page=1&token=forged'])
    assert.equal((await read('?'+q)).status,400,q);
  assert.equal((await h.local.fetch('/api/admin/backups/audit','POST',{},admin.headers)).status,405);
  const end=(await (await read('?page=4')).json()).data;
  assert.equal(end.audit.length,0);assert.equal(end.total_pages,3);
});
