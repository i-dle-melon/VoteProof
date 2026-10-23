import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {auditSummary,auditDetail,auditText} from '../src/lib/admin-audit.js';
import {auditLogs} from '../src/lib/admin-store.js';
import {adminPage} from '../src/api/admin-validation.js';
import {adminPath} from '../public/js/member-api.js';
let h,admin,reviewer,normal,noFan,unElevated,id,shared,pendingMail,finishedMail,contactId;
const url=q=>new URL('https://voteproof.example/api/admin/audit-logs'+q);
before(async()=>{
 h=await localAdminRuntime();admin=await h.identity({role:'admin',fanId:'audit_fan_01'});reviewer=await h.identity({role:'reviewer'});normal=await h.identity();noFan=await h.identity({role:'admin',fanId:null});unElevated=await h.identity({role:'admin',elevated:false});
 const insert=(key,actor,target,time='2026-10-23T02:00:00.000Z')=>h.local.db.prepare(`INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json,reason) VALUES(?,?,?,'admin','campaign_update','campaign',?,0,?,?,?)`).bind(key,time,actor.memberId,target,JSON.stringify({status:'draft',object_key:'private-object',token:'never-return',private:'never-return'}),JSON.stringify({status:'active',note:'活動說明。'.repeat(800),cookie:'never-return'}),'調整活動');
 id=randomUUID();shared='ffffffff-ffff-4fff-8fff-fffffffffff0';const statements=[insert(id,admin,'DETAIL'),insert(shared,admin,'TIE')];for(let i=0;i<120;i++)statements.push(insert(randomUUID(),admin,'SYNTHETIC-'+i));await h.local.db.batch(statements);
 await h.local.db.prepare(`INSERT INTO admin_content_audit(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json,reason) VALUES(?,? ,?,'admin','announcement_update','announcement','CONTENT',0,'{}','{"enabled":true}',NULL)`).bind(shared,'2026-10-23T02:00:00.000Z',admin.memberId).run();
 await h.local.db.prepare(`INSERT INTO member_status_events(id,member_id,created_at,admin_member_id,admin_role,action,before_status,after_status,reason) VALUES(?,?,? ,?,'admin','member_block','active','suspended','測試原因')`).bind(randomUUID(),normal.memberId,'2026-10-23T02:00:00.000Z',noFan.memberId).run();
 pendingMail=randomUUID();finishedMail=randomUUID();contactId=randomUUID();
 for(const key of [pendingMail,finishedMail])await h.local.db.prepare(`INSERT INTO admin_member_mail_requests(send_id,created_at,admin_member_id,admin_role,target_member_id,subject_hash,body_hash,recipient_ref) VALUES(?,?,?,'admin',?,?,?,?)`).bind(key,'2026-10-23T02:00:00.000Z',admin.memberId,normal.memberId,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64)).run();
 await h.local.db.prepare(`INSERT INTO admin_member_contact_audit(id,created_at,admin_member_id,admin_role,target_member_id,action,send_id,outcome,subject_hash,body_hash) VALUES(?,?,?,'admin',?,'member_mail_send',?,'sent',?,?)`).bind(contactId,'2026-10-23T02:00:00.000Z',admin.memberId,normal.memberId,finishedMail,'a'.repeat(64),'b'.repeat(64)).run();
});
after(async()=>{await h?.local.runtime.dispose();});
const get=(path,actor=admin)=>h.local.fetch(path,'GET',undefined,actor?.headers??{});
test('summary returns Fan ID, excludes full payload and internal actor/target member identifiers',async()=>{
 const r=await get('/api/admin/audit-logs?view=summary&limit=50');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const d=(await r.json()).data;assert.equal(d.logs.length,50);assert.ok(d.logs.every(x=>x.actor_kind==='admin'));assert.ok(d.logs.some(x=>x.operator_fan_id==='audit_fan_01'));for(const x of d.logs){assert.ok(!('admin_member_id'in x));assert.ok(!('before'in x));assert.ok(!('after'in x));}
 assert.doesNotMatch(JSON.stringify(d),/private-object|never-return|"object_key"|"token"|"cookie"/);
 const member=(await(await get('/api/admin/audit-logs?view=summary&action=member_block')).json()).data.logs[0];assert.equal(member.operator_fan_id,null);assert.ok(member.target.startsWith('local-'));assert.equal(member.target_id,null);assert.ok(!JSON.stringify(member).includes(normal.memberId));
});
test('same timestamp and same UUID in different existing sources page without losing either record',async()=>{
 const a=(await(await get('/api/admin/audit-logs?view=summary&limit=1')).json()).data,b=(await(await get('/api/admin/audit-logs?view=summary&limit=1&cursor='+encodeURIComponent(a.next_cursor))).json()).data;
 assert.equal(a.logs[0].id,shared);assert.equal(b.logs[0].id,shared);assert.notEqual(a.logs[0].source,b.logs[0].source);assert.equal(a.logs[0].source,'content');assert.equal(b.logs[0].source,'admin');
});
test('detail is one row, no-store, original safe before/after only, no credentials or private paths',async()=>{
 const r=await get('/api/admin/audit-logs/'+id+'?source=admin');assert.equal(r.status,200);const d=(await r.json()).data.log;assert.equal(d.operator_fan_id,'audit_fan_01');assert.equal(d.before.status,'draft');assert.equal(d.after.status,'active');assert.equal(d.after.note.length,4000);assert.doesNotMatch(JSON.stringify(d),/private-object|never-return|"object_key"|"token"|"cookie"|"admin_member_id"/);
});
test('existing contact/pending-mail semantics remain distinct and finalized requests are not duplicated',async()=>{
 const response=await get('/api/admin/audit-logs?view=summary&action=member_mail_send');const rows=(await response.json()).data.logs;assert.equal(rows.length,2);assert.ok(rows.some(x=>x.id===pendingMail&&x.source==='mail_pending'));assert.ok(rows.some(x=>x.id===contactId&&x.source==='member_contact'));assert.ok(!rows.some(x=>x.id===finishedMail));
 const pending=(await(await get('/api/admin/audit-logs/'+pendingMail+'?source=mail_pending')).json()).data.log;assert.deepEqual(pending.after,{outcome:'ambiguous'});assert.ok(!JSON.stringify(pending).includes(normal.memberId));assert.doesNotMatch(JSON.stringify(pending),/subject_hash|body_hash|recipient_ref/);
});
test('detail authentication and admin/super_admin MFA gate cannot be bypassed',async()=>{
 for(const [actor,code]of [[null,401],[normal,403],[reviewer,403],[unElevated,403]]){const r=await get('/api/admin/audit-logs/'+id+'?source=admin',actor);assert.equal(r.status,code);assert.doesNotMatch(await r.text(),/audit_fan_01|4000/);}
});
test('invalid detail source/UUID/extra query, nonexistent records and write methods are rejected',async()=>{
 for(const tail of ['x?source=admin',id+'?source=sqlite_master',id+'?source=admin&source=admin',id+'?source=admin&extra=1'])assert.equal((await get('/api/admin/audit-logs/'+tail)).status,400);
 assert.equal((await get('/api/admin/audit-logs/'+randomUUID()+'?source=admin')).status,404);
 for(const method of ['POST','DELETE'])assert.equal((await h.local.fetch('/api/admin/audit-logs/'+id+'?source=admin',method,{},admin.headers)).status,405);
});
test('summary/legacy cursors remain scoped, limits validate, default legacy contract remains intact',async()=>{
 const old=(await(await get('/api/admin/audit-logs?limit=1')).json()).data;assert.ok(old.logs[0].before);assert.equal((await get('/api/admin/audit-logs?view=summary&limit=1&cursor='+encodeURIComponent(old.next_cursor))).status,400);
 for(const q of ['view=anything','view=summary&limit=51','view=summary&limit=0','view=summary&cursor=bad','view=summary&view=summary'])assert.equal((await get('/api/admin/audit-logs?'+q)).status,400);
});
test('summary/detail add one data statement, bounded page-first member joins, no N+1, COUNT or OFFSET',async()=>{
 const queries=[];const db={prepare:q=>{queries.push(q);return h.local.db.prepare(q);}};
 await auditSummary(db,adminPage(url('?view=summary&limit=20'),true));assert.equal(queries.length,1);assert.doesNotMatch(queries[0],/\bOFFSET\b|\bCOUNT\s*\(|before_json|after_json/);assert.equal((queries[0].match(/LIMIT \?/g)??[]).length,6);assert.match(queries[0],/FROM p LEFT JOIN members actor/);
 queries.length=0;await auditDetail(db,url('/'+id+'?source=admin'));assert.equal(queries.length,1);assert.match(queries[0],/LIMIT 1/);
});
test('system and missing-Fan-ID DTO mapping are distinct; sensitive free text is redacted',async()=>{
 const row={id,created_at:'2026-10-23T02:00:00.000Z',admin_member_id:null,actor_fan_id:null,target_fan_id:null,source:'admin',action:'campaign_update',target_type:'campaign',target_id:'LOCAL',reason:null};
 const fake={prepare:()=>({bind:()=>({all:async()=>({results:[row]})})})};assert.equal((await auditSummary(fake,adminPage(url('?view=summary'),true))).logs[0].actor_kind,'system');
 row.admin_member_id=admin.memberId;assert.equal((await auditSummary(fake,adminPage(url('?view=summary'),true))).logs[0].actor_kind,'admin');
 assert.doesNotMatch(auditText('secret=unsafe https://private.example/path proofs/private/file '+admin.memberId),/unsafe|private\.example|proofs\/|M-/);
});
test('admin client transport allowlists only the new authenticated read path',()=>{
 assert.ok(adminPath('/api/admin/audit-logs/'+id+'?source=admin'));for(const p of ['/api/admin/audit-logs/'+id+'?source=bad','/api/admin/audit-logs/'+id+'?source=admin&source=admin','/api/admin/audit-logs/'+id+'/delete'])assert.equal(adminPath(p),false);
});
test('representative local D1 row/byte comparison is recorded, not presented as Cloudflare CPU',async()=>{
 const captures=[];
 const db={prepare(q){const s=h.local.db.prepare(q);return {bind(...v){return {async first(){return (await this.all()).results[0]??null;},async all(){
   const result=await s.bind(...v).all();captures.push({rows_read:result.meta.rows_read,rows_written:result.meta.rows_written,duration_ms:result.meta.duration});return result;
 }}}};}};
 const legacy=await auditLogs(db,adminPage(url('?limit=20'),true)),summary=await auditSummary(db,adminPage(url('?view=summary&limit=20'),true)),detail=await auditDetail(db,url('/'+id+'?source=admin'));
 const out={fixture:'122 admin + 1 content + 1 status + 1 confirmed contact + 2 mail requests (one finalized), synthetic; 4000-character safe note per admin row',page_size:20,legacy:{...captures[0],response_bytes:Buffer.byteLength(JSON.stringify(legacy))},summary:{...captures[1],response_bytes:Buffer.byteLength(JSON.stringify(summary))},detail:{...captures[2],response_bytes:Buffer.byteLength(JSON.stringify(detail))},worker_cpu:'UNKNOWN - local SQL metadata is not Cloudflare CPU'};assert.ok(out.summary.response_bytes<out.legacy.response_bytes);mkdirSync('.wrangler',{recursive:true});writeFileSync('.wrangler/audit-costs.json',JSON.stringify(out,null,2));
});
