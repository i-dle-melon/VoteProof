import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import worker from '../src/index.js';
import {embeddedCaseRuntime,origin} from './helpers/embedded-case-runtime.mjs';
import {installResetExtensionLocal} from '../scripts/lib/prelaunch-selective-reset.mjs';
import {csrfToken,memberSession} from '../src/lib/auth-session.js';

const tick='/api/internal/drive-backup/storage/tick',finish='/api/internal/drive-backup/storage/inventory/finalize';
const sql=fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8');
async function setup(t,{count=178}={}){
 const rt=await embeddedCaseRuntime();t.after(()=>rt.close());
 const admin=await rt.identity('super_admin');
 rt.sqlite.exec('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1');
 rt.sqlite.prepare('UPDATE storage_capacity SET used_bytes=?,inventory_count=? WHERE id=1').run(count*(count+1)/2,count);
 installResetExtensionLocal(rt.sqlite,sql);
 rt.sqlite.prepare("UPDATE prelaunch_reset_control SET epoch=1,mode='maintenance',version=3,run_id=?").run(randomUUID());
 rt.env.PRELAUNCH_RESET_FENCE_ENABLED='true';rt.env.R2_EXCLUSIVE_WRITER_CONFIRMED='true';
 const objects=Array.from({length:count},(_,i)=>({key:'synthetic/'+String(i).padStart(4,'0'),size:i+1}));
 const calls=[];let beforeList=async()=>{};
 rt.env.PROOFS_BUCKET={list:async options=>{
  calls.push(options);await beforeList();const start=Number(options.cursor??0),end=start+options.limit,more=end<objects.length;
  return{objects:objects.slice(start,end),truncated:more,...(more?{cursor:String(end)}:{})};
 },put:()=>assert.fail('No image PUT'),delete:()=>assert.fail('No image DELETE'),get:()=>assert.fail('No image GET'),head:()=>assert.fail('No image HEAD')};
 const headers={Authorization:'Bearer '+rt.env.DRIVE_BACKUP_RELAY_SECRET,'X-VoteProof-Reset-Epoch':'1'};
 const read=q=>({...rt.sqlite.prepare(q).get()});
 const capacity=()=>read('SELECT * FROM storage_capacity WHERE id=1');
 const control=()=>read('SELECT * FROM prelaunch_reset_control WHERE id=1');
 const send=async(path=tick,body={inventory_only:true},extra={})=>{const r=await rt.fetch(path,'POST',body,{...headers,...extra});return{status:r.status,...await r.json()};};
 const ready=async()=>{let r;for(let n=0;n<Math.ceil(count/50)||n===0;n++){r=await send();assert.equal(r.status,200,JSON.stringify(r));}assert.equal(r.data.inventory.phase,'finalize');return{inventory_id:r.data.inventory.inventory_id,inventory_version:r.data.inventory.inventory_version};};
 const unscopedFrozen=()=>{
  assert.throws(()=>rt.sqlite.prepare("UPDATE members SET nickname='blocked'").run(),/PRELAUNCH_WRITE_FENCED/);
  assert.throws(()=>rt.sqlite.prepare('UPDATE submission_settings SET submissions_enabled=1').run(),/PRELAUNCH_WRITE_FENCED/);
  assert.throws(()=>rt.sqlite.prepare('UPDATE storage_capacity SET used_bytes=0').run(),/PRELAUNCH_WRITE_FENCED/);
  assert.equal(read('SELECT COUNT(*) n FROM prelaunch_reset_permit').n,0);
 };
 return{...rt,admin,objects,calls,headers,read,capacity,control,send,ready,unscopedFrozen,setBeforeList:f=>{beforeList=f;}};
}

