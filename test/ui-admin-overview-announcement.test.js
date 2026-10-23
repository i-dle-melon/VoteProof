import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
import {announcementInput} from '../src/lib/site-content.js';
const input={title:'Link switch',body:'Plain text',enabled:true,dismissible:true,button_label:'Guide',button_url:'https://example.com/guide'};
test('overview exposes only authoritative total to MFA-elevated staff, never public/member clients',async()=>{
 const h=await embeddedCaseRuntime();try{
 const admin=await h.identity('super_admin'),reviewer=await h.identity('reviewer'),member=await h.identity(),suspended=await h.identity();
 await h.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(suspended.memberId).run();
 const expected=(await h.db.prepare('SELECT COUNT(*) n FROM members').first()).n;
 for(const actor of [admin,reviewer]){const r=await h.fetch('/api/admin/overview','GET',undefined,actor.headers);assert.equal(r.status,200);const overview=(await r.json()).data;assert.equal(overview.member_count,expected);assert.deepEqual(overview.case_totals,{pending:0,approved:0,rejected:0,revoked:0});}
 for(const [actor,status] of [[null,401],[member,403],[suspended,403]])assert.equal((await h.fetch('/api/admin/overview','GET',undefined,actor?.headers)).status,status);
 assert.equal((await h.fetch('/api/admin/overview?email=x','GET',undefined,admin.headers)).status,400);
 assert.equal((await h.fetch('/api/admin/overview','POST',{},admin.headers)).status,405);
 await h.db.prepare('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?').bind(reviewer.memberId).run();assert.equal((await h.fetch('/api/admin/overview','GET',undefined,reviewer.headers)).status,403);
 }finally{h.close();}
});
test('0022 adds only a checked link visibility column and preserves populated 0021 announcements',async()=>{
 const h=await embeddedCaseRuntime({migrationThrough:'0021_campaign_content_announcements.sql'});try{
 const a=await h.identity('admin');await h.db.prepare(`INSERT INTO site_announcements(announcement_id,title,body,button_label,button_url,created_at,updated_at,updated_by,last_mutation_id) VALUES(?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),input.title,input.body,input.button_label,input.button_url,'2026-01-01','2026-01-01',a.memberId,crypto.randomUUID()).run();
 const before=(await h.db.prepare('SELECT * FROM site_announcements').all()).results;
 const sql=await readFile(new URL('../migrations/0022_announcement_button_visibility.sql',import.meta.url),'utf8');assert.doesNotMatch(sql,/\b(?:DROP|DELETE|UPDATE)\b/i);
 await h.db.batch(unstable_splitSqlQuery(sql).map(s=>h.db.prepare(s)));
 const after=(await h.db.prepare('SELECT * FROM site_announcements').all()).results;assert.deepEqual(after.map(({button_enabled,...r})=>{assert.equal(button_enabled,1);return r;}),before);
 await assert.rejects(h.db.prepare('UPDATE site_announcements SET button_enabled=2').run());
 assert.deepEqual((await h.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await h.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
 }finally{h.close();}
});
test('announcement visibility toggle retains URL, is public-safe, versioned and audited',async()=>{
 const h=await embeddedCaseRuntime();try{
 const a=await h.identity('admin');const post=(path,body)=>h.fetch(path,'POST',body,a.headers);
 let r=await post('/api/admin/announcements',{...input,button_enabled:false});assert.equal(r.status,201,await r.clone().text());let row=(await r.json()).data;
 let pub=(await(await h.fetch('/api/announcements')).json()).data.announcements[0];assert.equal(pub.button_enabled,false);assert.equal(pub.button_url,input.button_url);
 r=await post('/api/admin/announcements/'+row.announcement_id+'/update',{...input,button_enabled:true,expected_version:row.version});assert.equal(r.status,200);row=(await r.json()).data;assert.equal(row.version,1);assert.equal(row.button_enabled,true);
 pub=(await(await h.fetch('/api/announcements')).json()).data.announcements[0];assert.equal(pub.button_url,input.button_url);assert.equal(pub.button_enabled,true);assert.equal(pub.updated_by,undefined);
 const audit=(await h.db.prepare("SELECT after_json FROM admin_content_audit WHERE action='announcement_update'").first()).after_json;assert.equal(JSON.parse(audit).button_enabled,1);
 assert.throws(()=>announcementInput({...input,button_enabled:'false'}));assert.throws(()=>announcementInput({...input,button_enabled:true,button_url:'',button_label:''}));assert.throws(()=>announcementInput({...input,button_enabled:false,button_url:'javascript:alert(1)'}));
 }finally{h.close();}
});
