import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {driveConfigFixture,countDatabase,driveMock} from '../scripts/lib/drive-backup-fixture.mjs';
import {ensureCaseBackups,backfillBackups} from '../src/lib/proof-backup-store.js';
import {backupReadiness} from '../src/lib/google-drive.js';
import {processBackups,MAX_GOOGLE_REQUESTS} from '../src/lib/proof-backup-processor.js';
import worker from '../src/index.js';
let h,admin;const google=driveMock();
// Workers supplies this Web Crypto extension; Node uses the identical primitive.
crypto.subtle.timingSafeEqual ??= (a,b)=>timingSafeEqual(Buffer.from(a),Buffer.from(b));
before(async()=>{h=await localAdminRuntime({backupService:google.service});admin=await h.identity({role:'admin'});});
after(async()=>{await h.local.runtime.dispose();});
const env = () => ({...h.local.authConfig,...driveConfigFixture(),DB:h.local.db,PROOFS_BUCKET:h.local.bucket});
const lookup = id => h.local.db.prepare('SELECT * FROM proof_backups WHERE id=?').bind(id).first();
async function fresh(){
  if(h.local.authConfig.GOOGLE_DRIVE_BACKUP_ENABLED)await h.local.setAuthConfig({GOOGLE_DRIVE_BACKUP_ENABLED:undefined});
  await h.local.db.batch(['DELETE FROM proof_backups','DELETE FROM drive_backup_folders','DELETE FROM backup_processor_lock'].map(sql=>h.local.db.prepare(sql)));
  const c=await h.makeCase(),e=env();await ensureCaseBackups(e,c.id);
  const b=await h.local.db.prepare('SELECT b.* FROM proof_backups b JOIN case_files f ON f.id=b.file_id WHERE f.case_id=?').bind(c.id).first();
  return {c,e,b};
}
async function api(e,id,body={},actor=admin,action='process'){
  const path=action==='backfill'?'/api/admin/backups/backfill':`/api/admin/backups/${id}/${action}`;
  const request=new Request('https://voteproof.example'+path,{method:'POST',headers:{...actor?.headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
  return worker.fetch(request,e);
}
test('readiness is exact, fail closed and credential-free',()=>{
  const config=driveConfigFixture();assert.equal(backupReadiness(config).ready,true);
  for(const flag of [undefined,false,true,'false','1','yes','TRUE',' true','true '])assert.equal(backupReadiness({...config,GOOGLE_DRIVE_BACKUP_ENABLED:flag}).ready,false);
  for(const key of Object.keys(config).filter(k=>k!=='GOOGLE_DRIVE_BACKUP_ENABLED'))for(const value of [undefined,'',' ','bad\nvalue']){
    const r=backupReadiness({...config,[key]:value});assert.equal(r.ready,false);assert.equal(r.state,'not_configured');
    assert.deepEqual(Object.keys(r),['enabled','configured','ready','state']);
  }
});
test('disabled/incomplete direct API mutation and enqueue reject with zero Google/R2 changes',async()=>{
  const {e,b,c}=await fresh(),mock=driveMock(),oldFetch=globalThis.fetch;globalThis.fetch=(url,init)=>/\.googleapis\.com$/.test(new URL(url).hostname)?mock.fetcher(url,init):oldFetch(url,init);
  try{
    const variants=[...['false','1','yes','TRUE',' true',undefined].map(flag=>({GOOGLE_DRIVE_BACKUP_ENABLED:flag})),
      ...['CLIENT_ID','CLIENT_SECRET','REFRESH_TOKEN','ROOT_FOLDER_ID'].flatMap(k=>[undefined,'','bad\nvalue'].map(value=>({['GOOGLE_DRIVE_'+k]:value})))];
    for(const patch of variants){
      const disabled={...e,...patch},before=await lookup(b.id);let reads=0;
      disabled.PROOFS_BUCKET={head(){reads++;assert.fail('mutation performed R2 read');},get(){assert.fail('R2 get');}};
      for(const [action,body] of [['retry',{expected_version:0}],['process',{}],['backfill',{dry_run:false,file_ids:[b.file_id]}]]){
        const off=Object.hasOwn(patch,'GOOGLE_DRIVE_BACKUP_ENABLED');
        const r=await api(disabled,b.id,body,admin,action);assert.equal(r.status,off?409:503);
        assert.equal((await r.json()).error.code,off?'DRIVE_BACKUP_DISABLED':'DRIVE_BACKUP_NOT_CONFIGURED');
      }
      await ensureCaseBackups(disabled,c.id);await assert.rejects(backfillBackups(disabled,{dryRun:false}));
      assert.deepEqual(await lookup(b.id),before);assert.equal(reads,0);
    }
    assert.equal(mock.state.calls,0);
    assert.equal((await api({...e,GOOGLE_DRIVE_BACKUP_ENABLED:'false'},b.id,{dry_run:true},admin,'backfill')).status,200);
  }finally{globalThis.fetch=oldFetch;}
});
test('manual executor enforces role/session/MFA/CSRF, exact ID and rejects source overrides',async()=>{
  const {e,b}=await fresh(),mock=driveMock(),oldFetch=globalThis.fetch;globalThis.fetch=(url,init)=>/\.googleapis\.com$/.test(new URL(url).hostname)?mock.fetcher(url,init):oldFetch(url,init);
  try{
    for(const options of [{},{role:'reviewer'},{role:'admin',elevated:false},{role:'admin',revoked:true},{role:'admin',expired:true},{role:'admin',status:'suspended'}]){
      const actor=await h.identity(options),r=await api(e,b.id,{},actor);assert.ok([401,403].includes(r.status));
    }
    assert.equal((await api(e,b.id,{},null)).status,401);
    assert.equal((await api(e,b.id,{}, {...admin,headers:{...admin.headers,'X-CSRF-Token':'invalid'}})).status,403);
    assert.equal((await api(e,b.id,{}, {...admin,headers:{...admin.headers,Origin:'https://evil.example'}})).status,403);
    assert.equal((await api(e,randomUUID())).status,404);
    assert.equal((await api(e,'invalid')).status,400);
    for(const body of [null,[],true,'invalid',{object_key:'arbitrary.png'},{file_id:randomUUID()},{backup_id:randomUUID()},{max_jobs:20}])assert.equal((await api(e,b.id,body)).status,400);
    assert.equal(mock.state.calls,0);assert.equal((await lookup(b.id)).status,'pending');
  }finally{globalThis.fetch=oldFetch;}
});
test('manual audit and claim are atomic; failed audit never starts Google',async()=>{
  const {e,b}=await fresh(),mock=driveMock(),oldFetch=globalThis.fetch;globalThis.fetch=(url,init)=>/\.googleapis\.com$/.test(new URL(url).hostname)?mock.fetcher(url,init):oldFetch(url,init);
  await e.DB.prepare("CREATE TRIGGER local_process_audit_failure BEFORE INSERT ON backup_admin_audit BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
  try{assert.equal((await api(e,b.id)).status,503);assert.deepEqual(await lookup(b.id),b);assert.equal(mock.state.calls,0);}
  finally{await e.DB.prepare('DROP TRIGGER local_process_audit_failure').run();globalThis.fetch=oldFetch;}
});
test('complete application D1 budgets include auth, all helpers and every atomic batch statement',async t=>{
  const {e}=await fresh(),mock=driveMock(),meter=countDatabase(e.DB),measured={};e.DB=meter.db;
  await h.local.db.prepare('DELETE FROM proof_backups').run();
  meter.reset();assert.equal((await processBackups(e,{fetcher:mock.fetcher})).state,'idle');measured.scheduled_idle=meter.queries;
  const add=async()=>{const c=await h.makeCase();await ensureCaseBackups(env(),c.id);return h.local.db.prepare('SELECT b.id FROM proof_backups b JOIN case_files f ON f.id=b.file_id WHERE f.case_id=?').bind(c.id).first();};
  const oldFetch=globalThis.fetch;globalThis.fetch=(url,init)=>/\.googleapis\.com$/.test(new URL(url).hostname)?mock.fetcher(url,init):oldFetch(url,init);
  const run=async(label,manual=false)=>{
    const b=await add();meter.reset();const report=manual?await (await api(e,b.id)).json():await processBackups(e,{fetcher:mock.fetcher});
    measured[label]=meter.queries;assert.equal(manual?report.data.confirmed:report.confirmed,1,JSON.stringify(report));return b;
  };
  try{
    await run('scheduled_cold');await run('scheduled_warm');await run('manual_warm',true);
    await h.local.db.prepare('DELETE FROM drive_backup_folders').run();const b=await run('manual_cold',true);
    meter.reset();const calls=mock.state.calls,already=await (await api(e,b.id)).json();assert.equal(already.data.state,'already_confirmed');assert.equal(mock.state.calls,calls);
    const audit=await h.local.db.prepare('SELECT * FROM backup_admin_audit WHERE target_id=? ORDER BY affected_count DESC').bind('process:'+b.id).all();
    assert.deepEqual(audit.results.map(x=>x.affected_count),[1,0]);
    const retry=await add();mock.state.fail='upload';meter.reset();const failed=await api(e,retry.id);assert.equal((await failed.json()).data.error_code,'GOOGLE_UNAVAILABLE');measured.retry_failure=meter.queries;
    mock.state.fail=null;meter.reset();assert.equal((await (await api(e,retry.id)).json()).data.confirmed,1);measured.retry_recovery=meter.queries;
    await add();mock.state.fail='auth';meter.reset();assert.equal((await processBackups(e,{fetcher:mock.fetcher})).error_code,'OAUTH_REVOKED');measured.permanent_failure=meter.queries;
    assert.ok(measured.scheduled_idle<=5);for(const [label,count] of Object.entries(measured))assert.ok(count<=35,`${label}: ${count}`);
    t.diagnostic(JSON.stringify({local_only:true,d1_queries:measured,actual_production_cpu:'canary gate'}));
  }finally{globalThis.fetch=oldFetch;}
});
test('simultaneous different jobs share reserved folders; same-job manual/scheduled cannot duplicate',async()=>{
  const {e,b}=await fresh(),mock=driveMock(),oldFetch=globalThis.fetch;globalThis.fetch=(url,init)=>/\.googleapis\.com$/.test(new URL(url).hostname)?mock.fetcher(url,init):oldFetch(url,init);
  try{
    const c=await h.makeCase();await ensureCaseBackups(e,c.id);
    const responses=await Promise.all([api(e,b.id),processBackups(e,{fetcher:mock.fetcher})]);
    assert.equal((await lookup(b.id)).status,'confirmed');
    // A race may select the second job or find the first already leased.
    await processBackups(e,{fetcher:mock.fetcher});assert.equal(mock.state.uploads,2);assert.equal(mock.state.folders,2);
    assert.equal((await e.DB.prepare("SELECT count(*) n FROM proof_backups WHERE status='confirmed'").first()).n,2);
    assert.ok([200,409].includes(responses[0].status));
  }finally{globalThis.fetch=oldFetch;}
});
test('authoritative source tampering and session revocation stop processing safely',async()=>{
  let {e,b}=await fresh(),mock=driveMock(),oldFetch=globalThis.fetch;globalThis.fetch=(url,init)=>/\.googleapis\.com$/.test(new URL(url).hostname)?mock.fetcher(url,init):oldFetch(url,init);
  try{
    await e.DB.prepare("UPDATE proof_backups SET source_object_key='arbitrary.png' WHERE id=?").bind(b.id).run();
    assert.equal((await (await api(e,b.id)).json()).data.error_code,'SOURCE_CHANGED');assert.equal(mock.state.calls,0);
    ({e,b}=await fresh());mock.state.hook=async()=>{await e.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?').bind(Math.floor(Date.now()/1000),admin.hash).run();mock.state.hook=null;};
    assert.equal((await (await api(e,b.id)).json()).data.confirmed,0);assert.equal(mock.state.calls,1);assert.equal(mock.state.uploads,0);
  }finally{globalThis.fetch=oldFetch;await h.local.db.prepare('UPDATE auth_sessions SET revoked_at=NULL WHERE token_hash=?').bind(admin.hash).run();}
});
test('token refresh storm is bounded, keeps failure/backoff and remains below 35 queries',async t=>{
  const {e,b}=await fresh(),mock=driveMock(),meter=countDatabase(e.DB),oldFetch=globalThis.fetch;e.DB=meter.db;
  globalThis.fetch=async(url,init)=>{
    if(!/\.googleapis\.com$/.test(new URL(url).hostname))return oldFetch(url,init);
    const r=await mock.fetcher(url,init);if(new URL(url).hostname==='oauth2.googleapis.com'){
      const value=await r.json();return Response.json({...value,expires_in:60.000001});
    }return r;
  };
  try{const result=await (await api(e,b.id)).json();assert.equal(result.data.confirmed,0);assert.ok(mock.state.calls<=MAX_GOOGLE_REQUESTS);assert.ok(meter.queries<=35);assert.ok((await lookup(b.id)).next_attempt_at);
    t.diagnostic(JSON.stringify({refresh_storm_queries:meter.queries,google_calls:mock.state.calls}));}
  finally{globalThis.fetch=oldFetch;}
});
test('real local Worker manual endpoint streams one proof, records audit and replay is read-only',async()=>{
  const {c,b}=await fresh();await h.local.setAuthConfig(driveConfigFixture());
  await h.local.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
  const snapshot=async()=>Object.fromEntries(await Promise.all(['cases','point_transactions','admin_memberships','campaigns'].map(async table=>[table,
    (await h.local.db.prepare('SELECT * FROM '+table).all()).results])));
  const preserved=await snapshot();
  const path='/api/admin/backups/'+b.id+'/process';
  const before=google.state.uploads;let r=await h.local.fetch(path,'POST',{},admin.headers);assert.equal(r.status,200);
  assert.equal((await r.json()).data.confirmed,1);assert.equal(google.state.uploads,before+1);
  r=await h.local.fetch(path,'POST',{},admin.headers);assert.equal((await r.json()).data.state,'already_confirmed');assert.equal(google.state.uploads,before+1);
  await h.local.setAuthConfig(driveConfigFixture()); // Restart the actual workerd runtime.
  r=await h.local.fetch(path,'POST',{},admin.headers);assert.equal((await r.json()).data.state,'already_confirmed');assert.equal(google.state.uploads,before+1);
  assert.deepEqual(await snapshot(),preserved);assert.ok(await h.local.bucket.head(b.source_object_key));
  assert.equal((await h.local.db.prepare('SELECT submissions_enabled FROM submission_settings WHERE id=1').first()).submissions_enabled,0);
  assert.equal((await h.local.db.prepare('SELECT status FROM cases WHERE id=?').bind(c.id).first()).status,'pending');
  assert.deepEqual((await h.local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  assert.equal((await h.local.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
  assert.deepEqual(h.local.unexpectedUpstreams,[]);
});
