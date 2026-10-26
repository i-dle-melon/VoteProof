import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {adminImageOperation,deleteImage,imageMaintenanceStatus} from '../src/lib/image-maintenance.js';
import {scanInventoryPage,finalizeInventory} from '../src/lib/storage-inventory.js';
import {capacityRow,capacityPut} from '../src/lib/storage-capacity.js';
import {cleanPrivateCopies} from '../src/lib/case-files.js';
import {interceptBatch} from './helpers/archive-fence-fixture.mjs';
import {saveCampaign} from '../src/lib/campaign-store.js';
import {campaignInput} from '../src/lib/campaign-policy.js';
import {archiveCanaryRuntime} from './helpers/archive-canary-runtime.mjs';

const route='/api/admin/storage/image-maintenance';
const png=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4]);
const latch=()=>{let release;const promise=new Promise(r=>release=r);return{promise,release};};
const proxy=(object,overrides)=>new Proxy(object,{get(t,k){if(k in overrides)return overrides[k];const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
async function fixture(options={}){
 const h=await localAdminRuntime({submissionsEnabled:false,...options}),db=h.local.db,bucket=h.local.bucket;
 const owner=await h.identity({role:'super_admin'});
 const actor={role:'super_admin',member:{member_id:owner.memberId,tokenHash:owner.hash}};
 const env=(d=db,b=bucket)=>({...h.local.authConfig,DB:d,PROOFS_BUCKET:b,R2_EXCLUSIVE_WRITER_CONFIRMED:'true'});
 const state=()=>capacityRow(db);
 async function control(action,extra={},who=owner){
  const current=await db.prepare('SELECT version FROM image_maintenance_control WHERE id=1').first();
  const response=await h.local.fetch(route,'POST',{action,expected_version:current.version,confirmed:true,...extra},who.headers);
  return{status:response.status,body:await response.json()};
 }
 const finalize=async()=>{const s=await state();return finalizeInventory(env(),s.inventory_id,s.inventory_version);};
 return{h,db,bucket,owner,actor,env,state,control,finalize,close:()=>h.local.runtime.dispose()};
}
async function withFixture(t,fn,options){const f=await fixture(options);t.after(f.close);return fn(f);}

test('0030 preserves migration default UNKNOWN; pause is not old-cohort drain evidence',async t=>withFixture(t,async f=>{
 assert.equal((await imageMaintenanceStatus(f.db)).legacy_status,'unknown');
 const gate=await f.db.prepare('SELECT * FROM submission_settings').first();
 assert.equal((await f.control('pause')).status,200);
 assert.equal((await f.control('settle')).status,409);
 assert.equal((await imageMaintenanceStatus(f.db)).mode,'draining');
 assert.deepEqual(await f.db.prepare('SELECT * FROM submission_settings').first(),gate);
 assert.equal((await f.db.prepare('SELECT mode FROM storage_archive_control').first()).mode,'paused');
 assert.equal((await f.h.local.fetch('/api/health')).status,200);
},{imageLegacyAttested:false}));

test('maintenance denies new Admin PUT/replacement/removal while preserving reads and MFA/RBAC',async t=>withFixture(t,async f=>{
 const body={name:'Local fixture',category:'Solo',solo_target:'miyeon',start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',campaign_timezone:'UTC',points_per_proof:0,daily_limit:0,status:'active',expected_version:0,example_asset_id:null,submission_instructions:''};
 await f.control('pause');
 const upload=await f.h.local.runtime.dispatchFetch('https://voteproof.example/api/admin/campaign-assets/LOCAL-TEST',{method:'POST',body:png,headers:{...f.owner.headers,'Content-Type':'image/png','Content-Length':String(png.length)}});
 assert.equal(upload.status,409);
 assert.equal((await f.h.local.fetch('/api/admin/campaigns/LOCAL-TEST/update','POST',body,f.owner.headers)).status,409);
 assert.equal((await f.bucket.list()).objects.length,0);
 assert.equal((await f.h.local.fetch('/api/admin/campaigns/LOCAL-TEST','GET',undefined,f.owner.headers)).status,200);
 const admin=await f.h.identity({role:'admin'}),reviewer=await f.h.identity({role:'reviewer'}),expired=await f.h.identity({role:'super_admin',elevated:false});
 assert.equal((await f.h.local.fetch(route,'GET',undefined,admin.headers)).status,200);
 for(const who of [admin,reviewer,expired])assert.equal((await f.control('settle',{},who)).status,403);
 const bad={...f.owner,headers:{...f.owner.headers,'X-CSRF-Token':'0'.repeat(64)}};
 assert.equal((await f.control('settle',{},bad)).status,403);
 assert.equal((await f.control('settle',{expected_version:1})).status,409);
}));

test('admitted Admin survives pause with durable active state; drain cannot skip its late child DELETE',async t=>withFixture(t,async f=>{
 const key='synthetic/admin-late.png';await f.bucket.put(key,png);
 const entered=latch(),go=latch();t.after(go.release);
 const workflow=adminImageOperation(f.env(),f.actor,'admin_campaign',async scoped=>{entered.release();await go.promise;await deleteImage(scoped,key);return{ok:true};});
 await entered.promise;assert.equal((await f.control('pause')).status,200);
 assert.equal((await f.control('attest_legacy',{evidence_sha256:'b'.repeat(64)})).status,409);
 assert.equal((await f.control('settle')).status,409);
 go.release();await workflow;assert.equal(await f.bucket.head(key),null);
 const operations=(await f.db.prepare('SELECT kind,state FROM image_mutation_operations').all()).results;
 assert.equal(operations.length,2);assert.ok(operations.every(o=>o.state==='completed'));
 assert.equal((await f.control('attest_legacy',{evidence_sha256:'b'.repeat(64)})).status,200);
 assert.equal((await f.control('settle')).status,200);
 assert.equal((await imageMaintenanceStatus(f.db)).ready,true);
}));

test('native DELETE ACK loss is durable UNKNOWN, blocks inventory and maintenance, never retries',async t=>withFixture(t,async f=>{
 const key='synthetic/lost-delete.png';await f.bucket.put(key,png);let count=0;
 const bucket=proxy(f.bucket,{delete:async k=>{count++;await f.bucket.delete(k);throw Error('SYNTHETIC_DELETE_ACK_LOST');}});
 await assert.rejects(deleteImage(f.env(f.db,bucket),key),e=>e.code==='IMAGE_MAINTENANCE_HOLD');
 assert.equal(count,1);assert.equal(await f.bucket.head(key),null);
 const op=await f.db.prepare("SELECT id,state FROM image_mutation_operations WHERE kind='delete'").first();assert.equal(op.state,'unknown');
 await assert.rejects(scanInventoryPage(f.env()));
 await f.control('pause');assert.equal((await f.control('attest_legacy',{evidence_sha256:'c'.repeat(64)})).status,409);
 assert.equal((await f.control('settle')).status,409);assert.equal(count,1);
 await assert.rejects(f.db.prepare("UPDATE image_mutation_operations SET state='completed' WHERE id=?").bind(op.id).run(),/IMMUTABLE/);
 await assert.rejects(f.db.prepare('DELETE FROM image_mutation_operations WHERE id=?').bind(op.id).run(),/IMMUTABLE/);
}));

test('D1 terminal ACK loss does not retry DELETE; completed receipt is actual durable evidence',async t=>withFixture(t,async f=>{
 const key='synthetic/terminal-ack.png';await f.bucket.put(key,png);let deletes=0;
 const bucket=proxy(f.bucket,{delete:async k=>{deletes++;return f.bucket.delete(k);}});
 const db=interceptBatch(f.db,'UPDATE image_mutation_operations SET state=',{after:true});
 await assert.rejects(deleteImage(f.env(db,bucket),key));assert.equal(deletes,1);
 const op=await f.db.prepare("SELECT state,outcome FROM image_mutation_operations WHERE kind='delete'").first();
 assert.equal(op.state,'completed');assert.equal(op.outcome,'native_delete_acknowledged');
 assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='image_mutation_completed'").first()).n,1);
 await f.control('pause');assert.equal((await f.control('attest_legacy',{evidence_sha256:'e'.repeat(64)})).status,200);
 assert.equal((await f.control('settle')).status,200);assert.equal(deletes,1);
}));

test('Campaign transaction ACK loss preserves pending cleanup and UNKNOWN Admin operation',async t=>withFixture(t,async f=>{
 const asset=randomUUID(),key='campaign-assets/LOCAL-TEST/example/'+asset+'.png',at=new Date().toISOString();
 const object=await f.bucket.put(key,png);
 await f.db.prepare('INSERT INTO campaign_example_assets(asset_id,campaign_id,object_key,content_type,size,etag,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)').bind(asset,'LOCAL-TEST',key,'image/png',png.length,object.etag,at,f.owner.memberId).run();
 await f.db.prepare('INSERT INTO campaign_content(campaign_id,submission_instructions,example_asset_id,updated_at,updated_by) VALUES(?,?,?,?,?)').bind('LOCAL-TEST','',asset,at,f.owner.memberId).run();
 const before=await f.db.prepare("SELECT * FROM campaigns WHERE campaign_id='LOCAL-TEST'").first();
 const body=Object.fromEntries(['name','category','solo_target','start_at','end_at','campaign_timezone','points_per_proof','daily_limit','status','note'].map(k=>[k,before[k]]));
 body.expected_version=before.version;body.example_asset_id=null;body.submission_instructions='';
 const d=interceptBatch(f.db,'UPDATE campaigns SET',{after:true});
 const result=await adminImageOperation(f.env(d),f.actor,'admin_campaign',scoped=>saveCampaign(d,f.actor,campaignInput(body,true),before,scoped));
 assert.equal(result.asset_cleanup_pending,true);assert.ok(await f.bucket.head(key));
 assert.equal((await f.db.prepare("SELECT example_asset_id FROM campaign_content WHERE campaign_id='LOCAL-TEST'").first()).example_asset_id,null);
 assert.equal((await f.db.prepare("SELECT state FROM image_mutation_operations WHERE kind='admin_campaign'").first()).state,'unknown');
 await f.control('pause');assert.equal((await f.control('settle')).status,409);
}));

test('V7 B06 regression: owned compensation DELETE after inventory claim is denied before R2',async t=>withFixture(t,async f=>{
 const key='proofs/staging/synthetic-v7.png';await f.bucket.put(key,png);
 await f.db.prepare('UPDATE storage_capacity SET used_bytes=? WHERE id=1').bind(png.length).run();
 await scanInventoryPage(f.env());let deletes=0;const bucket=proxy(f.bucket,{delete:async k=>{deletes++;return f.bucket.delete(k);}});
 await cleanPrivateCopies(f.env(f.db,bucket),[key]);
 assert.equal(deletes,0);assert.ok(await f.bucket.head(key));
 const done=await f.finalize();assert.equal(done.bytes,png.length);assert.equal(done.anomaly,null);
}));

test('DELETE admitted before scan retains active pin until native completion and terminal audit',async t=>withFixture(t,async f=>{
 const key='synthetic/delete-before-scan.png';await f.bucket.put(key,png);
 const entered=latch(),go=latch();t.after(go.release);
 const b=proxy(f.bucket,{delete:async k=>{entered.release();await go.promise;return f.bucket.delete(k);}});
 const pending=deleteImage(f.env(f.db,b),key);await entered.promise;
 await assert.rejects(scanInventoryPage(f.env()));assert.equal((await f.state()).inventory_id,null);
 go.release();await pending;await scanInventoryPage(f.env());assert.equal((await f.finalize()).bytes,0);
 assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='image_mutation_completed'").first()).n,1);
}));

test('V7 B07 regression: real Admin HTTP DELETE cannot change R2 during scan; Gate remains OFF',async t=>withFixture(t,async f=>{
 const uploaded=await f.h.local.runtime.dispatchFetch('https://voteproof.example/api/admin/campaign-assets/LOCAL-TEST',{method:'POST',body:png,headers:{...f.owner.headers,'Content-Type':'image/png','Content-Length':String(png.length)}});
 assert.equal(uploaded.status,201);const asset=(await uploaded.json()).data.asset_id;
 const raw=await f.db.prepare('SELECT * FROM campaigns WHERE campaign_id=?').bind('LOCAL-TEST').first();
 const body=Object.fromEntries(['name','category','solo_target','start_at','end_at','campaign_timezone','points_per_proof','daily_limit','status','note'].map(k=>[k,raw[k]]));
 body.expected_version=raw.version;body.example_asset_id=asset;body.submission_instructions='';
 assert.equal((await f.h.local.fetch('/api/admin/campaigns/LOCAL-TEST/update','POST',body,f.owner.headers)).status,200);
 await scanInventoryPage(f.env());body.expected_version++;body.example_asset_id=null;
 assert.equal((await f.h.local.fetch('/api/admin/campaigns/LOCAL-TEST/update','POST',body,f.owner.headers)).status,409);
 const key=(await f.db.prepare('SELECT object_key FROM campaign_example_assets WHERE asset_id=?').bind(asset).first()).object_key;
 assert.ok(await f.bucket.head(key));assert.equal((await f.finalize()).bytes,png.length);
 assert.equal((await f.db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);
}));

test('inventory abort requires identity/version CAS, never publishes bytes, audit and pin terminal survive',async t=>withFixture(t,async f=>{
 await f.bucket.put('synthetic/abort.png',png);await f.db.prepare('UPDATE storage_capacity SET used_bytes=500 WHERE id=1').run();
 await scanInventoryPage(f.env());const scan=await f.state();await f.control('pause');
 await assert.rejects(finalizeInventory(f.env(),scan.inventory_id,scan.inventory_version));
 assert.equal((await f.control('abort_inventory',{inventory_id:scan.inventory_id,inventory_version:scan.inventory_version+1})).status,409);
 assert.ok((await f.state()).inventory_id);
 assert.equal((await f.control('abort_inventory',{inventory_id:scan.inventory_id,inventory_version:scan.inventory_version})).status,200);
 const state=await f.state();assert.equal(state.used_bytes,500);assert.equal(state.trusted_until,0);assert.equal(state.blocked,1);assert.equal(state.inventory_id,null);
 assert.equal((await f.db.prepare('SELECT state FROM image_mutation_operations WHERE id=?').bind(scan.inventory_id).first()).state,'aborted');
 assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='image_maintenance_abort_inventory'").first()).n,1);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM storage_history').first()).n,0);
 assert.equal((await f.control('abort_inventory',{inventory_id:scan.inventory_id,inventory_version:scan.inventory_version})).status,409);
}));

test('pause racing delayed finalize transaction fences publication; abort then fresh scan permits explicit resume',async t=>withFixture(t,async f=>{
 await scanInventoryPage(f.env());const scan=await f.state(),entered=latch(),go=latch();t.after(go.release);
 const d=proxy(f.db,{batch:async stmts=>{entered.release();await go.promise;return f.db.batch(stmts);}});
 const finishing=finalizeInventory(f.env(d),scan.inventory_id,scan.inventory_version);const observed=finishing.then(()=>false,()=>true);
 await entered.promise;await f.control('pause');go.release();assert.equal(await observed,true);
 assert.equal((await f.control('abort_inventory',{inventory_id:scan.inventory_id,inventory_version:scan.inventory_version})).status,200);
 assert.equal((await f.control('attest_legacy',{evidence_sha256:'d'.repeat(64)})).status,200);
 assert.equal((await f.control('settle')).status,200);
 assert.equal((await f.control('resume')).status,409); // aborted capacity remains untrusted
 await scanInventoryPage(f.env());await f.finalize();
 assert.equal((await f.control('resume',{expected_version:1})).status,409);
 assert.equal((await f.control('resume')).status,200);
 assert.equal((await imageMaintenanceStatus(f.db)).mode,'open');
 assert.equal((await f.db.prepare('SELECT mode FROM storage_archive_control').first()).mode,'paused');
 assert.equal((await f.db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);
}));

test('already committed finalize is not overwritten by late abort or double-finalizer',async t=>withFixture(t,async f=>{
 await scanInventoryPage(f.env());const scan=await f.state();
 const a=await finalizeInventory(f.env(),scan.inventory_id,scan.inventory_version);
 const b=await finalizeInventory(f.env(),scan.inventory_id,scan.inventory_version);assert.equal(a.complete,true);assert.equal(b.replayed,true);
 await f.control('pause');assert.equal((await f.control('abort_inventory',{inventory_id:scan.inventory_id,inventory_version:scan.inventory_version})).status,409);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM storage_history WHERE id=?').bind(scan.inventory_id).first()).n,1);
}));

test('normal create-only PUT, scoped DELETE and immutable audit keep 90/95/85 and 600 second rules',async t=>withFixture(t,async f=>{
 const e=f.env();await capacityPut(e,'synthetic/normal.png',png,{},png.length);
 await deleteImage(e,'synthetic/normal.png');await scanInventoryPage(e);await f.finalize();
 const state=await f.state();assert.equal(state.trusted_until-state.observed_at,600);
 await f.db.prepare('UPDATE storage_capacity SET used_bytes=9500000000 WHERE id=1').run();
 await assert.rejects(capacityPut(e,'synthetic/no-put.png',png,{},png.length));assert.equal(await f.bucket.head('synthetic/no-put.png'),null);
 assert.equal((await f.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
 assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 const rules=await readFile(new URL('../src/lib/storage-capacity.js',import.meta.url),'utf8');
 for(const n of ['9000000000','9500000000','8500000000'])assert.ok(rules.includes(n));
}));

test('all Runtime native R2 DELETE calls are centralized; Drive backup Script source is untouched',async()=>{
 const files=[];async function walk(url){for(const f of await readdir(url,{withFileTypes:true})){const p=new URL(f.name+(f.isDirectory()?'/':''),url);if(f.isDirectory())await walk(p);else if(f.name.endsWith('.js'))files.push(p);}}
 await walk(new URL('../src/',import.meta.url));
 const native=[];for(const file of files){const text=await readFile(file,'utf8');if(/(?:PROOFS_BUCKET|bucket)\.delete\(/.test(text))native.push(file.pathname);}
 assert.equal(native.length,1);assert.ok(native[0].endsWith('/src/lib/image-maintenance.js'));
 const source=await readFile(new URL('../apps-script/drive-backup/Code.gs',import.meta.url),'utf8');assert.ok(source.includes('function runBackup'));
});

test('new maintenance wrapper preserves future isolated A/B authorization and terminal audit without enabling Production',async t=>{
 const h=await archiveCanaryRuntime();t.after(()=>h.close());
 const f=await h.seed('maintenance-wrapper');
 const a=(await h.post({canary:true})).body.data.cleanup;assert.equal(a.state,'verification_ready');
 const b=(await h.post({canary:true,handoff:a.handoff})).body.data.cleanup;assert.equal(b.state,'cold');assert.equal(b.deleted,1);
 assert.equal(await h.bucket.head(f.key),null);
 assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM image_mutation_operations WHERE kind='delete' AND state='completed'").first()).n,1);
 assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='archive_r2_deleted' AND target=?").bind(f.file).first()).n,1);
 assert.equal((await h.db.prepare('SELECT status FROM proof_backups WHERE file_id=?').bind(f.file).first()).status,'confirmed');
 const replay=(await h.post({canary:true,handoff:a.handoff})).body.data.cleanup;assert.equal(replay.deleted,0);
 assert.equal(h.state.unexpected,0);
});
