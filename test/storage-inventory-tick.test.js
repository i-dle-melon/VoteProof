import test, {before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {storageRoute} from '../src/api/storage.js';
import {capacityRow,nowSeconds,reserveStorage} from '../src/lib/storage-capacity.js';
import {countDatabase} from '../scripts/lib/drive-backup-fixture.mjs';

let h,db;
const secret=randomBytes(32).toString('hex');
const path='/api/internal/drive-backup/storage/tick';
before(async()=>{h=await localAdminRuntime({submissionsEnabled:false});db=h.local.db;});
after(async()=>{await h?.local.runtime.dispose();});
beforeEach(async()=>{
  await db.batch(['DELETE FROM storage_reservations','DELETE FROM storage_alert_deliveries',
    'DELETE FROM storage_alerts','DELETE FROM storage_history',
    "UPDATE storage_capacity SET used_bytes=0,reserved_bytes=0,blocked=1,trusted_until=0,observed_at=NULL,inventory_id=NULL,inventory_phase=NULL,inventory_cursor=NULL,inventory_bytes=0,inventory_count=0,anomaly=NULL,cleanup_requested=0 WHERE id=1"].map(sql=>db.prepare(sql)));
});
const bucket = objects => ({list:async()=>({objects,truncated:false}),
  get:()=>assert.fail('No image read'),put:()=>assert.fail('No PUT'),delete:()=>assert.fail('No DELETE')});
function env(extra={}) {return {...h.local.authConfig,DB:db,PROOFS_BUCKET:bucket([]),
  GOOGLE_DRIVE_BACKUP_ENABLED:'true',DRIVE_BACKUP_RELAY_SECRET:secret,
  R2_EXCLUSIVE_WRITER_CONFIRMED:'true',...extra};}
const finalPath='/api/internal/drive-backup/storage/inventory/finalize';
async function step(e,body={inventory_only:true},headers={},route=path) {
  const r=await storageRoute(route).handler(e,new URL('https://isolated.invalid'+route),
    new Request('https://isolated.invalid'+route,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',...headers},body:JSON.stringify(body)}));
  return {status:r.status,...await r.json()};
}
const readyBody=r=>({inventory_id:r.data.inventory.inventory_id,inventory_version:r.data.inventory.inventory_version});
async function call(e,body={inventory_only:true},headers={},route=path){
  const r=await step(e,body,headers,route);
  return r.status===200&&route===path&&r.data.inventory?.phase==='finalize'
    ?step(e,readyBody(r),headers,finalPath):r;
}
test('inventory-only never enters alert delivery even when alerts/live cleanup are enabled',async()=>{
  const id=randomUUID();await db.prepare("INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,900,'95',?)").bind(id,nowSeconds()).run();
  const e=env({PROOFS_BUCKET:bucket([{key:'synthetic/staging',size:472081}]),
    STORAGE_ALERT_ENABLED:'true',STORAGE_CLEANUP_LIVE_ENABLED:'true'});
  // Define getter after spread so any attempted alert processing fails this test.
  Object.defineProperty(e,'STORAGE_ALERT_RELAY_URL',{get(){assert.fail('Must not process alerts');}});
  const r=await call(e);assert.equal(r.status,200);assert.equal(r.data.inventory_only,true);
  assert.deepEqual(r.data.alerts,{state:'skipped_inventory_only',sent:0});assert.equal(r.data.cleanup,null);
  assert.equal(r.data.inventory.complete,true);assert.equal(r.data.inventory.bytes,472081);assert.equal(r.data.inventory.anomaly,null);
  assert.equal((await db.prepare('SELECT state FROM storage_alerts WHERE id=?').bind(id).first()).state,'pending');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_alert_deliveries').first()).n,0);
});
test('partial failure retains pin/expired trust, resumes cursor, and late response retry does not double count',async()=>{
  let crash=true;const calls=[];
  const e=env({PROOFS_BUCKET:{list:async({cursor,limit})=>{
    calls.push(cursor??null);assert.equal(limit,50);
    if(!cursor)return{objects:[{key:'synthetic/one',size:3}],truncated:true,cursor:'page-2'};
    if(crash){crash=false;throw Error('isolated response lost');}
    return{objects:[{key:'synthetic/two',size:7}],truncated:false};
  }}});
  assert.equal((await call(e)).data.inventory.complete,false);
  const pin=(await capacityRow(db)).inventory_id;
  assert.equal((await call(e)).status,503);
  let row=await capacityRow(db);assert.equal(row.inventory_id,pin);assert.equal(row.trusted_until,0);
  const done=await call(e);assert.equal(done.data.inventory.bytes,10); // Simulated lost final ACK.
  assert.equal((await call(e)).data.inventory.complete,false);
  assert.equal((await call(e)).data.inventory.bytes,10);
  row=await capacityRow(db);assert.equal(row.used_bytes,10);assert.equal(row.inventory_id,null);
  assert.equal(row.blocked,0);assert.equal(row.reserved_bytes,0);
  assert.deepEqual(calls,[null,'page-2','page-2',null,'page-2']);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_history').first()).n,2);
});
test('reservation and writer guards remain fail-closed',async()=>{
  assert.equal((await call(env({R2_EXCLUSIVE_WRITER_CONFIRMED:'false'}))).status,409);
  await db.prepare('UPDATE storage_capacity SET reserved_bytes=1 WHERE id=1').run();
  assert.equal((await call(env())).status,409);
  assert.equal((await capacityRow(db)).trusted_until,0);
});
test('auth, Origin and strict tick-only payload validation are preserved',async()=>{
  assert.equal((await call(env(),{inventory_only:true},{Authorization:'Bearer '+randomBytes(32).toString('hex')})).status,401);
  assert.equal((await call(env(),{inventory_only:true},{Origin:'https://isolated.invalid'})).status,403);
  for(const body of [{inventory_only:false},{inventory_only:true,extra:1},{inventory_only:true,limit:200},[],null])
    assert.equal((await call(env(),body)).status,503);
  assert.equal((await call(env(),{inventory_only:true},{},'/api/internal/drive-backup/storage/archive')).status,503);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_history').first()).n,0);
});
test('legacy empty-body tick remains backward compatible',async()=>{
  const r=await call(env(),{});assert.equal(r.status,200);
  assert.equal(r.data.inventory_only,undefined);assert.equal(r.data.alerts.state,'disabled');
});

test('bounded scheduled pages still account for every object and expire trust until final CAS',async()=>{
  const objects=Array.from({length:125},(_,n)=>({key:(n%2?'proofs/staging/':'other/')+n,size:n+1}));
  const cursors=[];
  const e=env({PROOFS_BUCKET:{list:async({limit,cursor})=>{
    assert.equal(limit,50);const offset=Number(cursor??0);cursors.push(offset);
    const more=offset+limit<objects.length;
    return{objects:objects.slice(offset,offset+limit),truncated:more,...(more?{cursor:String(offset+limit)}:{})};
  }}});
  assert.equal((await call(e)).data.inventory.complete,false);
  const pin=(await capacityRow(db)).inventory_id;
  assert.ok(pin);assert.equal((await capacityRow(db)).trusted_until,0);
  await assert.rejects(reserveStorage(e,'synthetic-write',1),e=>e.code==='R2_STORAGE_CAPACITY_EXCEEDED');
  assert.equal((await call(e)).data.inventory.complete,false);
  assert.equal((await capacityRow(db)).inventory_id,pin);
  const done=await call(e);assert.equal(done.data.inventory.complete,true);
  const row=await capacityRow(db);assert.equal(row.used_bytes,7875);assert.equal(row.inventory_count,125);
  assert.equal(row.inventory_id,null);assert.equal(row.reserved_bytes,0);assert.equal(row.anomaly,null);assert.equal(row.blocked,0);
  assert.equal(row.trusted_until-row.observed_at,600);assert.deepEqual(cursors,[0,50,100]);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_history').first()).n,1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM storage_audit WHERE target=?").bind(pin).first()).n,1);
});

test('legacy page bound stays 200 and scheduled inventory never bypasses the 95 percent guard',async()=>{
  const e=env({PROOFS_BUCKET:{list:async({limit})=>{
    assert.equal(limit,200);return{objects:[{key:'synthetic',size:1}],truncated:false};
  }}});
  assert.equal((await call(e,{})).status,200);
  await db.prepare('UPDATE storage_capacity SET observed_at=NULL,used_bytes=0 WHERE id=1').run();
  const full=env({PROOFS_BUCKET:{list:async({limit})=>{
    assert.equal(limit,50);return{objects:[{key:'synthetic',size:9500000000}],truncated:false};
  }}});
  const result=await call(full);assert.equal(result.status,200);
  const row=await capacityRow(db);assert.equal(row.blocked,1);assert.equal(row.anomaly,null);
  await assert.rejects(reserveStorage(full,'synthetic-no-put',1),e=>e.code==='R2_STORAGE_CAPACITY_EXCEEDED');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_alert_deliveries').first()).n,0);
});

test('95 percent pre-scan blocking still runs when the R2 LIST fails',async()=>{
  await db.prepare('UPDATE storage_capacity SET used_bytes=9500000000,blocked=0 WHERE id=1').run();
  const e=env({PROOFS_BUCKET:{list:async()=>{throw Error('synthetic LIST unavailable');}}});
  assert.equal((await call(e)).status,503);
  const row=await capacityRow(db);assert.equal(row.blocked,1);assert.equal(row.trusted_until,0);
  assert.equal(row.cleanup_requested,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_alerts').first()).n,2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_alert_deliveries').first()).n,0);
});
test('quota relay persists a deduplicated snapshot and Admin reads total, used, percentage and time',async()=>{
  const quotaPath='/api/internal/drive-backup/storage/quota';
  const snapshot={id:randomUUID(),observed_at:nowSeconds(),state:'known',total_bytes:15000000000,used_bytes:7000000000};
  const result=await call(env(),snapshot,{},quotaPath);assert.equal(result.status,200);assert.equal(result.data.accepted,true);
  await call(env(),snapshot,{},quotaPath);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM drive_quota_snapshots WHERE id=?').bind(snapshot.id).first()).n,1);
  const admin=await h.identity({role:'admin'});const route='/api/admin/storage';
  const response=await storageRoute(route).handler(env(),new URL('https://voteproof.example'+route),
    new Request('https://voteproof.example'+route,{headers:admin.headers}));
  assert.equal(response.status,200);const quota=(await response.json()).data.drive_quota;
  assert.equal(quota.total_bytes,15000000000);assert.equal(quota.used_bytes,7000000000);
  assert.equal(quota.remaining_percent,(8/15)*100);assert.equal(quota.observed_at,snapshot.observed_at);
  assert.equal(quota.stale,false);assert.equal(JSON.stringify(quota).includes(secret),false);
});
test('quota receipt preserves auth/Origin checks and rejects malformed or stale values',async()=>{
  const route='/api/internal/drive-backup/storage/quota';
  const snapshot={id:randomUUID(),observed_at:nowSeconds(),state:'known',total_bytes:100,used_bytes:70};
  assert.equal((await call(env(),snapshot,{Authorization:'Bearer '+randomBytes(32).toString('hex')},route)).status,401);
  assert.equal((await call(env(),snapshot,{Origin:'https://isolated.invalid'},route)).status,403);
  for(const v of [{...snapshot,observed_at:nowSeconds()-121},{...snapshot,used_bytes:-1},
    {...snapshot,unexpected:true},{...snapshot,state:'unknown'}, {...snapshot,used_bytes:101}])
    assert.equal((await call(env(),v,{},route)).status,400);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM drive_quota_snapshots WHERE id=?').bind(snapshot.id).first()).n,0);
});
test('sequential scheduled scans detect unaccounted growth and never clear an anomaly',async()=>{
  await call(env({PROOFS_BUCKET:bucket([{key:'synthetic',size:3}])}));
  const bigger=env({PROOFS_BUCKET:bucket([{key:'synthetic',size:4}])});
  assert.equal((await call(bigger)).data.inventory.anomaly,'UNACCOUNTED_GROWTH');
  await call(bigger);const row=await capacityRow(db);
  assert.equal(row.blocked,1);assert.equal(row.anomaly,'UNACCOUNTED_GROWTH');
  assert.equal((await db.prepare('SELECT submissions_enabled FROM submission_settings WHERE id=1').first()).submissions_enabled,0);
});
test('measure the complete authenticated tick in application statements and D1 round trips',async()=>{
  const statements=countDatabase(db);const raw=new WeakMap();let trips=0,lists=0;
  const counted={prepare:sql=>{
    const wrap=s=>{const proxy=new Proxy(s,{get(t,k){
      if(k==='bind')return(...args)=>wrap(t.bind(...args));
      if(['first','all','run','raw'].includes(k))return(...args)=>{trips++;return t[k](...args);};
      const v=t[k];return typeof v==='function'?v.bind(t):v;
    }});raw.set(proxy,s);return proxy;};return wrap(statements.db.prepare(sql));
  },batch:s=>{trips++;return statements.db.batch(s.map(x=>raw.get(x)??x));}};
  for(const pages of [1,3]) for(const phase of ['initial','warm']){
    const e=env({DB:counted,PROOFS_BUCKET:{list:async({cursor})=>{
      lists++;const n=Number(cursor??0);
      return{objects:[{key:'synthetic/'+n,size:pages===1?472081:1}],truncated:n+1<pages,
        ...(n+1<pages?{cursor:String(n+1)}:{})};
    }}});
    statements.reset();trips=0;lists=0;
    const quota=await call(e,{id:randomUUID(),observed_at:nowSeconds(),state:'known',total_bytes:15000000000,used_bytes:7000000000},
      {},'/api/internal/drive-backup/storage/quota');
    assert.equal(quota.status,200);const quotaStatements=statements.queries,quotaTrips=trips;
    assert.equal(quotaStatements,1);assert.equal(quotaTrips,1);
    statements.reset();trips=0;
    const r=await call(e);assert.equal(r.status,200);
    assert.equal(r.data.inventory.complete,pages===1);
    for(let i=1;i<pages;i++)assert.equal((await call(e)).status,200);
    console.log(JSON.stringify({measurement:'inventory-only-tick',phase,pages,statements:statements.queries,trips,r2_list:lists,cloud_cpu:'UNKNOWN'}));
    assert.equal(statements.queries,2*pages+7);assert.equal(trips,2*pages+3);assert.equal(lists,pages);
    console.log(JSON.stringify({measurement:'quota-plus-inventory',phase,pages,
      statements:statements.queries+quotaStatements,trips:trips+quotaTrips,worker_requests:pages+2,r2_list:lists,drive_about:1}));
  }
});

test('scan and finalize are separate requests; scan cannot publish capacity or audit',async()=>{
  let lists=0;const e=env({PROOFS_BUCKET:{list:async()=>{lists++;return{objects:[{key:'synthetic',size:7}],truncated:false};}}});
  const ready=await step(e);assert.equal(ready.data.inventory.complete,false);assert.equal(ready.data.inventory.phase,'finalize');
  const row=await capacityRow(db);assert.equal(row.inventory_phase,'ready');assert.equal(row.used_bytes,0);assert.equal(row.trusted_until,0);
  assert.equal(row.inventory_bytes,7);assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_history').first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_audit WHERE target=?').bind(row.inventory_id).first()).n,0);
  await assert.rejects(reserveStorage(e,'no-early-put',1));
  assert.deepEqual((await step(e)).data.inventory,ready.data.inventory);assert.equal(lists,1); // Lost scan ACK.
  const done=await step(e,readyBody(ready),{},finalPath);assert.equal(done.data.inventory.bytes,7);assert.equal(lists,1);
  assert.equal((await capacityRow(db)).trusted_until-(await capacityRow(db)).observed_at,600);
});

