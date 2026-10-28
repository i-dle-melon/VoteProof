import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import p from 'node:path';import {DatabaseSync} from 'node:sqlite';import {randomBytes} from 'node:crypto';
import {fixture} from './helpers/prelaunch-reset-0028-fixture.mjs';
import {APP64,KEEP64,CLEAR64,capture64,retained64,inventory64,rebuild64,verify64,assertShadow,productionActivation,backupDatabase,backupObjects,copyAssets,reconcileCopyOnly,restoreObjects,isolationPlan,auditPolicy64} from '../scripts/lib/prelaunch-reset-0028.mjs';
import {assertReady,digest,stable} from '../scripts/lib/prelaunch-reset-snapshot.mjs';
import {LocalResetObjects} from '../scripts/lib/prelaunch-reset-objects.mjs';
import {decryptTotp}from'../src/lib/auth-crypto.js';import{decryptEmail}from'../src/lib/auth-identity.js';
import {adminHealthMonitorRoute}from'../src/api/admin-health-monitor.js';import{adminMembersOverviewRoute}from'../src/api/admin-members-overview.js';
import {uploadGrantConfig,issueUploadGrant,readUploadGrant}from'../src/lib/upload-grant.js';
import {resolveMemberTier}from'../src/lib/member-tier.js';import{rankingCacheKey}from'../src/lib/public-ranking-cache.js';
globalThis.fetch=async()=>{throw Error('OFFLINE_ONLY_NO_NETWORK');};
const setup=async t=>{const f=await fixture();t.after(()=>f.close());return f;};
const build=(f,more={})=>{const r=rebuild64({source:f.db,snapshot:f.snapshot,targetPath:f.targetPath,context:f.context,runId:f.runId,manifestHash:f.plan.hash,remainingBytes:f.plan.copyAssets.reduce((n,x)=>n+x.size,0),...more});f.track(r.db);return r;};
export function adapter(sqlite){return{prepare(sql){const statement=(values=[])=>({bind:(...v)=>statement(v),async all(){const s=sqlite.prepare(sql);return{success:true,results:s.columns().length?s.all(...values).map(x=>({...x})):[],meta:{changes:0}};},async first(column){const r=sqlite.prepare(sql).get(...values);return column?r?.[column]??null:r?{...r}:null;},async run(){const r=sqlite.prepare(sql).run(...values);return{success:true,results:[],meta:{changes:Number(r.changes)}};}});return statement();},async batch(xs){return Promise.all(xs.map(s=>s.all()));}};}

