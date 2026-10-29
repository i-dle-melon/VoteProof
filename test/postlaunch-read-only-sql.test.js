import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
import{isReadOnlySQL}from'../src/lib/read-only-sql.js';
import{fencedRequest}from'../src/lib/prelaunch-reset-fence.js';
import{embeddedCaseRuntime,origin}from'./helpers/embedded-case-runtime.mjs';
import{installResetExtensionLocal}from'../scripts/lib/prelaunch-selective-reset.mjs';

test('trusted SELECT CTE shapes accept literals/comments, materialization, column lists and nested SELECTs',()=>{
 for(const sql of [
  'WITH recent AS MATERIALIZED (SELECT rowid AS seq FROM storage_audit ORDER BY rowid DESC LIMIT 1001), picked AS MATERIALIZED (SELECT * FROM recent LIMIT 1000) SELECT COUNT(*) FROM picked',
  `-- local comment\nWITH "recent"(a,b) AS NOT MATERIALIZED (SELECT 'UPDATE; DELETE '' quoted',1 /* INSERT */) SELECT * FROM "recent";`,
  'WITH x AS (WITH y AS (SELECT 1) SELECT * FROM y) SELECT * FROM x',
  'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<3) SELECT * FROM x',
  'SELECT 1','/* comment */ EXPLAIN SELECT 1',
 ])assert.equal(isReadOnlySQL(sql),true,sql);
});
test('data-changing, multi-statement, malformed and unsupported WITH cannot bypass the Fence',()=>{
 for(const sql of [
  'INSERT INTO members VALUES(1)','UPDATE submission_settings SET submissions_enabled=1','DELETE FROM members',
  'WITH x AS(SELECT 1) UPDATE submission_settings SET submissions_enabled=1',
  'WITH x AS(SELECT 1) DELETE FROM members',
  'WITH x AS(SELECT 1) INSERT INTO storage_audit SELECT * FROM x',
  'WITH x AS(UPDATE members SET nickname=1 RETURNING *) SELECT * FROM x',
  'WITH x AS(DELETE FROM members RETURNING *) SELECT * FROM x',
  'WITH x AS(SELECT 1) SELECT 1; DELETE FROM members',
  'WITH x AS(SELECT 1) SELECT load_extension(?)',
  'WITH x AS(SELECT 1) PRAGMA foreign_keys=OFF','WITH x AS(VALUES(1)) SELECT * FROM x',
  'WITH x AS(SELECT 1 SELECT * FROM x',"WITH x AS(SELECT 'unclosed) SELECT * FROM x",'WITH x AS(SELECT 1) SELECT 1 /* unterminated',
 ])assert.equal(isReadOnlySQL(sql),false,sql);
});
async function setup(t){
 const rt=await embeddedCaseRuntime();t.after(()=>rt.close());const actor=await rt.identity('super_admin');
 installResetExtensionLocal(rt.sqlite,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));
 rt.sqlite.exec("UPDATE prelaunch_reset_control SET epoch=1,mode='open'");rt.env.PRELAUNCH_RESET_FENCE_ENABLED='true';return{...rt,actor};
}
for(const mode of ['open','maintenance'])test('real health summary/events in '+mode+' create no operation or permit writes; member/security state unchanged',async t=>{
 const f=await setup(t);f.sqlite.prepare('UPDATE prelaunch_reset_control SET mode=?').run(mode);
 const protectedRows=()=>['members','auth_sessions','admin_memberships','submission_settings','storage_capacity'].map(n=>f.sqlite.prepare('SELECT * FROM '+n).all());
 const before=protectedRows(),changes=f.sqlite.prepare('SELECT total_changes() n').get().n;
 for(const path of ['/api/health','/api/admin/health-monitor/summary','/api/admin/health-monitor/events','/api/admin/health-monitor/events?type=backup&status=pending&from=2026-10-29&to=2026-10-29']){
  const r=await f.fetch(path,'GET',undefined,f.actor.headers);assert.equal(r.status,200,await r.clone().text());const b=await r.json();
  if(path.includes('summary')){assert.equal(b.data.pending_operations.count,null);assert.equal(b.data.upload_failures.count,null);assert.equal(b.data.coverage.legacy_delete_ack,'unknown');}
 }
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM prelaunch_reset_operations').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM prelaunch_reset_permit').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n,changes);assert.deepEqual(protectedRows(),before);
});
test('health retains anonymous/reviewer/MFA denial before expensive CTE reads',async t=>{
 const f=await setup(t);
 // Separate synthetic identities are seeded through a legal server permit.
 const denied=await f.fetch('/api/admin/health-monitor/summary');assert.equal(denied.status,401);
 f.sqlite.exec("UPDATE prelaunch_reset_control SET mode='open'");
 const row=f.sqlite.prepare('SELECT role FROM admin_memberships').get();assert.equal(row.role,'super_admin');
 // A fixture-only transaction changes role/elevation with the existing scoped permit.
 const req=new Request(origin+'/api/local-fixture',{method:'POST'});
 await fencedRequest(f.env,req,async env=>{await env.DB.prepare("UPDATE admin_memberships SET role='reviewer'").run();return Response.json({ok:true});});
 assert.equal((await f.fetch('/api/admin/health-monitor/summary','GET',undefined,f.actor.headers)).status,403);
 await fencedRequest(f.env,req,async env=>{await env.DB.prepare("UPDATE admin_memberships SET role='super_admin'").run();await env.DB.prepare('UPDATE auth_sessions SET elevated_until=0').run();return Response.json({ok:true});});
 const r=await f.fetch('/api/admin/health-monitor/summary','GET',undefined,f.actor.headers);assert.equal(r.status,403);assert.equal((await r.json()).error.code,'ADMIN_STEP_UP_REQUIRED');
});
test('actual modifying WITH is admitted as a mutation in open mode and blocked in maintenance',async t=>{
 const f=await setup(t),sql='WITH x AS (SELECT 1) UPDATE submission_settings SET submissions_enabled=1 WHERE id=1';
 const run=()=>fencedRequest(f.env,new Request(origin+'/api/local-cte',{method:'GET'}),async env=>{await env.DB.prepare(sql).run();return Response.json({ok:true});});
 assert.equal((await run()).status,200);assert.equal(f.sqlite.prepare('SELECT submissions_enabled n FROM submission_settings').get().n,1);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='completed'").get().n,1);
 f.sqlite.exec("UPDATE prelaunch_reset_control SET mode='maintenance'");await assert.rejects(run());
 assert.equal(f.sqlite.prepare('SELECT submissions_enabled n FROM submission_settings').get().n,1);
});
test('ordinary zero-change writes are not granted the admission-only no-op exception',async t=>{
 const f=await setup(t);
 const r=await fencedRequest(f.env,new Request(origin+'/api/local-noop',{method:'POST'}),async env=>{
  await env.DB.prepare("UPDATE members SET nickname='not changed' WHERE 0").run();
  return Response.json({ok:false},{status:503});
 });assert.equal(r.status,503);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").get().n,1);
});
test('health read failure remains sanitized 503 without inventing an UNKNOWN write operation',async t=>{
 const f=await setup(t),raw=f.env.DB;let failed=false;
 f.env.DB={...raw,batch:async statements=>{if(statements.some(s=>/^WITH\b/i.test(s.sql.trim()))){failed=true;throw Error('synthetic private diagnostic');}return raw.batch(statements);}};
 const r=await f.fetch('/api/admin/health-monitor/summary','GET',undefined,f.actor.headers);
 assert.equal(r.status,503);assert.equal(failed,true);assert.equal((await r.text()).includes('synthetic private diagnostic'),false);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM prelaunch_reset_operations').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM prelaunch_reset_permit').get().n,0);
});