test('duplicate finalization replays the atomic receipt without refreshing trust or touching another scan',async()=>{
  const e=env({PROOFS_BUCKET:bucket([{key:'x',size:7}])}),ready=await step(e),body=readyBody(ready);
  assert.equal((await step(e,body,{},finalPath)).data.inventory.replayed,false);
  await db.prepare('UPDATE storage_capacity SET trusted_until=trusted_until-10 WHERE id=1').run();
  const before=await capacityRow(db);assert.equal((await step(e,body,{},finalPath)).data.inventory.replayed,true);
  assert.deepEqual(await capacityRow(db),before);
  const next=await step(e),active=await capacityRow(db);assert.notEqual(next.data.inventory.inventory_id,body.inventory_id);
  assert.equal((await step(e,body,{},finalPath)).status,200);assert.deepEqual(await capacityRow(db),active);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_history').first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_audit WHERE id=?').bind(body.inventory_id).first()).n,1);
});

test('finalize rejects premature/forged versions, payloads and auth; legacy callers cannot finish a segmented scan',async()=>{
  const e=env({PROOFS_BUCKET:{list:async()=>({objects:[],truncated:true,cursor:'next'})}});
  const partial=await step(e),body=readyBody(partial);
  assert.equal((await step(e,body,{},finalPath)).status,409);
  assert.equal((await step(e,{...body,bytes:0},{},finalPath)).status,503);
  assert.equal((await step(e,body,{Authorization:'Bearer '+randomBytes(32).toString('hex')},finalPath)).status,401);
  assert.equal((await step(e,body,{Origin:'https://isolated.invalid'},finalPath)).status,403);
  assert.equal((await step(e,{})).status,409);
  const ready=await step({...e,PROOFS_BUCKET:bucket([])}),final=readyBody(ready);
  assert.equal((await step(e,{...final,inventory_version:final.inventory_version-1},{},finalPath)).status,409);
  // Schema also rejects an old Worker clearing the pin without clearing phase.
  await assert.rejects(db.prepare('UPDATE storage_capacity SET inventory_id=NULL WHERE id=1').run());
  assert.equal((await capacityRow(db)).trusted_until,0);
});

