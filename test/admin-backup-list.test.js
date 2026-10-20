import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {backupInsert, seconds} from '../src/lib/proof-backup-store.js';

let h, admin, files;
before(async () => {
  h = await localAdminRuntime();
  admin = await h.identity({role:'admin'});
  for(let i=0;i<24;i++)await h.makeCase();
  files = (await h.local.db.prepare('SELECT id FROM case_files ORDER BY id').all()).results;
  await backupInsert(h.local.db, files[0].id, seconds()).run();
});
after(async () => {await h?.local.runtime.dispose();});
const read = (query='', headers=admin.headers) => h.local.fetch('/api/admin/backups/missing'+query,'GET',undefined,headers);

test('missing backup list returns 10/10/3 metadata rows with direct page access and never queues jobs',async()=>{
  const seen=[];
  for(const page of [3,1,2]){
    const response=await read('?page='+page);assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    const data=(await response.json()).data;
    assert.equal(data.page,page);assert.equal(data.page_size,10);assert.equal(data.total,23);assert.equal(data.total_pages,3);
    assert.equal(data.files.length,page===3?3:10);
    for(const row of data.files){
      assert.deepEqual(Object.keys(row).sort(),['case_id','content_type','created_at','file_id','size']);
      assert.ok(row.case_id.startsWith('VP-'));assert.equal(row.content_type,'image/png');seen.push(row.file_id);
    }
    assert.doesNotMatch(JSON.stringify(data),/object_key|etag|query_key|member_id|email|secret/i);
  }
  assert.equal(new Set(seen).size,23);assert.ok(!seen.includes(files[0].id));
  assert.equal((await h.local.db.prepare('SELECT count(*) n FROM proof_backups').first()).n,1);
  assert.equal((await h.local.db.prepare('SELECT count(*) n FROM backup_admin_audit').first()).n,0);
  assert.equal((await h.local.db.prepare('SELECT count(*) n FROM case_files').first()).n,24);
});

test('missing backup list requires an active admin/super_admin session and verified MFA',async()=>{
  assert.equal((await h.local.fetch('/api/admin/backups/missing','GET')).status,401);
  for(const options of [{},{role:'reviewer'},{role:'admin',elevated:false},{role:'admin',membershipStatus:'disabled'},{role:'admin',revoked:true},{role:'admin',status:'suspended'}]){
    const identity=await h.identity(options),response=await read('',identity.headers);
    assert.ok([401,403].includes(response.status),JSON.stringify(options));
    assert.ok(!(await response.text()).includes(files[1].id));
  }
  const owner=await h.identity({role:'super_admin'});assert.equal((await read('',owner.headers)).status,200);
});

test('missing backup list rejects malformed/unknown/repeated pagination and unsupported writes',async()=>{
  for(const query of ['page=0','page=-1','page=1.5','page=01','page=9007199254740991','page=','page=1&page=2','limit=100','page=1&token=forged'])assert.equal((await read('?'+query)).status,400,query);
  assert.equal((await h.local.fetch('/api/admin/backups/missing','POST',{},admin.headers)).status,405);
  const beyond=(await (await read('?page=4')).json()).data;
  assert.equal(beyond.files.length,0);assert.equal(beyond.total_pages,3);
});

test('queue updates are reflected without changing backups and an empty list remains one empty page',async()=>{
  await h.local.db.batch(files.map(file=>backupInsert(h.local.db,file.id,seconds())));
  const response=await read(),data=(await response.json()).data;
  assert.equal(response.status,200);assert.deepEqual(data,{files:[],page:1,page_size:10,total:0,total_pages:1});
  assert.equal((await h.local.db.prepare('SELECT count(*) n FROM proof_backups').first()).n,24);
});
