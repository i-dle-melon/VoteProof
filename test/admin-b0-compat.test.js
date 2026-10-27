import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import{readdir}from'node:fs/promises';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {ensureValidation} from '../scripts/ci/validation.mjs';
const summary='/api/admin/health-monitor/summary',events='/api/admin/health-monitor/events';
const read=async(h,a,path)=>(await(await h.fetch(path,'GET',undefined,a.headers)).json()).data;

test('B0 actual migration chain ends at0028; native workerd member/health handlers work without new tracking tables',async()=>{
 const files=(await readdir('migrations')).filter(f=>/^\d+_.*\.sql$/.test(f)).sort();assert.equal(files.length,28);assert.equal(files.at(-1),'0028_admin_operations_v2.sql');
 const h=await localAdminRuntime();try{
 const a=await h.identity({role:'admin'}),db=h.local.db;
 assert.deepEqual((await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('image_mutation_operations','storage_archive_dispatches','image_maintenance_control')").all()).results,[]);
 for(const p of ['/api/admin/members-overview',summary,events,'/api/admin/overview','/api/admin/storage','/api/admin/campaigns','/api/admin/leaderboards']){const r=await h.local.fetch(p,'GET',undefined,a.headers);assert.equal(r.status,200,await r.clone().text());}
 // The old frontend's existing GET APIs stay compatible; P1 adds routes only.
 const member=await h.identity(),guestCase=await h.makeCase(),memberCase=await h.makeCase({member});
 for(const item of [guestCase,memberCase]){
  const row=await db.prepare('SELECT object_key FROM case_files WHERE case_id=?').bind(item.id).first();
  assert.ok(row);assert.ok(await h.local.bucket.head(row.object_key));
 }
 const d=(await(await h.local.fetch(summary,'GET',undefined,a.headers)).json()).data;assert.equal(d.pending_operations.count,null);assert.equal(d.pending_operations.legacy_ack_unverified,true);
 for(let i=0;i<25;i++)await db.prepare("INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,?,'cleanup_failed',?)").bind(randomUUID(),i+100,Math.floor(Date.now()/1000)).run();
 const first=(await(await h.local.fetch(events,'GET',undefined,a.headers)).json()).data;assert.ok(first.next_cursor);
 const next=await h.local.fetch(events+'?cursor='+first.next_cursor,'GET',undefined,a.headers);assert.equal(next.status,200,await next.clone().text());
 assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check,'ok');assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 assert.deepEqual(h.local.unexpectedUpstreams,[]);
 }finally{await h.local.runtime.dispose();}
});

test('B0 summary never equates unsupported operations or missing upload history with zero; no R2 or secret columns',async()=>{
 const h=await embeddedCaseRuntime();try{
 const a=await h.identity('admin'),statements=[],prepare=h.db.prepare.bind(h.db);h.db.prepare=sql=>{statements.push(sql);return prepare(sql);};
 for(const key of ['get','head','put','delete','list'])h.bucket[key]=()=>{throw Error('NO_R2_ALLOWED');};
 const d=await read(h,a,summary);assert.equal(d.schema_compatibility,'p1_legacy_0028_v1');
 assert.equal(d.upload_failures.count,null);assert.equal(d.pending_operations.count,null);assert.equal(d.pending_operations.active,null);assert.equal(d.pending_operations.unknown,null);assert.equal(d.pending_operations.archive_dispatches,null);
 assert.equal(d.pending_operations.known_signals.reservations.count,0);assert.equal(d.pending_operations.known_signals.write_pins.count,0);assert.equal(d.coverage.operation,'unsupported');
 assert.ok(statements.filter(x=>x.startsWith('WITH recent')).every(x=>x.includes('MATERIALIZED')&&x.includes('LIMIT 1001')&&x.includes('LIMIT 1000')));
 assert.ok(!statements.some(x=>/\b(INSERT|UPDATE|DELETE)\b|FROM image_mutation_operations|FROM storage_archive_dispatches|FROM image_maintenance_control/.test(x)));
 assert.doesNotMatch(JSON.stringify(d),/object_key|token_hash|session_id|password_hash|email_ciphertext/);
 const unsupported=await read(h,a,events+'?type=operation');assert.deepEqual(unsupported.events,[]);assert.equal(unsupported.count,null);assert.equal(unsupported.coverage,'unsupported');
 }finally{h.close();}
});

test('B0 window precedes filtering: old UNKNOWN outside1000 is not absent; sentinel is not an event or count',async()=>{
 const h=await embeddedCaseRuntime();try{
 const a=await h.identity('admin'),at=Math.floor(Date.now()/1000);
 await h.db.prepare("INSERT INTO storage_audit VALUES(?,?,'alert_ambiguous','synthetic','{}')").bind(randomUUID(),at).run();
 await h.db.prepare("INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,1,'cleanup_failed',?)").bind(randomUUID(),at).run();
 for(let i=0;i<1001;i++)await h.db.batch([
  h.db.prepare("INSERT INTO storage_audit VALUES(?,?,'inventory','synthetic','{}')").bind(randomUUID(),at),
  h.db.prepare("INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,?,'90',?)").bind(randomUUID(),i+2,at),
 ]);
 const d=await read(h,a,events+'?type=capacity&status=manual');assert.deepEqual(d.events,[]);assert.equal(d.coverage,'partial_window');assert.equal(d.count,null);assert.ok(d.source_windows.every(x=>x.truncated));
 const s=await read(h,a,summary);assert.equal(s.cleanup_failures.count,null);assert.equal(s.cleanup_failures.observed_count,0);assert.equal(s.cleanup_failures.coverage,'partial_window');
 assert.equal((await h.db.prepare("SELECT count(*) n FROM storage_audit WHERE action='alert_ambiguous'").first()).n,1);
 }finally{h.close();}
});

test('B0 cursor seals fixed source windows: ties paginate once, new rows excluded, foreign actor/filter/tampering rejected',async()=>{
 const h=await embeddedCaseRuntime();try{
 const a=await h.identity('admin'),b=await h.identity('super_admin'),stamp=Date.parse('2026-10-22T16:00:00Z')/1000,expected=[];
 for(let i=0;i<24;i++){const x=randomUUID(),y=randomUUID();await h.db.batch([
  h.db.prepare("INSERT INTO storage_alerts(id,episode,kind,created_at,state) VALUES(?,?,'cleanup_failed',?,'sent')").bind(x,i,stamp),
  h.db.prepare("INSERT INTO storage_audit VALUES(?,?,'alert_ambiguous','synthetic','{}')").bind(y,stamp),
 ]);expected.push('alert:'+x,'audit:'+y);}
 expected.sort().reverse();const q='?from=2026-10-23&to=2026-10-23',first=await read(h,a,events+q);assert.equal(first.events.length,20);assert.ok(first.next_cursor);
 const next=first.next_cursor;await h.db.prepare("INSERT INTO storage_audit VALUES(?,?,'alert_ambiguous','synthetic','{}')").bind(randomUUID(),stamp).run();
 const all=[...first.events.map(e=>e.id)];let cursor=next;while(cursor){const d=await read(h,a,events+q+'&cursor='+encodeURIComponent(cursor));all.push(...d.events.map(e=>e.id));cursor=d.next_cursor;assert.ok(all.length<=48);}
 assert.deepEqual(all,expected);assert.equal(new Set(all).size,48);
 for(const [actor,path]of [[b,events+q+'&cursor='+next],[a,events+'?cursor='+next],[a,events+q+'&cursor='+next.slice(0,-8)+'aaaaaaaa']])assert.equal((await h.fetch(path,'GET',undefined,actor.headers)).status,400);
 const fresh=await read(h,a,events+q);let expired=JSON.parse(Buffer.from(fresh.next_cursor,'base64url').toString());expired[0][2]=0;
 assert.equal((await h.fetch(events+q+'&cursor='+Buffer.from(JSON.stringify(expired)).toString('base64url'),'GET',undefined,a.headers)).status,400);
 }finally{h.close();}
});

test('B0 exactly1001 matching candidates expose1000 events; the sentinel never enters any page',async()=>{
 const h=await embeddedCaseRuntime();try{
 const a=await h.identity('admin'),ids=[],at=Math.floor(Date.now()/1000);
 for(let i=0;i<1001;i++){const id=randomUUID();ids.push('audit:'+id);await h.db.prepare("INSERT INTO storage_audit VALUES(?,?,'alert_ambiguous','synthetic','{}')").bind(id,at).run();}
 const got=[];let cursor=null;do{const d=await read(h,a,events+'?type=capacity&status=manual'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(d.coverage,'partial_window');got.push(...d.events.map(e=>e.id));cursor=d.next_cursor;assert.ok(got.length<=1000);}while(cursor);
 assert.deepEqual(got,ids.slice(1).sort().reverse());assert.equal(new Set(got).size,1000);assert.ok(!got.includes(ids[0]));
 }finally{h.close();}
});

test('B0 retains MFA and no-write routes; Fan ID uses existing0028 partial index',async()=>{
 const h=await embeddedCaseRuntime();try{
 const a=await h.identity('admin'),r=await h.identity('reviewer'),m=await h.identity();
 for(const who of [r,m])for(const path of[summary,events])assert.equal((await h.fetch(path,'GET',undefined,who.headers)).status,403);
 for(const path of [summary,events])assert.equal((await h.fetch(path)).status,401);
 const queries=[],prep=h.db.prepare.bind(h.db);h.db.prepare=s=>{queries.push(s);return prep(s);};
 const id=(await prep('SELECT player_id FROM members WHERE member_id=?').bind(m.memberId).first()).player_id;
 assert.equal((await read(h,a,'/api/admin/members-overview?fan_id='+id)).members.length,1);
 const sql=queries.find(s=>s.includes('lower(trim(m.player_id))'));assert.ok(sql.includes('m.player_id IS NOT NULL'));
 assert.match(JSON.stringify((await prep('EXPLAIN QUERY PLAN '+sql).bind(id,21).all()).results),/members_fan_id_unique/);
 await prep('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?').bind(a.memberId).run();
 assert.equal((await h.fetch(summary,'GET',undefined,a.headers)).status,403);
 assert.equal((await h.fetch(summary,'POST',{},a.headers)).status,405);
 }finally{h.close();}
});

test('B0 exact new release ref reuses only same-ref same-SHA CI; arbitrary codex ref remains forbidden',async()=>{
 const ref='codex/p1-0028-independent-release-20261027',sha='a'.repeat(40),repository='owner/VoteProof';
 const run={id:1,head_sha:sha,head_repository:{full_name:repository},head_branch:ref,event:'push',status:'completed',conclusion:'success',html_url:'https://github.com/owner/VoteProof/actions/runs/1'};
 const calls=[];assert.equal((await ensureValidation({sha,ref,repository,api:async(path,body)=>{calls.push({path,body});return path.includes('/actions/workflows/')?{workflow_runs:[{...run,id:2,head_branch:'codex/other'},run]}:run;}})).run_id,1);assert.ok(calls.every(x=>!x.body));
 await assert.rejects(ensureValidation({sha,ref:'codex/not-approved',repository,api:async()=>{throw Error('NO_API');}}),/allowed release ref/);
 await assert.rejects(ensureValidation({sha,ref,repository,api:async path=>path.includes('/actions/workflows/')?{workflow_runs:[run]}:{...run,head_branch:'codex/other'}}),/provenance/);
});