test('concurrent page and finalize requests accumulate and audit once',async()=>{
  const e=env({PROOFS_BUCKET:{list:async()=>({objects:[{key:'a',size:3}],truncated:true,cursor:'next'})}});
  await step(e);let arrived=0,release;const gate=new Promise(r=>release=r);
  e.PROOFS_BUCKET={list:async()=>{if(++arrived===2)release();await gate;return{objects:[{key:'b',size:7}],truncated:false};}};
  const scans=await Promise.all([step(e),step(e)]);assert.deepEqual(scans.map(x=>x.status).sort(),[200,409]);
  assert.equal((await capacityRow(db)).inventory_bytes,10);
  const body=readyBody(scans.find(x=>x.status===200));
  const finals=await Promise.all([step(e,body,{},finalPath),step(e,body,{},finalPath)]);
  assert.deepEqual(finals.map(x=>x.status),[200,200]);assert.equal((await capacityRow(db)).used_bytes,10);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_history').first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_audit WHERE id=?').bind(body.inventory_id).first()).n,1);
});

test('failed final audit rolls back capacity/history/outbox; retry commits all together',async()=>{
  const e=env({PROOFS_BUCKET:bucket([{key:'x',size:9500000000}])});
  const ready=await step(e),body=readyBody(ready);
  await db.prepare("CREATE TRIGGER isolated_fail_audit BEFORE INSERT ON storage_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
  try{assert.equal((await step(e,body,{},finalPath)).status,409);}finally{await db.prepare('DROP TRIGGER isolated_fail_audit').run();}
  const row=await capacityRow(db);assert.equal(row.inventory_phase,'ready');assert.equal(row.used_bytes,0);assert.equal(row.trusted_until,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_history').first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_alerts').first()).n,0);
  assert.equal((await step(e,body,{},finalPath)).status,200);
  assert.equal((await capacityRow(db)).blocked,1);assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_alerts').first()).n,2);
  await step(e,body,{},finalPath);assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_alerts').first()).n,2);
});