test('178 objects: four real HTTP scans and a separate finalization preserve full freeze and atomic receipt',async t=>{
 const f=await setup(t),before=f.control(),members=f.sqlite.prepare('SELECT * FROM members ORDER BY id').all();
 for(let n=0;n<4;n++){
  const r=await f.send();assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.inventory.complete,false);
  assert.equal(r.data.inventory.phase,n===3?'finalize':'scan');assert.equal(r.data.cleanup,null);
  assert.equal(f.capacity().trusted_until,0);assert.deepEqual(f.control(),before);f.unscopedFrozen();
  assert.equal(f.read('SELECT COUNT(*) n FROM storage_history').n,0);
 }
 const row=f.capacity(),body={inventory_id:row.inventory_id,inventory_version:row.inventory_version};
 const r=await f.send(finish,body);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.inventory.complete,true);
 assert.equal(r.data.inventory.bytes,15931);assert.equal(r.data.alerts.state,'skipped_inventory_only');
 const cap=f.capacity();assert.equal(cap.used_bytes,15931);assert.equal(cap.inventory_count,178);assert.equal(cap.inventory_id,null);
 assert.equal(cap.trusted_until-cap.observed_at,600);assert.equal(cap.anomaly,null);
 assert.deepEqual(f.calls.map(x=>x.limit),[50,50,50,50]);assert.deepEqual(f.calls.map(x=>x.cursor??null),[null,'50','100','150']);
 const receipt=f.read("SELECT a.id,a.action,a.target,a.detail,h.bytes FROM storage_audit a JOIN storage_history h ON h.id=a.id");
 assert.equal(receipt.id,body.inventory_id);assert.equal(receipt.target,body.inventory_id);assert.equal(receipt.action,'inventory');
 assert.equal(JSON.parse(receipt.detail).inventory_version,body.inventory_version);assert.equal(receipt.bytes,15931);
 assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='completed'").n,5);
 assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state!='completed'").n,0);
 assert.equal(f.read('SELECT COUNT(*) n FROM auth_atomic_guards').n,0);
 assert.equal(f.read('SELECT submissions_enabled FROM submission_settings').submissions_enabled,0);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM members ORDER BY id').all(),members);assert.deepEqual(f.control(),before);f.unscopedFrozen();
 assert.throws(()=>f.sqlite.prepare('DELETE FROM storage_audit').run(),/immutable|FENCED/);
});

test('Relay authentication, server-only Origin, epoch, payload and route checks admit no unauthorized operation',async t=>{
 const f=await setup(t,{count:1});
 for(const [path,body,headers]of [
  [tick,{inventory_only:true},{Authorization:'Bearer '+'0'.repeat(64)}],
  [tick,{inventory_only:true},{Origin:origin}],
  [tick,{inventory_only:true},{'X-VoteProof-Reset-Epoch':'0'}],
  [tick,{},{}],[tick,{inventory_only:false},{}],[tick,{inventory_only:true,extra:1},{}],
  [finish,{inventory_id:randomUUID(),inventory_version:1,bytes:0},{}],
  [tick+'?extra=1',{inventory_only:true},{}],
 ])assert.notEqual((await f.send(path,body,headers)).status,200);
 assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_operations').n,0);assert.equal(f.calls.length,0);f.unscopedFrozen();
});

test('Admin/MFA/CSRF session cannot substitute for Relay authorization',async t=>{
 const f=await setup(t,{count:1});const r=await f.fetch(tick,'POST',{inventory_only:true},{...f.admin.headers,'X-VoteProof-Reset-Epoch':'1'});
 assert.equal(r.status,403);assert.equal(f.calls.length,0);assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_operations').n,0);
});

test('all other mutations remain blocked, including legacy tick, quota, archive, auth, points, exports and Admin images',async t=>{
 const f=await setup(t,{count:1});
 const paths=['/api/uploads/prepare','/api/uploads/complete','/api/uploads/v2/prepare','/api/cases','/api/cases/direct',
  '/api/auth/login','/api/auth/logout','/api/auth/mfa/verify','/api/admin/submissions/update','/api/admin/members/M-local/points',
  '/api/admin/exports','/api/admin/campaign-assets/LOCAL','/api/admin/storage/inventory','/api/admin/storage/dry-run',
  '/api/internal/drive-backup/claim','/api/internal/drive-backup/storage/quota','/api/internal/drive-backup/storage/archive'];
 for(const path of paths){const r=await f.send(path,{});assert.equal(r.status,503,path);assert.equal(r.error.code,'PRELAUNCH_MAINTENANCE',path);}
 for(const method of ['PUT','PATCH','DELETE'])for(const path of [tick,finish,'/api/admin/campaign-assets/LOCAL','/api/uploads/synthetic/0']){
  const r=await f.fetch(path,method,{},f.headers);assert.equal(r.status,503,path+' '+method);
 }
 const callback=await f.fetch('/api/auth/google/callback','GET');assert.equal(callback.status,503);
 assert.equal((await f.fetch('/api/health')).status,200);assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_operations').n,0);f.unscopedFrozen();
});

