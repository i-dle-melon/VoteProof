import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {embeddedCaseRuntime,origin} from './helpers/embedded-case-runtime.mjs';
import worker from '../src/index.js';
import {announcementInput} from '../src/lib/site-content.js';
let h,admin,reviewer,member;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh0kAAAAASUVORK5CYII=','base64');
const input={campaign_id:'CONTENT_TEST',name:'Content test',category:'Solo',solo_target:'yuqi',start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',status:'active',points_per_proof:10,daily_limit:null};
const announcement={title:'Cooperation',body:'First line\n<script>alert(1)</script>',enabled:true,dismissible:true,starts_at:null,ends_at:null,button_label:'Guide',button_url:'https://example.com/guide'};
const data=async(r,status=200)=>{const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j.data;};
const post=(p,b,a=admin)=>h.fetch(p,'POST',b,a?.headers);
const raw=(body=png,mime='image/png',actor=admin,id='CONTENT_TEST',extra={})=>worker.fetch(new Request(origin+'/api/admin/campaign-assets/'+id,{method:'POST',headers:{'Content-Type':mime,...actor?.headers,...extra},body}),h.env);
const save=(row,content)=>post('/api/admin/campaigns/'+row.campaign_id+'/update',{...Object.fromEntries(Object.keys(input).filter(k=>k!=="campaign_id").map(k=>[k,row[k]])),expected_version:row.version,...content});
before(async()=>{h=await embeddedCaseRuntime();admin=await h.identity('super_admin');reviewer=await h.identity('reviewer');member=await h.identity();});after(()=>h?.close());
test('historical Campaign remains readable and empty guidance contains no fabricated image',async()=>{
 await data(await post('/api/admin/campaigns',input),201);const content=await data(await h.fetch('/api/campaigns/CONTENT_TEST/guidance'));assert.deepEqual(content,{submission_instructions:'',example_image_url:null});assert.equal((await h.fetch('/api/campaigns/CONTENT_TEST/example')).status,404);
});
test('asset upload enforces auth, RBAC, MFA, CSRF, Origin, MIME, bytes and size before storing',async()=>{
 for(const actor of [null,member,reviewer])assert.ok([401,403].includes((await raw(png,'image/png',actor)).status));
 const noCsrf={headers:{...admin.headers}};delete noCsrf.headers['X-CSRF-Token'];assert.equal((await raw(png,'image/png',noCsrf)).status,403);
 assert.equal((await raw(png,'image/png',admin,'CONTENT_TEST',{Origin:'https://evil.example'})).status,403);
 assert.equal((await raw('<svg onload="alert(1)"/>','image/svg+xml')).status,400);assert.equal((await raw('<html>','image/png')).status,400);assert.equal((await raw(new Uint8Array(5242881))).status,413);
 await h.db.prepare('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?').bind(admin.memberId).run();assert.equal((await raw()).status,403);await h.db.prepare('UPDATE auth_sessions SET elevated_until=? WHERE member_id=?').bind(Math.floor(Date.now()/1000)+3600,admin.memberId).run();assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM campaign_example_assets').first()).n,0);
});
test('image create, failed replacement, successful replacement and removal preserve proof namespace',async()=>{
 const first=await data(await raw(),201),key=(await h.db.prepare('SELECT object_key FROM campaign_example_assets WHERE asset_id=?').bind(first.asset_id).first()).object_key;
 assert.match(key,/^campaign-assets\/CONTENT_TEST\/example\//);await h.bucket.put('proofs/unchanged',png,{httpMetadata:{contentType:'image/png'}});
 let row=await data(await h.fetch('/api/admin/campaigns/CONTENT_TEST','GET',undefined,admin.headers));row=await data(await save(row,{submission_instructions:'Partners\nNotes',example_asset_id:first.asset_id}));
 let guidance=await data(await h.fetch('/api/campaigns/CONTENT_TEST/guidance'));assert.equal(guidance.submission_instructions,'Partners\nNotes');const image=await h.fetch(guidance.example_image_url);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);assert.equal(image.headers.get('X-Content-Type-Options'),'nosniff');
 assert.equal((await raw('<svg/>','image/png')).status,400);assert.ok(await h.bucket.head(key));
 const second=await data(await raw(),201);assert.ok(await h.bucket.head(key));assert.equal((await save({...row,version:99},{submission_instructions:'Fail',example_asset_id:second.asset_id})).status,409);assert.ok(await h.bucket.head(key));
 row=await data(await save(row,{submission_instructions:'Replaced',example_asset_id:second.asset_id}));assert.equal(await h.bucket.head(key),null);assert.equal((await save(row,{submission_instructions:'Cannot revive removed image',example_asset_id:first.asset_id})).status,400);assert.ok(await h.bucket.head('proofs/unchanged'));assert.equal((await h.fetch('/api/campaigns/CONTENT_TEST/example')).status,200);
 row=await data(await save(row,{submission_instructions:'',example_asset_id:null}));assert.deepEqual(await data(await h.fetch('/api/campaigns/CONTENT_TEST/guidance')),{submission_instructions:'',example_image_url:null});assert.ok(await h.bucket.head('proofs/unchanged'));
 const actions=(await h.db.prepare('SELECT DISTINCT action FROM admin_content_audit').all()).results.map(r=>r.action);for(const action of ['example_image_upload','example_image_replace','example_image_delete','submission_note_update'])assert.ok(actions.includes(action));
 assert.equal((await h.fetch('/api/admin/audit-logs','GET',undefined,admin.headers)).status,200);
});
test('assets cannot be attached to another Campaign or fetched by caller-selected R2 key',async()=>{
 const asset=await data(await raw(png,'image/png',admin,'OTHER_CAMPAIGN'),201),row=await data(await h.fetch('/api/admin/campaigns/CONTENT_TEST','GET',undefined,admin.headers));assert.equal((await save(row,{submission_instructions:'',example_asset_id:asset.asset_id})).status,400);assert.equal((await h.fetch('/api/campaigns/CONTENT_TEST/example?key=proofs/unchanged')).status,400);
});
test('announcement URL and scheduling validation rejects unsafe or ambiguous values',()=>{
 for(const button_url of ['javascript:alert(1)','data:text/html,x','https://u:p@example.com','//evil.example'])assert.throws(()=>announcementInput({...announcement,button_url}));
 assert.throws(()=>announcementInput({...announcement,starts_at:'2027-01-01T00:00:00.000Z',ends_at:'2026-01-01T00:00:00.000Z'}));assert.throws(()=>announcementInput({...announcement,html:'<b>x</b>'}));assert.equal(announcementInput(announcement).body,announcement.body);
});
test('announcement Admin-only mutation, version CAS, server scheduling and immutable audit',async()=>{
 for(const actor of [null,member,reviewer])for(const method of ['GET','POST'])assert.ok([401,403].includes((await h.fetch('/api/admin/announcements',method,method==='POST'?announcement:undefined,actor?.headers)).status));
 const noCsrf={...admin.headers};delete noCsrf['X-CSRF-Token'];assert.equal((await h.fetch('/api/admin/announcements','POST',announcement,noCsrf)).status,403);
 const row=await data(await post('/api/admin/announcements',announcement),201),path='/api/admin/announcements/'+row.announcement_id+'/update';assert.equal((await data(await h.fetch('/api/announcements'))).announcements.length,1);
 assert.equal((await post(path,{...announcement,expected_version:99})).status,409);
 let next=await data(await post(path,{...announcement,expected_version:row.version,enabled:false}));assert.equal((await data(await h.fetch('/api/announcements'))).announcements.length,0);
 next=await data(await post(path,{...announcement,expected_version:next.version,starts_at:'2099-01-01T00:00:00.000Z'}));assert.equal((await data(await h.fetch('/api/announcements'))).announcements.length,0);
 next=await data(await post(path,{...announcement,expected_version:next.version,ends_at:'2000-01-01T00:00:00.000Z'}));assert.equal((await data(await h.fetch('/api/announcements'))).announcements.length,0);
 next=await data(await post(path,{...announcement,title:'New version',expected_version:next.version}));const pub=(await data(await h.fetch('/api/announcements'))).announcements[0];assert.equal(pub.version,next.version);assert.equal(pub.updated_by,undefined);assert.equal(pub.body,announcement.body);
 const actions=(await h.db.prepare("SELECT DISTINCT action FROM admin_content_audit WHERE target_type='announcement'").all()).results.map(r=>r.action);for(const action of ['announcement_create','announcement_update','announcement_enable','announcement_disable'])assert.ok(actions.includes(action));
 await assert.rejects(h.db.prepare("DELETE FROM admin_content_audit WHERE target_type='announcement'").run());await assert.rejects(h.db.prepare("UPDATE admin_content_audit SET action='changed'").run());
 assert.deepEqual((await h.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal(Object.values(await h.db.prepare('PRAGMA quick_check').first())[0],'ok');
});
test('failed content transactions roll back publication and remove only newly uncommitted image bytes',async()=>{
 const before=(await h.db.prepare('SELECT COUNT(*) n FROM site_announcements').first()).n,assets=(await h.db.prepare('SELECT COUNT(*) n FROM campaign_example_assets').first()).n;
 const original=h.db.batch.bind(h.db),put=h.bucket.put.bind(h.bucket);let key;
 h.db.batch=statements=>original([...statements,h.db.prepare('SELECT * FROM injected_content_failure')]);h.bucket.put=async(k,...args)=>{key=k;return put(k,...args);};
 try{assert.equal((await post('/api/admin/announcements',announcement)).status,503);assert.equal((await raw()).status,503);}finally{h.db.batch=original;h.bucket.put=put;}
 assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM site_announcements').first()).n,before);assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM campaign_example_assets').first()).n,assets);assert.match(key,/^campaign-assets\/CONTENT_TEST\/example\//);assert.equal(await h.bucket.head(key),null);assert.ok(await h.bucket.head('proofs/unchanged'));
});
