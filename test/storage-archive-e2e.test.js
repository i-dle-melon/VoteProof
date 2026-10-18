import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {unstable_splitSqlQuery} from 'wrangler';
import {localCaseRuntime} from '../scripts/lib/local-case-runtime.mjs';
import worker from '../scripts/lib/archive-isolated-worker.mjs';
import {fixtures,fixtureSQL,fixtureSchema,image,digest,quote} from '../scripts/lib/archive-isolated-fixtures.mjs';
import {scenarios,runScenario} from '../scripts/lib/archive-acceptance.mjs';
let local,db,adapter,mainEnv;
const proof=image(1048576),sha=digest(proof),pool=fixtures([...scenarios.map(([name])=>[name,1]),['pure-profile',1],['seed-retry',1]]);
const secret=randomBytes(32).toString('hex'),access=randomUUID(),relayAccess=randomUUID(),origin='https://archive-isolated.invalid',relayOrigin='https://archive-relay.invalid';
const sql=async(text,args=[])=>{const r=await db.prepare(text).bind(...args).all();return r.results;};
before(async()=>{
  local=await localCaseRuntime({seedCampaign:false,submissionsEnabled:false});db=local.db;
  await db.batch(unstable_splitSqlQuery(fixtureSchema).map(s=>db.prepare(s)));
  const stamp=new Date().toISOString();
  await db.prepare("INSERT INTO campaigns(campaign_id,name,category,solo_target,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at) VALUES('ISOLATED','Synthetic','Solo','synthetic','2000-01-01','2100-01-01','UTC','2000-01-01','2099-12-31',0,NULL,'active',?,?)").bind(stamp,stamp).run();
  await db.prepare("INSERT INTO members(id,member_id,login_name,nickname,player_id,status,created_at,updated_at,last_login_at) VALUES(?,'SYNTHETIC-ADMIN',?,'Synthetic','synthetic_archive_admin','active',?,?,?)").bind(randomUUID(),randomUUID().replaceAll('-',''),stamp,stamp,stamp).run();
  await db.prepare("INSERT INTO drive_backup_folders VALUES('synthetic_root','campaign:synthetic','synthetic_campaign','synthetic_root','Synthetic',?)").bind(Math.floor(Date.now()/1000)).run();
  const triggers=await sql("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN('submissions_cases_insert','submissions_uploads_insert','submissions_upload_files_insert') ORDER BY name");
  for(const t of triggers)await db.prepare('DROP TRIGGER '+t.name).run();
  for(const f of pool)await db.batch(unstable_splitSqlQuery(fixtureSQL(f,sha)).map(s=>db.prepare(s)));
  for(const t of triggers)await db.prepare(t.sql).run();
  // Node-created Request streams lack workerd's fixed-length branding. Only the
  // local fixture PUT adapter buffers them; cloud uses the native request stream.
  const bucket=new Proxy(local.bucket,{get(target,key){if(key==='put')return async(k,body,options)=>target.put(k,body?.getReader?await new Response(body).arrayBuffer():body,options);return typeof target[key]==='function'?target[key].bind(target):target[key];}});
  const common={DB:db,PROOFS_BUCKET:bucket,GOOGLE_DRIVE_BACKUP_ENABLED:'true',DRIVE_BACKUP_RELAY_SECRET:secret,
    DRIVE_COLD_RELAY_URL:'https://script.google.com/macros/s/isolated_archive/exec',TEST_EXPIRES:String(Date.now()+3600000),TEST_VERSION:'local',
    R2_EXCLUSIVE_WRITER_CONFIRMED:'true',STORAGE_CLEANUP_LIVE_ENABLED:'true'};
  const relayEnv={...common,TEST_ROLE:'relay',TEST_ACCESS:relayAccess,TEST_ORIGIN:relayOrigin};
  mainEnv={...common,TEST_ROLE:'reader',TEST_ACCESS:access,TEST_ORIGIN:origin,MOCK_ORIGIN:relayOrigin,RELAY_ACCESS:relayAccess,MOCK_RELAY:{fetch:r=>worker.fetch(r,relayEnv)}};
  const call=async(path,method='POST',body,mode='normal',expected=200,profile='instrumented')=>{
    const r=await worker.fetch(new Request(origin+path,{method,headers:{'X-Isolated-Access':access,Authorization:'Bearer '+secret,'X-Test-Mode':mode,
      'X-Test-Profile':profile,...(body?{'Content-Length':String(body.length)}:{})},...(body?{body}:{})}),mainEnv);
    assert.equal(r.status,expected,await r.clone().text());return r.status===200?r.json():{};
  };
  adapter={sql,
    seed:f=>call('/seed/'+f.label,'PUT',proof),
    call:(mode,expected)=>call('/archive','POST',undefined,mode,expected),
    putProbe:()=>call('/capacity-put'),
    snapshot:async f=>({exists:!!await local.bucket.head(f.key),archive:(await sql('SELECT * FROM cold_proofs WHERE file_id=?',[f.file]))[0]??null,
      backup:(await sql('SELECT * FROM proof_backups WHERE file_id=?',[f.file]))[0],audit:(await sql("SELECT count(*) n FROM storage_audit WHERE target=? AND action='archive_r2_deleted'",[f.file]))[0].n}),
    inventory:()=>call('/inventory'),pure:()=>call('/archive','POST',undefined,'normal',200,'pure')};
});
after(async()=>{await local?.runtime.dispose();});
for(const [name,run] of scenarios)test('archive isolated E2E: '+name,async()=>{
  const f=pool.find(f=>f.label===name);await runScenario(adapter,f,name,run);
});
test('pure CPU profile keeps real deletion and security path without pretending to count SDK operations',async()=>{
  const f=pool.find(f=>f.label==='pure-profile');await adapter.seed(f);const r=await adapter.pure();
  assert.equal(r.result.state,'cold');assert.equal(r.file_id,f.file);assert.equal(r.counters.instrumented,false);
  assert.equal(r.counters.statements,null);assert.equal(r.counters.r2,null);assert.equal(r.counters.relay,2);
  const snapshot=await adapter.snapshot(f);assert.equal(snapshot.exists,false);assert.equal(snapshot.archive.state,'cold');assert.equal(snapshot.audit,1);
});
test('synthetic seed retry preserves object version and cannot reset an archived pin',async()=>{
  const f=pool.find(f=>f.label==='seed-retry');const first=await adapter.seed(f),retry=await adapter.seed(f);
  assert.equal(first.version,retry.version);assert.equal(first.etag,retry.etag);
  const r=await adapter.call('normal');assert.equal(r.result.state,'cold');assert.equal(r.file_id,f.file);
  await assert.rejects(adapter.seed(f));assert.equal((await adapter.snapshot(f)).archive.state,'cold');
});

test('archive inventory reconciles actual bytes and preserves Drive rows, OFF and immutable audit',async()=>{
  const backups=(await sql('SELECT count(*) n FROM proof_backups'))[0].n;
  await sql('UPDATE storage_capacity SET blocked=1,reserved_bytes=0,used_bytes=9500000000,trusted_until=0,observed_at=? WHERE id=1',[Math.floor(Date.now()/1000)]);
  const r=await adapter.inventory();assert.equal(r.complete,true);
  const actual=await local.bucket.list(),total=actual.objects.reduce((n,x)=>n+x.size,0);
  const cap=(await sql('SELECT * FROM storage_capacity'))[0];assert.equal(cap.used_bytes,total);assert.equal(cap.cleanup_requested,0);assert.equal(cap.blocked,0);
  assert.equal((await sql('SELECT count(*) n FROM proof_backups'))[0].n,backups);
  assert.equal((await sql('SELECT submissions_enabled FROM submission_settings'))[0].submissions_enabled,0);
  assert.equal((await sql('PRAGMA foreign_key_check')).length,0);
  assert.equal((await sql('PRAGMA quick_check'))[0].quick_check,'ok');
  await assert.rejects(sql("UPDATE storage_audit SET action='tamper'"));
});