for(const state of ['active','unknown'])test('existing '+state+' operation blocks admission without overriding it',async t=>{
 const f=await setup(t,{count:1});f.sqlite.prepare("INSERT INTO prelaunch_reset_operations(id,epoch,state,started_at) VALUES(?,1,?,'synthetic')").run(randomUUID(),state);
 const r=await f.send();assert.equal(r.status,409);assert.equal(f.calls.length,0);
 assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_operations').n,1);assert.equal(f.capacity().inventory_id,null);
});

test('reservation, writer evidence and missing maintenance run identity fail closed',async t=>{
 for(const fault of ['reservation','writer','run']){
  const f=await setup(t,{count:1});
  if(fault==='reservation'){
   // Authorized disposable precondition seeding; never remove a Guard.
   f.sqlite.prepare("INSERT INTO prelaunch_reset_permit VALUES(1,1,NULL,'reset',?,?)").run(JSON.stringify({storage_capacity:{update:[[1]]}}),f.control().run_id);
   f.sqlite.exec('UPDATE storage_capacity SET reserved_bytes=1; DELETE FROM prelaunch_reset_permit');
  }else if(fault==='writer')f.env.R2_EXCLUSIVE_WRITER_CONFIRMED='false';else f.sqlite.exec('UPDATE prelaunch_reset_control SET run_id=NULL');
  assert.equal((await f.send()).status,409);assert.equal(f.calls.length,0);
 }
});

test('forged/old finalize version cannot publish capacity and leaves the pin auditable',async t=>{
 const f=await setup(t,{count:1}),body=await f.ready();const r=await f.send(finish,{...body,inventory_version:body.inventory_version-1});
 assert.equal(r.status,409);assert.equal(f.capacity().inventory_id,body.inventory_id);assert.equal(f.capacity().trusted_until,0);
 assert.equal(f.read('SELECT COUNT(*) n FROM storage_audit').n,0);assert.equal(f.read('SELECT COUNT(*) n FROM storage_history').n,0);
});

test('concurrent valid scans admit one operation, consume one page and do not double count',async t=>{
 const f=await setup(t,{count:51});let enter,release;const arrived=new Promise(r=>enter=r),latch=new Promise(r=>release=r);
 f.setBeforeList(async()=>{enter();await latch;});const first=f.send();await arrived;
 const second=await f.send();assert.equal(second.status,409);release();assert.equal((await first).status,200);
 assert.equal(f.calls.length,1);assert.equal(f.capacity().inventory_count,50);assert.equal(f.capacity().inventory_bytes,1275);
});

for(const change of ['epoch=2','version=version+1',"mode='open'"])test('control '+change+' during LIST stops the page without publishing or unpinning',async t=>{
 const f=await setup(t,{count:1});f.setBeforeList(async()=>f.sqlite.exec('UPDATE prelaunch_reset_control SET '+change));
 assert.equal((await f.send()).status,409);assert.equal(f.capacity().inventory_bytes,0);assert.equal(f.capacity().trusted_until,0);
 assert.ok(f.capacity().inventory_id);assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").n,1);
});