test('recovery at 85 percent keeps threshold dedup and does not emit recovery for a temporary scan pin',async()=>{
  await db.prepare('UPDATE storage_capacity SET used_bytes=9500000000,blocked=1,observed_at=? WHERE id=1').bind(nowSeconds()).run();
  const episode=(await capacityRow(db)).episode;
  const e=env({PROOFS_BUCKET:bucket([{key:'historical-synthetic',size:8500000000}])});
  const ready=await step(e),body=readyBody(ready);assert.equal((await capacityRow(db)).blocked,1);
  await step(e,body,{},finalPath);
  let row=await capacityRow(db);assert.equal(row.blocked,0);assert.equal(row.cleanup_requested,0);assert.equal(row.episode,episode+1);
  const alerts=(await db.prepare('SELECT episode,kind FROM storage_alerts ORDER BY kind').all()).results;
  assert.deepEqual(alerts,[{episode,kind:'90'},{episode,kind:'95'},{episode,kind:'recovered'}]);
  await step(e,body,{},finalPath);await call(e);
  row=await capacityRow(db);assert.equal(row.episode,episode+1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_alerts').first()).n,3);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM storage_alert_deliveries').first()).n,0);
});

test('page CAS rejects each changed pin/version/phase/reservation without accumulating metadata',async()=>{
  for(const change of [
    "inventory_id='00000000-0000-4000-8000-000000000099'",
    'inventory_version=inventory_version+1',
    "inventory_phase='ready',inventory_cursor=NULL",
    'reserved_bytes=1',
  ]){
    await db.prepare("UPDATE storage_capacity SET inventory_id=NULL,inventory_phase=NULL,inventory_cursor=NULL,reserved_bytes=0 WHERE id=1").run();
    let changed;
    const e=env({PROOFS_BUCKET:{list:async()=>{
      await db.prepare('UPDATE storage_capacity SET '+change+' WHERE id=1').run();
      changed=await capacityRow(db);
      return{objects:[{key:'synthetic',size:7}],truncated:false};
    }}});
    const r=await step(e);assert.equal(r.status,409);assert.equal(r.error.code,'STORAGE_SCAN_CONFLICT');
    assert.deepEqual(await capacityRow(db),changed);assert.equal(changed.inventory_bytes,0);
    assert.equal(changed.trusted_until,0);
  }
});