test('64 app tables plus auxiliary registry; every column FK index trigger matches the frozen 0028 schema',async t=>{
 const f=await setup(t),actual=f.snapshot.schema.filter(x=>x.name!=='d1_migrations'),ref=JSON.parse(fs.readFileSync('test/fixtures/reset-0028-schema-reference.json')).rows.filter(x=>x.sql);
 const canon=rows=>rows.map(x=>({type:x.type,name:x.name,tbl_name:x.tbl_name,sql:x.sql.replace(/\r\n/g,'\n').trim()})).sort((a,b)=>(a.type+'|'+a.name).localeCompare(b.type+'|'+b.name));
 assert.equal(APP64.size,64);assert.equal(inventory64(f.db).length,64);assert.deepEqual(canon(actual),canon(ref));assert.equal(f.snapshot.tables.d1_migrations.length,28);
 const old=JSON.parse(fs.readFileSync('test/fixtures/reset-68-schema-reference.json'));assert.equal(old.length,68);assert.equal(old.filter(x=>!APP64.has(x.name)).length,4);
 const cold=inventory64(f.db).find(x=>x.name==='cold_proofs');assert.ok(!cold.columns.some(x=>x.name==='archive_epoch'));
 f.db.exec('CREATE TABLE unexpected_table(id TEXT)');assert.throws(()=>capture64(f.db),/SCHEMA_NOT_EXACT/);
});
test('original 68-table safety guard remains enforced; UNKNOWN cannot become attestation or Production GO',async t=>{
 const f=await setup(t);assert.throws(()=>assertReady(f.snapshot,{environment:'local-synthetic',identityFrozen:true,allImageWritersStopped:true,backupTriggersStopped:true,oldDeleteTerminal:true,dispatch9Untouched:true}),/MAINTENANCE_NOT_READY/);
 for(const change of [{environment:'production'},{targetExposed:true},{oldDeleteStatus:'CONFIRMED'},{fakeLegacyAttestation:true},{targetBucket:'local-source-r2'}])assert.throws(()=>assertShadow(f.snapshot,{...f.context,...change}));assert.throws(()=>productionActivation(),/PRODUCTION_NO_GO/);
});
test('shadow preserves ALL member Fan ID nickname auth mappings Google MFA sessions admin and configuration fields',async t=>{
 const f=await setup(t),r=build(f);assert.deepEqual(r.proof.identity_digests,retained64(f.snapshot));
 for(const n of KEEP64)assert.equal(digest(capture64(r.db).tables[n]),digest(f.snapshot.tables[n]),n);
 assert.ok((await decryptTotp(r.db.prepare('SELECT * FROM member_credentials').get(),'M-local',f.authEnv))===f.totp);
 const row=r.db.prepare('SELECT * FROM auth_identities').get();assert.ok((await decryptEmail(f.authEnv,row,row.provider_subject))===f.email);assert.ok(row.google_identity_id&&row.provider==='supabase');
 assert.equal(r.db.prepare("SELECT COUNT(*) n FROM admin_memberships WHERE role='super_admin' AND status='active'").get().n,1);assert.equal(capture64(f.db).hash,f.snapshot.hash);
});
test('all points cases ranks cleared in NEW DB; definitions levels cache version and immutable audit preserved',async t=>{
 const f=await setup(t),r=build(f),s=capture64(r.db);for(const n of CLEAR64)assert.equal(s.tables[n].length,n==='storage_audit'?1:0,n);
 assert.ok(r.db.prepare('SELECT m.member_id,COALESCE(SUM(t.points),0) n FROM members m LEFT JOIN point_transactions t USING(member_id) GROUP BY m.member_id').all().every(x=>x.n===0));
 assert.equal(resolveMemberTier(0,s.tables.member_tiers).tier_progress,0);const old=f.snapshot.tables.leaderboards[0],now=s.tables.leaderboards.find(x=>x.leaderboard_id===old.leaderboard_id);assert.notEqual(rankingCacheKey(new URL('https://local.invalid/api/leaderboards'),old),rankingCacheKey(new URL('https://local.invalid/api/leaderboards'),now));
 assert.equal(s.tables.admin_audit_logs.length,1);assert.equal(s.tables.admin_audit_logs[0].target_type,'admin_membership');assert.throws(()=>r.db.exec('DELETE FROM storage_audit'),/immutable/i);
});
test('actual B0 membership and health GET handlers retain access and UNKNOWN after rebuild without R2/Drive',async t=>{
 const f=await setup(t),r=build(f),env={...f.authEnv,DB:adapter(r.db),PROOFS_BUCKET:new Proxy({},{get(){throw Error('NO_R2');}})},req=path=>new Request('https://local.invalid'+path,{headers:{Cookie:'__Host-vp-session='+f.token}});
 for(const[path,route]of [['/api/admin/members-overview',adminMembersOverviewRoute],['/api/admin/health-monitor/summary',adminHealthMonitorRoute]]){const response=await route(path).handler(env,new URL('https://local.invalid'+path),req(path));assert.equal(response.status,200);const d=(await response.json()).data;if(d.members)assert.ok(d.members.every(m=>m.total_points===0&&m.proof_counts.total===0));else{assert.equal(d.upload_failures.count,null);assert.equal(d.pending_operations.count,null);assert.equal(d.coverage.legacy_delete_ack,'unknown');assert.equal(d.storage.cleanup_mode,'dry-run');assert.equal(d.storage.trusted_until,0);}}
});
test('in-place deletes remain prohibited by actual 0028 immutable triggers',async t=>{
 const f=await setup(t);for(const table of ['point_transactions','leaderboard_results','admin_audit_logs'])assert.throws(()=>f.db.exec('DELETE FROM '+table));assert.equal(capture64(f.db).hash,f.snapshot.hash);
});
test('failed build rolls target back and leaves source exact; existing files are never overwritten',async t=>{
 const f=await setup(t);assert.throws(()=>build(f,{failBeforeCommit:true}),/LOCAL_BUILD_FAILURE/);const d=new DatabaseSync(f.targetPath);assert.equal(d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n,0);d.close();assert.equal(capture64(f.db).hash,f.snapshot.hash);assert.throws(()=>build(f),/NEW_LOCAL_TARGET/);build(f,{targetPath:p.join(f.root,'fresh-target.sqlite')});
});
test('actual source write lock rejects concurrent identity mutation during shadow build',async t=>{
 const f=await setup(t),other=f.track(new DatabaseSync(p.join(f.root,'source.sqlite')));f.db.exec('BEGIN IMMEDIATE');assert.throws(()=>other.prepare("UPDATE members SET nickname='race' WHERE member_id='M-local'").run(),/locked/);f.db.exec('ROLLBACK');build(f);
});
test('only retained site assets copied to distinct clean bucket; old proof/Drive objects and UNKNOWN untouched',async t=>{
 const f=await setup(t),oldR2=digest(f.stores.r2.list()),oldDrive=digest(f.stores.drive.list());const result=copyAssets(f.plan,f.stores.r2,f.next,f.journalPath);assert.equal(result.puts,2);assert.equal(f.next.list().length,2);assert.ok(f.next.list().every(x=>!x.id.startsWith('proofs/')));assert.equal(digest(f.stores.r2.list()),oldR2);assert.equal(digest(f.stores.drive.list()),oldDrive);assert.equal(f.context.oldDeleteStatus,'UNKNOWN');assert.equal(f.stores.r2.deleteCalls+f.stores.drive.deleteCalls,0);
});
test('normal asset-copy restart and existing shadow verification perform no duplicate copies/builds',async t=>{
 const f=await setup(t);const r=build(f);assert.equal(copyAssets(f.plan,f.stores.r2,f.next,f.journalPath).puts,2);assert.equal(copyAssets(f.plan,f.stores.r2,f.next,f.journalPath).puts,0);assert.equal(verify64(r.db,f.snapshot,{runId:f.runId,manifestHash:f.plan.hash}).binding,'UNBOUND');assert.throws(()=>build(f),/NEW_LOCAL_TARGET/);
});
test('copy lost ACK holds persistently; explicit local reconciliation verifies bytes and performs zero PUT',async t=>{
 const f=await setup(t);assert.throws(()=>copyAssets(f.plan,f.stores.r2,f.next,f.journalPath,{faultAfterPut:true}),/COPY_RESULT_UNKNOWN/);assert.equal(f.next.list().length,1);assert.throws(()=>copyAssets(f.plan,f.stores.r2,f.next,f.journalPath),/COPY_UNKNOWN_HOLD/);assert.throws(()=>reconcileCopyOnly(f.plan,f.stores.r2,f.next,f.journalPath,f.plan.copyAssets[0]),/EVIDENCE_REQUIRED/);
 assert.equal(reconcileCopyOnly(f.plan,f.stores.r2,f.next,f.journalPath,f.plan.copyAssets[0],{localInvocationEnded:true}).puts,0);assert.equal(copyAssets(f.plan,f.stores.r2,f.next,f.journalPath).puts,1);
});
test('unknown copy result with no target remains HOLD; no TTL unlocking or journal tampering',async t=>{
 const f=await setup(t);assert.throws(()=>copyAssets(f.plan,f.stores.r2,f.next,f.journalPath,{faultBeforePut:true}));assert.equal(reconcileCopyOnly(f.plan,f.stores.r2,f.next,f.journalPath,f.plan.copyAssets[0],{localInvocationEnded:true}).status,'HOLD');assert.throws(()=>copyAssets(f.plan,f.stores.r2,f.next,f.journalPath),/COPY_UNKNOWN_HOLD/);
 fs.writeFileSync(f.journalPath+'.lock','inflight');assert.throws(()=>copyAssets(f.plan,f.stores.r2,f.next,f.journalPath),/COPY_LOCKED/);fs.unlinkSync(f.journalPath+'.lock');const s=JSON.parse(fs.readFileSync(f.journalPath));s.items[digest(f.plan.copyAssets[0])]='VERIFIED';fs.writeFileSync(f.journalPath,JSON.stringify(s));assert.throws(()=>copyAssets(f.plan,f.stores.r2,f.next,f.journalPath),/JOURNAL_TAMPERED/);
});
test('database and complete synthetic object recovery verified in separate paths without source overwrite',async t=>{
 const f=await setup(t),file=p.join(f.root,'source-backup.sqlite');assert.equal(backupDatabase(f.db,file).backup_hash,f.snapshot.hash);assert.throws(()=>backupDatabase(f.db,file),/NEW_LOCAL_BACKUP/);const b=f.track(new DatabaseSync(file,{readOnly:true}));assert.equal(capture64(b).hash,f.snapshot.hash);
 assert.equal(backupObjects(f.plan,f.stores,f.vault).puts,9);assert.equal(backupObjects(f.plan,f.stores,f.vault).puts,0);assert.deepEqual(f.plan.unrelatedDrivePreservedInSource,['unrelated-drive']);const restored={r2:new LocalResetObjects(p.join(f.root,'restored-r2.sqlite'),'r2'),drive:new LocalResetObjects(p.join(f.root,'restored-drive.sqlite'),'drive')};for(const s of Object.values(restored))f.track(s);const proof=restoreObjects(f.plan,f.vault,restored);assert.equal(proof.puts,9);assert.equal(proof.realDriveFileIdRestore,'UNVERIFIED');for(const item of f.plan.archive)assert.equal(restored[item.store].head(item.object.id).sha256,item.object.sha256);assert.throws(()=>restoreObjects(f.plan,f.vault,restored),/OVERWRITE_FORBIDDEN/);
});
test('corrupt backup or changed source assets/manifests stop preparation and restoration',async t=>{
 const f=await setup(t);backupObjects(f.plan,f.stores,f.vault);f.vault.db.prepare('UPDATE objects SET bytes=? WHERE id=?').run(new Uint8Array([0]),digest(f.plan.archive[0]));const restored={r2:f.next,drive:f.stores.drive};assert.throws(()=>restoreObjects(f.plan,f.vault,restored),/CORRUPT/);const altered=structuredClone(f.plan);altered.copyAssets.pop();assert.throws(()=>copyAssets(altered,f.stores.r2,f.next,f.journalPath),/MANIFEST_CHANGED/);f.db.prepare("UPDATE members SET nickname='changed' WHERE member_id='M-local'").run();assert.throws(()=>build(f),/SOURCE_CHANGED/);
});
test('late old DELETE/PUT bound to source bucket cannot mutate a separate copied site asset',async t=>{
 const f=await setup(t);copyAssets(f.plan,f.stores.r2,f.next,f.journalPath);const asset=f.plan.copyAssets[0],before=digest(f.next.head(asset.id));
 // Synthetic old-admitted capability is permanently bound to its old store.
 const oldDelete=()=>f.stores.r2.db.prepare('DELETE FROM objects WHERE id=?').run(asset.id);oldDelete();assert.equal(f.stores.r2.head(asset.id),null);assert.equal(digest(f.next.head(asset.id)),before);f.stores.r2.put(asset.id,new Uint8Array([0]));assert.equal(digest(f.next.head(asset.id)),before);assert.throws(()=>isolationPlan(f.snapshot,{...f.context,targetBucket:f.context.sourceBucket},{...f.stores,next:f.next}),/NAMESPACE/);assert.throws(()=>productionActivation(),/PRODUCTION_NO_GO/);
});
test('real old Upload Grant can replay with reused secret; new isolated grant secret rejects it without changing identity crypto',async t=>{
 const f=await setup(t),old={AUTH_ORIGIN:'https://local.invalid',UPLOAD_GRANT_SECRET:randomBytes(32).toString('hex'),PROOFS_BUCKET:{put:async()=>{}}},path='/api/uploads/put/local/fixture',file={size:1,type:'image/png',sha256:'a'.repeat(64)},grant=await issueUploadGrant(await uploadGrantConfig(old),path,'proofs/staging/local.png',file),request=new Request('https://local.invalid'+path,{headers:grant.headers});
 assert.ok(await readUploadGrant({...old,PROOFS_BUCKET:{put:async()=>{}}},request,path));await assert.rejects(readUploadGrant({...old,UPLOAD_GRANT_SECRET:randomBytes(32).toString('hex')},request,path));assert.ok(await decryptTotp(f.db.prepare('SELECT * FROM member_credentials').get(),'M-local',f.authEnv)===f.totp);
});
test('unknown object namespace and overlapping website/submission ownership fail closed',async t=>{
 const f=await setup(t);assert.throws(()=>isolationPlan(f.snapshot,{...f.context,siteAssetKeys:['proofs/cases/0.png']},{...f.stores,next:f.next}),/ASSET_SCOPE/);f.stores.r2.put('unclassified-image.png',f.bytes);assert.throws(()=>isolationPlan(f.snapshot,f.context,{...f.stores,next:f.next}),/UNKNOWN_OBJECT_SCOPE/);
});
test('Drive recovery requires exact app ownership root mapping and content; unrelated files not copied',async t=>{
 const f=await setup(t);const before=f.stores.drive.head('unrelated-drive');assert.ok(!f.plan.archive.some(x=>x.store==='drive'&&x.object.id==='unrelated-drive'));f.stores.drive.db.prepare('UPDATE objects SET bytes=? WHERE id=?').run(new Uint8Array([0]),'drive-0');assert.throws(()=>isolationPlan(f.snapshot,f.context,{...f.stores,next:f.next}),/DRIVE_RECOVERY_IDENTITY/);assert.deepEqual(f.stores.drive.head('unrelated-drive'),before);
});
test('asset metadata tampering cannot pass restart verification or cause an overwrite',async t=>{
 const f=await setup(t);copyAssets(f.plan,f.stores.r2,f.next,f.journalPath);f.next.db.prepare('UPDATE objects SET meta=? WHERE id=?').run('{"unreviewed":true}',f.plan.copyAssets[0].id);assert.throws(()=>copyAssets(f.plan,f.stores.r2,f.next,f.journalPath),/TARGET_ASSET_CHANGED/);assert.equal(f.next.head(f.plan.copyAssets[0].id).meta.unreviewed,true);
});
test('mixed audit retains exact configuration and roles, archives ranking-derived payloads, unknown scope HOLD',async t=>{
 const f=await setup(t),common={created_at:'2026-10-26T00:00:00.000Z',admin_member_id:'M-operator',admin_role:'super_admin',target_version:1,before_json:'{}'};
 for(const row of [{id:'historical-run',action:'leaderboard_rebuild',target_type:'leaderboard',target_id:'LOCAL-BOARD',after_json:JSON.stringify({run_id:'LOCAL-RUN',row_count:1})},{id:'definition-with-old-run',action:'leaderboard_update',target_type:'leaderboard',target_id:'LOCAL-BOARD',target_version:2,after_json:JSON.stringify({run_id:'LOCAL-RUN',version:2})},{id:'retained-tier-rule',action:'member_tier_update',target_type:'member_tier',target_id:'normal',after_json:JSON.stringify({min_points:0,status:'active'})}])f.insert('admin_audit_logs',{...common,...row});
 f.snapshot=capture64(f.db);f.plan=isolationPlan(f.snapshot,f.context,{...f.stores,next:f.next});const r=build(f);const rows=r.db.prepare('SELECT id FROM admin_audit_logs ORDER BY id').all().map(x=>x.id);assert.deepEqual(rows,['audit-local-role','retained-tier-rule']);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM admin_audit_logs').get().n,5);
 assert.throws(()=>auditPolicy64({target_type:'unreviewed',before_json:'{}',after_json:'{}'}),/AUDIT_SCOPE/);assert.throws(()=>auditPolicy64({target_type:'campaign',before_json:'invalid',after_json:'{}'}),/AUDIT_JSON/);const unknown=structuredClone(f.snapshot);unknown.tables.admin_audit_logs.push({target_type:'unreviewed',before_json:'{}',after_json:'{}'});assert.throws(()=>isolationPlan(unknown,f.context,{...f.stores,next:f.next}),/AUDIT_SCOPE/);
});