test('final Audit failure atomically rolls back history/capacity and retains UNKNOWN without retry',async t=>{
 const f=await setup(t,{count:1}),body=await f.ready(),before=f.capacity();
 f.sqlite.exec("CREATE TRIGGER isolated_inventory_audit_failure BEFORE INSERT ON storage_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure');END");
 assert.notEqual((await f.send(finish,body)).status,200);assert.deepEqual(f.capacity(),before);
 assert.equal(f.read('SELECT COUNT(*) n FROM storage_history').n,0);assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_permit').n,0);
 assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").n,1);
 assert.equal((await f.send(finish,body)).status,409);assert.deepEqual(f.capacity(),before);
});

test('lost page-commit ACK is never retried; persisted cursor and UNKNOWN block further mutations',async t=>{
 const f=await setup(t,{count:51}),raw=f.env.DB;let lost=false,batches=0;
 f.env.DB={...raw,batch:async statements=>{batches++;const r=await raw.batch(statements);if(!lost&&statements.some(s=>s.sql.includes('inventory_bytes=inventory_bytes+'))){lost=true;throw Error('synthetic lost ACK');}return r;}};
 assert.notEqual((await f.send()).status,200);assert.equal(lost,true);assert.equal(f.calls.length,1);assert.equal(f.capacity().inventory_bytes,1275);
 const before=batches;assert.equal((await f.send()).status,409);assert.equal(batches,before);assert.equal(f.calls.length,1);
 assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").n,1);f.unscopedFrozen();
});

test('successful finalize Receipt replay is read-only and cannot refresh capacity or clear another pin',async t=>{
 const f=await setup(t,{count:1}),body=await f.ready(),done=await f.send(finish,body);assert.equal(done.status,200,JSON.stringify(done));
 const cap=f.capacity(),ops=f.read('SELECT COUNT(*) n FROM prelaunch_reset_operations').n;
 const again=await f.send(finish,body);assert.equal(again.status,200);assert.equal(again.data.inventory.replayed,true);
 assert.deepEqual(f.capacity(),cap);assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_operations').n,ops);
 assert.equal(f.read('SELECT COUNT(*) n FROM storage_history').n,1);assert.equal(f.read('SELECT COUNT(*) n FROM storage_audit').n,1);
});

test('legal super_admin cannot resume while an inventory request is in flight',async t=>{
 const f=await setup(t,{count:1});let enter,release;const ready=new Promise(r=>enter=r),latch=new Promise(r=>release=r);
 const m=await memberSession(new Request(origin,{headers:f.admin.headers}),f.env);
 const csrf=await csrfToken(m,{...f.env,PRELAUNCH_RESET_CONTEXT:{epoch:1}});
 f.setBeforeList(async()=>{enter();await latch;});const pending=f.send();await ready;
 const r=await f.fetch('/api/admin/prelaunch-reset/resume','POST',{epoch:1,version:3},{...f.admin.headers,'X-CSRF-Token':csrf});
 assert.equal(r.status,409);assert.equal(f.control().mode,'maintenance');release();assert.equal((await pending).status,200);
});

test('growth anomaly is preserved rather than hidden by the maintenance permission',async t=>{
 const f=await setup(t,{count:1});f.objects[0].size=2;const body=await f.ready();
 const r=await f.send(finish,body);assert.equal(r.status,200);assert.equal(r.data.inventory.anomaly,'UNACCOUNTED_GROWTH');
 assert.equal(f.capacity().blocked,1);assert.equal(f.control().mode,'maintenance');f.unscopedFrozen();
});

test('terminal-operation ACK loss retains UNKNOWN even when completion actually committed',async t=>{
 const f=await setup(t,{count:1}),raw=f.env.DB;let lost=false;
 f.env.DB={...raw,prepare(sql){
  const wrap=s=>({...s,bind:(...v)=>wrap(s.bind(...v)),async run(){const r=await s.run();if(sql.includes("SET state='completed'")&&!lost){lost=true;throw Error('synthetic terminal ACK lost');}return r;}});
  return wrap(raw.prepare(sql));
 }};
 assert.notEqual((await f.send()).status,200);assert.equal(lost,true);assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").n,1);
 const before=f.capacity();assert.equal((await f.send()).status,409);assert.deepEqual(f.capacity(),before);assert.equal(f.calls.length,1);
});

