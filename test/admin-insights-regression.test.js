import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
import {adminPath,MemberSession} from '../public/js/member-api.js';

test('P1 transport is explicitly allowed, CSRF protected and rejects extra paths/queries',async()=>{
 const id='M-'+randomUUID();
 for(const path of ['/api/admin/members-overview?nickname=A&status=active','/api/admin/members-overview/'+id,'/api/admin/members-overview/'+id+'/transactions?cursor=abc','/api/admin/health-monitor/summary','/api/admin/health-monitor/events?from=2026-10-01&type=backup','/api/admin/points/adjustments'])assert.equal(adminPath(path),true,path);
 for(const path of ['/api/admin/members-overview?token=x','/api/admin/members-overview?status=all&status=active','/api/admin/members-overview/'+id+'/delete','/api/admin/health-monitor/summary?refresh=true','/api/admin/health-monitor/reconcile','/api/admin/points/adjustments?token=x'])assert.equal(adminPath(path),false,path);
 const csrf=randomBytes(32).toString('hex');let sent;const session=new MemberSession({fetcher:async(p,o)=>{sent={p,o};return Response.json({ok:true,data:{}});}});
 session.accept({member:{member_id:id,status:'active'},csrf_token:csrf,expires_in:600});
 try{await session.adminRequest('/api/admin/points/adjustments',{method:'POST',headers:{'Idempotency-Key':'synthetic-key-123456'},body:{member_id:id,points:1,reason:'synthetic'}});
 assert.equal(sent.o.headers['X-CSRF-Token'],csrf);assert.equal(sent.o.headers['Idempotency-Key'],'synthetic-key-123456');assert.equal(sent.o.credentials,'same-origin');
 }finally{session.clear();}
});

test('nickname keysets retain ties, filter scope and Unicode prefix upper bounds',async()=>{
 const h=await embeddedCaseRuntime();try{
 const admin=await h.identity('admin');
 for(let i=0;i<23;i++){const m=await h.identity();await h.db.prepare('UPDATE members SET nickname=? WHERE member_id=?').bind('Prefix',m.memberId).run();}
 const get=async q=>(await (await h.fetch('/api/admin/members-overview?'+q,'GET',undefined,admin.headers)).json()).data;
 const a=await get('nickname=Prefix');assert.equal(a.members.length,20);
 const b=await get('nickname=Prefix&cursor='+encodeURIComponent(a.next_cursor));assert.equal(b.members.length,3);
 assert.equal(new Set([...a.members,...b.members].map(x=>x.member_id)).size,23);
 assert.equal((await h.fetch('/api/admin/members-overview?nickname=Other&cursor='+encodeURIComponent(a.next_cursor),'GET',undefined,admin.headers)).status,400);
 const match=await h.identity(),other=await h.identity();
 await h.db.prepare('UPDATE members SET nickname=? WHERE member_id=?').bind('A'+String.fromCodePoint(0x10ffff)+'suffix',match.memberId).run();
 await h.db.prepare('UPDATE members SET nickname=? WHERE member_id=?').bind('B',other.memberId).run();
 const edge=await get('nickname='+encodeURIComponent('A'+String.fromCodePoint(0x10ffff)));assert.deepEqual(edge.members.map(x=>x.member_id),[match.memberId]);
 }finally{h.close();}
});