test('failed atomic page update leaves cursor/totals pinned and is safe to retry',async()=>{
  const e=env({PROOFS_BUCKET:bucket([{key:'synthetic',size:7}])});
  await db.prepare("CREATE TRIGGER isolated_fail_page BEFORE UPDATE OF inventory_bytes ON storage_capacity WHEN NEW.inventory_bytes>OLD.inventory_bytes BEGIN SELECT RAISE(ABORT,'synthetic page failure'); END").run();
  try{assert.equal((await step(e)).status,409);}finally{await db.prepare('DROP TRIGGER isolated_fail_page').run();}
  const before=await capacityRow(db);assert.equal(before.inventory_bytes,0);assert.equal(before.inventory_count,0);
  assert.equal(before.inventory_phase,'scan');assert.equal(before.trusted_until,0);
  const done=await step(e);assert.equal(done.data.inventory.scanned,1);
  assert.equal((await capacityRow(db)).inventory_bytes,7);assert.equal((await capacityRow(db)).inventory_id,before.inventory_id);
});

test('lost page update ACK resumes the durable next cursor without double accumulation',async()=>{
  let lost=false;const cursors=[];
  const flaky={prepare:sql=>{
    const wrap=s=>new Proxy(s,{get(t,k){
      if(k==='bind')return(...args)=>wrap(t.bind(...args));
      if(k==='first'&&sql.includes('RETURNING inventory_version'))return async()=>{
        const result=await t.first();if(!lost){lost=true;throw Error('synthetic ACK lost after commit');}return result;
      };
      const value=t[k];return typeof value==='function'?value.bind(t):value;
    }});return wrap(db.prepare(sql));
  }};
  const e=env({DB:flaky,PROOFS_BUCKET:{list:async({cursor})=>{
    cursors.push(cursor??null);return cursor?{objects:[{key:'b',size:7}],truncated:false}
      :{objects:[{key:'a',size:3}],truncated:true,cursor:'next'};
  }}});
  assert.equal((await step(e)).status,409);
  assert.equal((await capacityRow(db)).inventory_bytes,3);assert.equal((await capacityRow(db)).inventory_cursor,'next');
  const ready=await step(e);assert.equal(ready.data.inventory.scanned,2);
  const row=await capacityRow(db);assert.equal(row.inventory_bytes,10);assert.equal(row.used_bytes,0);assert.equal(row.trusted_until,0);
  assert.deepEqual(cursors,[null,'next']);
});