test('admission ACK loss retains the committed active record and cannot admit another request',async t=>{
 const f=await setup(t,{count:1}),raw=f.env.DB;let lost=false;
 f.env.DB={...raw,prepare(sql){
  const wrap=s=>({...s,bind:(...v)=>wrap(s.bind(...v)),async run(){const r=await s.run();if(sql.startsWith('INSERT INTO prelaunch_reset_operations')&&!lost){lost=true;throw Error('synthetic admission ACK lost');}return r;}});
  return wrap(raw.prepare(sql));
 }};
 assert.notEqual((await f.send()).status,200);assert.equal(lost,true);assert.equal(f.calls.length,0);
 assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='active'").n,1);assert.equal((await f.send()).status,409);
});

test('50/50/50/28 objects are bounded metadata work; no local duration is reported as native CPU',async t=>{
 const f=await setup(t),body=await f.ready();await f.send(finish,body);
 assert.equal(f.calls.length,4);assert.equal(f.calls.reduce((n,x)=>n+x.limit,0),200);
 console.log(JSON.stringify({fixture:'178 synthetic metadata objects',scan_invocations:4,finalize_invocations:1,r2_list:4,r2_put:0,r2_delete:0,maintenance_mode:'unchanged',cloudflare_cpu_ms:'UNKNOWN'}));
});

test('lost final batch ACK keeps its immutable Receipt but returns HOLD and never repeats the commit',async t=>{
 const f=await setup(t,{count:1}),body=await f.ready(),raw=f.env.DB;let commits=0;
 f.env.DB={...raw,batch:async statements=>{const r=await raw.batch(statements);if(statements.some(s=>s.sql.startsWith('INSERT INTO storage_history'))){commits++;throw Error('synthetic final commit ACK lost');}return r;}};
 assert.notEqual((await f.send(finish,body)).status,200);assert.equal(commits,1);
 assert.equal(f.capacity().inventory_id,null);assert.equal(f.capacity().used_bytes,1);
 assert.equal(f.read('SELECT COUNT(*) n FROM storage_audit').n,1);assert.equal(f.read('SELECT COUNT(*) n FROM storage_history').n,1);
 assert.equal(f.read("SELECT COUNT(*) n FROM prelaunch_reset_operations WHERE state='unknown'").n,1);
 assert.equal((await f.send(finish,body)).status,409);assert.equal(commits,1);f.unscopedFrozen();
});

test('control CAS changed immediately before final batch rolls back the entire publish',async t=>{
 const f=await setup(t,{count:1}),body=await f.ready(),before=f.capacity(),raw=f.env.DB;let changed=false;
 f.env.DB={...raw,batch:async statements=>{
  if(!changed&&statements.some(s=>s.sql.startsWith('INSERT INTO storage_history'))){changed=true;f.sqlite.exec('UPDATE prelaunch_reset_control SET version=4');}
  return raw.batch(statements);
 }};
 assert.notEqual((await f.send(finish,body)).status,200);assert.equal(changed,true);assert.deepEqual(f.capacity(),before);
 assert.equal(f.read('SELECT COUNT(*) n FROM storage_audit').n,0);assert.equal(f.read('SELECT COUNT(*) n FROM storage_history').n,0);
 assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_permit').n,0);
});

test('open-mode segmented route retains its existing normal admission and Receipt behavior',async t=>{
 const f=await setup(t,{count:1});f.sqlite.exec("UPDATE prelaunch_reset_control SET mode='open'");
 const r=await f.send();assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.inventory.phase,'finalize');
 const done=await f.send(finish,{inventory_id:r.data.inventory.inventory_id,inventory_version:r.data.inventory.inventory_version});
 assert.equal(done.status,200,JSON.stringify(done));assert.equal(done.data.inventory.complete,true);assert.equal(f.control().mode,'open');
 assert.equal(f.read('SELECT COUNT(*) n FROM storage_audit').n,1);assert.equal(f.read('SELECT COUNT(*) n FROM prelaunch_reset_permit').n,0);
});