test('member points match existing API; adjustments retain idempotency, audit, CSRF and permissions',async()=>{
 const h=await embeddedCaseRuntime();try{
 const admin=await h.identity('admin'),member=await h.identity(),reviewer=await h.identity('reviewer');
 const body={member_id:member.memberId,points:30,reason:'synthetic P1 check'},headers={...admin.headers,'Idempotency-Key':randomUUID()};
 for(let i=0;i<2;i++){const r=await h.fetch('/api/admin/points/adjustments','POST',body,headers);assert.equal(r.status,201,await r.clone().text());}
 const negative=await h.fetch('/api/admin/points/adjustments','POST',{...body,points:-10},{...headers,'Idempotency-Key':randomUUID()});assert.equal(negative.status,201);
 const get=async(p,a=admin)=>(await (await h.fetch(p,'GET',undefined,a.headers)).json()).data;
 const own=await get('/api/me/points',member),detail=(await get('/api/admin/members-overview/'+member.memberId)).member;
 assert.equal(detail.total_points,20);assert.equal(detail.total_points,own.total_points);assert.equal(detail.tier.tier_id,own.tier.tier_id);
 const history=await get('/api/admin/members-overview/'+member.memberId+'/transactions');assert.equal(history.transactions.length,2);
 assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE action='manual_adjustment'").first()).n,2);
 assert.equal((await h.fetch('/api/admin/points/adjustments','POST',body,{...reviewer.headers,'Idempotency-Key':randomUUID()})).status,403);
 assert.equal((await h.fetch('/api/admin/points/adjustments','POST',body,{...headers,'X-CSRF-Token':'wrong'})).status,403);
 assert.doesNotMatch(JSON.stringify(detail),/email|password_hash|google_identity_id|token/i);
 }finally{h.close();}
});

test('health multi-source equal-time pagination matches SQL ordering without gaps or duplicates',async()=>{
 const h=await embeddedCaseRuntime();try{
 const admin=await h.identity('admin'),stamp=Date.parse('2026-10-22T16:00:00Z')/1000,expected=[];
 for(let i=0;i<33;i++){
   const id=randomUUID();await h.db.prepare("INSERT INTO storage_alerts(id,episode,kind,created_at,state) VALUES(?,?,'cleanup_failed',?,'sent')").bind(id,i+10,stamp).run();expected.push('alert:'+id);
   const aid=randomUUID();await h.db.prepare("INSERT INTO storage_audit(id,created_at,action,target,detail) VALUES(?,?,'alert_ambiguous','synthetic','{}')").bind(aid,stamp).run();expected.push('audit:'+aid);
 }
 expected.sort().reverse();const actual=[];let cursor=null;
 do{const q=new URLSearchParams({from:'2026-10-23',to:'2026-10-23'});if(cursor)q.set('cursor',cursor);
 const r=await h.fetch('/api/admin/health-monitor/events?'+q,'GET',undefined,admin.headers);assert.equal(r.status,200,await r.clone().text());
 const d=(await r.json()).data;actual.push(...d.events.map(e=>e.id));cursor=d.next_cursor;assert.ok(actual.length<=66);
 }while(cursor);assert.deepEqual(actual,expected);
 const resolved=await h.fetch('/api/admin/health-monitor/events?status=resolved','GET',undefined,admin.headers);assert.deepEqual((await resolved.json()).data.events,[]);
 const pending=await h.fetch('/api/admin/health-monitor/events?type=cleanup&status=pending','GET',undefined,admin.headers);assert.equal((await pending.json()).data.events.length,20);
 const previous=await h.fetch('/api/admin/health-monitor/events?to=2026-10-22','GET',undefined,admin.headers);assert.deepEqual((await previous.json()).data.events,[]);
 }finally{h.close();}
});

test('health summary skips unrelated history/quota reads and keeps incomplete coverage UNKNOWN',async()=>{
 const h=await embeddedCaseRuntime();try{
 const admin=await h.identity('admin');const sql=[],prepare=h.db.prepare.bind(h.db);h.db.prepare=s=>{sql.push(s);return prepare(s);};
 const r=await h.fetch('/api/admin/health-monitor/summary','GET',undefined,admin.headers);assert.equal(r.status,200);
 const d=(await r.json()).data;assert.equal(d.upload_failures.count,null);assert.equal(d.pending_operations.legacy_ack_unverified,true);assert.equal(d.storage.cleanup_mode,'dry-run');
 assert.equal(d.pending_operations.count,null);assert.equal(d.pending_operations.coverage,'partial_coverage');
 assert.equal(d.pending_operations.active,null);assert.equal(d.pending_operations.archive_dispatches,null);
 assert.ok(!sql.some(s=>/storage_history|drive_quota_snapshots|FROM image_mutation_operations|FROM storage_archive_dispatches|FROM image_maintenance_control/.test(s)));
 assert.equal((await h.fetch('/api/admin/health-monitor/events?from=2026-02-30','GET',undefined,admin.headers)).status,400);
 }finally{h.close();}
});
