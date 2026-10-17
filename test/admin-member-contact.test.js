import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {encryptEmail,emailHash} from '../src/lib/auth-identity.js';
import {resolveContactEmails,mailText,contactLimits} from '../src/lib/admin-member-contact.js';
import {fakeAdminRelay} from './helpers/admin-mail-relay.mjs';
const url='https://script.google.com'+'/macros/s/SYNTHETIC_ADMIN_CONTACT/exec';
async function seedIdentity(h,target,email='member@example.invalid'){
 const subject=randomUUID(),encrypted=await encryptEmail(h.env,email,subject);
 await h.db.prepare(`INSERT INTO auth_identities(provider,provider_subject,member_id,email_lookup_hash,email_ciphertext,email_iv,email_key_version,created_at,password_enabled,google_identity_id) VALUES('supabase',?,?,?,?,?,?,?,1,?)`)
  .bind(subject,target.memberId,await emailHash(h.env,email),encrypted.email_ciphertext,encrypted.email_iv,encrypted.email_key_version,Math.floor(Date.now()/1000),randomUUID()).run();
}
async function fixture(){
 const h=await embeddedCaseRuntime(),relay=fakeAdminRelay();h.env.AUTH_TOTP_ENCRYPTION_KEY=randomBytes(32).toString('hex');h.env.ADMIN_MAIL_RELAY_URL=url;h.env.ADMIN_MAIL_RELAY_SECRET=relay.secret;
 const admin=await h.identity('admin'),member=await h.identity();await seedIdentity(h,member);const fan=(await h.db.prepare('SELECT player_id FROM members WHERE member_id=?').bind(member.memberId).first()).player_id;
 const upstream=mock.method(globalThis,'fetch',relay.fetch.bind(relay));
 return{...h,relay,admin,member,fan,lookup:(actor=admin,fanId=fan,headers=actor?.headers)=>h.fetch('/api/admin/member-lookup','POST',{fan_id:fanId},headers),
  send:(body={},actor=admin)=>h.fetch('/api/admin/member-mail/send','POST',{member_id:member.memberId,subject:'客服說明',body:'您好，這是測試訊息。',mutation_id:randomUUID(),...body},actor?.headers),
  close(){upstream.mock.restore();h.close();}};
}
test('admin and super_admin exact normalized lookup decrypt safe fields and append explicit reveal audit',async()=>{
 const h=await fixture();try{
 for(const actor of [h.admin,await h.identity('super_admin')]){const r=await h.lookup(actor,' '+h.fan.toUpperCase()+' ');assert.equal(r.status,200,await r.clone().text());assert.equal(r.headers.get('Cache-Control'),'no-store');const{member:m}=(await r.json()).data;assert.equal(m.member_id,h.member.memberId);assert.equal(m.fan_id,h.fan);assert.equal(m.emails[0].email,'member@example.invalid');assert.deepEqual(m.emails[0].providers,['Email／密碼','Google']);assert.deepEqual(m.proof_counts,{total:0,pending:0,approved:0,rejected:0});assert.equal(m.total_points,0);assert.doesNotMatch(JSON.stringify(m),/provider_subject|email_ciphertext|email_iv|lookup_hash|token_hash|recovery|totp|login_name/);}
 assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM admin_member_contact_audit').first()).n,2);assert.equal(h.relay.sent.length,0);
 }finally{h.close();}
});
test('reviewer/member/guest direct lookup and send are 403, no email disclosure or delivery',async()=>{
 const h=await fixture();try{for(const a of [await h.identity('reviewer'),h.member,null])for(const r of [await h.lookup(a),await h.send({},a)]){assert.equal(r.status,403);assert.doesNotMatch(await r.text(),/member@example|email_ciphertext/);}assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM admin_member_contact_audit').first()).n,0);assert.equal(h.relay.sent.length,0);}finally{h.close();}
});
test('contact endpoints preserve MFA, Origin, CSRF, suspended/revoked admin rules',async()=>{
 const h=await fixture();try{
 const missing={...h.admin.headers};delete missing['X-CSRF-Token'];
 for(const headers of [missing,{...h.admin.headers,Origin:'https://evil.invalid'},{...h.admin.headers,'Sec-Fetch-Site':'cross-site'}])assert.equal((await h.lookup(h.admin,h.fan,headers)).status,403);
 for(const sql of ["UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?","UPDATE members SET status='suspended' WHERE member_id=?"]){await h.db.prepare(sql).bind(h.admin.memberId).run();assert.equal((await h.lookup()).status,403);assert.equal((await h.send()).status,403);}
 assert.equal(h.relay.sent.length,0);
 }finally{h.close();}
});
test('missing fan, no fuzzy query or arbitrary member ID, suspended target can be looked up',async()=>{
 const h=await fixture();try{
 assert.equal((await h.lookup(h.admin,'missing')).status,404);assert.equal((await h.lookup(h.admin,h.fan.slice(0,-1))).status,404);
 assert.equal((await h.fetch('/api/admin/member-lookup?fan_id='+h.fan,'POST',{fan_id:h.fan},h.admin.headers)).status,400);
 for(const b of [{member_id:h.member.memberId},{fan_id:h.fan,email:true},{fan_id:'\n'+h.fan}])assert.equal((await h.fetch('/api/admin/member-lookup','POST',b,h.admin.headers)).status,400);
 assert.equal((await h.send()).status,403);
 await h.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(h.member.memberId).run();const r=await h.lookup();assert.equal(r.status,200);assert.equal((await r.json()).data.member.status,'suspended');
 }finally{h.close();}
});
test('email resolver dedupes verified identities, preserves distinct addresses/provider labels, fails closed on bad ciphertext',async()=>{
 const env={AUTH_SECRET:randomBytes(32).toString('hex'),AUTH_TOTP_ENCRYPTION_KEY:randomBytes(32).toString('hex')};
 const rows=[];for(const[email,password,google]of [['member@example.invalid',1,null],['MEMBER@example.invalid',0,randomUUID()],['other@example.invalid',0,randomUUID()]]){const provider_subject=randomUUID();rows.push({provider:'supabase',provider_subject,...await encryptEmail(env,email,provider_subject),password_enabled:password,google_identity_id:google});}
 const db={prepare:()=>({bind:()=>({all:async()=>({results:rows})})})};const out=await resolveContactEmails(db,env,'M-SYNTHETIC');assert.equal(out.length,2);assert.deepEqual(out[0].providers,['Email／密碼','Google']);assert.notEqual(out[0].recipient_ref,out[1].recipient_ref);assert.doesNotMatch(JSON.stringify(out),/provider_subject|ciphertext/);
 rows[0].email_iv='0'.repeat(24);await assert.rejects(resolveContactEmails(db,env,'M-SYNTHETIC'),{code:'MEMBER_EMAIL_UNAVAILABLE'});
});
test('send reloads D1 authoritative recipient, rejects Browser from/to/html/URL, requires fresh lookup',async()=>{
 const h=await fixture();try{
 await h.lookup();for(const extra of [{to:'attacker@example.invalid'},{from:'attacker@example.invalid'},{html:'<b>mail</b>'},{relay_url:'https://evil.invalid'},{cc:'x'},{headers:{}}])assert.equal((await h.send(extra)).status,400);
 const r=await h.send();assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).data.outcome,'sent');assert.equal(h.relay.sent.length,1);assert.equal(h.relay.sent[0].to,'member@example.invalid');assert.equal(h.relay.sent[0].from,undefined);
 await h.db.prepare('DELETE FROM auth_identities WHERE member_id=?').bind(h.member.memberId).run();assert.equal((await h.send()).status,409);assert.equal(h.relay.sent.length,1);
 }finally{h.close();}
});
test('subject/body limits, CRLF normalization, unicode and header/control injection',()=>{
 assert.deepEqual(mailText(' 主旨 ',' 一\r\n二\r三 '),{subject:'主旨',body:'一\n二\n三'});assert.equal([...mailText('字'.repeat(150),'葉'.repeat(10000)).body].length,10000);
 for(const[s,b]of [['','body'],['x'.repeat(151),'body'],['subject','x'.repeat(10001)],['subject',''],['subject\r\nBcc: x','body'],['subject\u2028X','body'],['subject','body\u0000'],['subject','body\u0085'],['\ud800','body']])assert.throws(()=>mailText(s,b));
});
test('duplicate/concurrent mutation reserves and sends once, conflict never sends, immutable no-plaintext audit',async()=>{
 const h=await fixture();try{
 await h.lookup();const mutation_id=randomUUID(),responses=await Promise.all([h.send({mutation_id}),h.send({mutation_id})]);for(const r of responses)assert.equal(r.status,200,await r.clone().text());assert.equal(h.relay.sent.length,1);const again=await h.send({mutation_id});assert.equal((await again.json()).data.outcome,'sent');assert.equal((await h.send({mutation_id,subject:'changed'})).status,409);
 const requests=(await h.db.prepare('SELECT * FROM admin_member_mail_requests').all()).results,audit=(await h.db.prepare('SELECT * FROM admin_member_contact_audit').all()).results;assert.equal(requests.length,1);assert.equal(audit.length,2);assert.doesNotMatch(JSON.stringify({requests,audit}),/member@example|客服說明|您好|email_ciphertext|email_iv|signature/);
 for(const table of ['admin_member_mail_requests','admin_member_contact_audit']){await assert.rejects(h.db.prepare('UPDATE '+table+" SET created_at='2000'").run());await assert.rejects(h.db.prepare('DELETE FROM '+table).run());const rows=(await h.db.prepare('SELECT * FROM '+table).all()).results;for(const row of rows)await assert.rejects(h.db.prepare('INSERT OR REPLACE INTO '+table+'('+Object.keys(row).join(',')+') VALUES('+Object.keys(row).map(()=>'?').join(',')+')').bind(...Object.values(row)).run());}
 }finally{h.close();}
});
test('network timeout is ambiguous, repeated mutation never retries; failed result audit also never retries',async()=>{
 const h=await fixture();try{
 await h.lookup();const first=randomUUID();const original=globalThis.fetch;globalThis.fetch=async()=>{throw new DOMException('Synthetic timeout','AbortError');};try{const r=await h.send({mutation_id:first});assert.equal((await r.json()).data.outcome,'ambiguous');}finally{globalThis.fetch=original;}
 assert.equal((await(await h.send({mutation_id:first})).json()).data.outcome,'ambiguous');assert.equal(h.relay.sent.length,0);
 await h.db.prepare("CREATE TRIGGER synthetic_contact_audit_failure BEFORE INSERT ON admin_member_contact_audit WHEN NEW.action='member_mail_send' BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();const second=randomUUID();assert.equal((await(await h.send({mutation_id:second})).json()).data.outcome,'ambiguous');assert.equal(h.relay.sent.length,1);assert.equal((await(await h.send({mutation_id:second})).json()).data.outcome,'ambiguous');assert.equal(h.relay.sent.length,1);
 }finally{h.close();}
});
test('per-admin/site rolling quota is atomic across concurrency and all failed reservations count',async()=>{
 const h=await fixture();try{
 await h.lookup();h.relay.setQuota(80);const responses=await Promise.all(Array.from({length:6},()=>h.send()));assert.equal(responses.filter(r=>r.status===200).length,3);assert.equal(responses.filter(r=>r.status===429).length,3);assert.equal(h.relay.sent.length,0);
 for(let i=0;i<3;i++){const a=await h.identity('admin');await h.lookup(a);for(let j=0;j<3;j++)await h.send({},a);}
 assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM admin_member_mail_requests').first()).n,10);
 const a=await h.identity('super_admin');await h.lookup(a);assert.equal((await h.send({},a)).status,429);
 }finally{h.close();}
});
test('quota configuration only lowers ceilings, missing relay settings fail before reservation',async()=>{
 for(const value of [0,4,-1,'x',1.5])assert.throws(()=>contactLimits({ADMIN_MAIL_ADMIN_LIMIT:value}));assert.deepEqual(contactLimits({ADMIN_MAIL_ADMIN_LIMIT:'1',ADMIN_MAIL_SITE_LIMIT:'2'}),{admin:1,site:2});
 const h=await fixture();try{await h.lookup();delete h.env.ADMIN_MAIL_RELAY_SECRET;assert.equal((await h.send()).status,503);assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM admin_member_mail_requests').first()).n,0);}finally{h.close();}
});
test('lookup audit failure prevents private reveal; actor revoked at reservation never delivers',async()=>{
 const h=await fixture();try{
 await h.db.prepare("CREATE TRIGGER synthetic_contact_lookup_failure BEFORE INSERT ON admin_member_contact_audit BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();const r=await h.lookup();assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/member@example/);await h.db.prepare('DROP TRIGGER synthetic_contact_lookup_failure').run();await h.lookup();
 const prepare=h.db.prepare.bind(h.db);let invalidated=false;h.db.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('INSERT INTO admin_member_mail_requests')){const bind=s.bind;s.bind=(...v)=>{const bound=bind(...v),run=bound.run.bind(bound);bound.run=async()=>{if(!invalidated){invalidated=true;await prepare('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?').bind(h.admin.memberId).run();}return run();};return bound;};}return s;};
 assert.equal((await h.send()).status,403);assert.equal(h.relay.sent.length,0);assert.equal((await prepare('SELECT COUNT(*) n FROM admin_member_mail_requests').first()).n,0);
 }finally{h.close();}
});
test('real Miniflare lookup decrypts identity and send uses isolated relay with immutable audit',async()=>{
 const relay=fakeAdminRelay(),r=await localAdminRuntime({submissionsEnabled:false,adminMailService:async request=>relay.fetch(request.url,{body:await request.text()})});
 try{
 // Configure this disposable workerd only. No cloud resource or real relay.
 await r.local.setAuthConfig({ADMIN_MAIL_RELAY_URL:url,ADMIN_MAIL_RELAY_SECRET:relay.secret});
 const h={db:r.local.db,env:r.local.authConfig},admin=await r.identity({role:'admin'}),member=await r.identity();await seedIdentity(h,member);const fan=(await h.db.prepare('SELECT player_id FROM members WHERE member_id=?').bind(member.memberId).first()).player_id;
 const lookup=await r.local.fetch('/api/admin/member-lookup','POST',{fan_id:fan},admin.headers);assert.equal(lookup.status,200,await lookup.clone().text());const target=(await lookup.json()).data.member;assert.equal(target.emails[0].email,'member@example.invalid');
 for(const role of ['reviewer',undefined]){const actor=await r.identity({role});assert.equal((await r.local.fetch('/api/admin/member-lookup','POST',{fan_id:fan},actor.headers)).status,403);}
 const body={member_id:member.memberId,subject:'Workerd',body:'純文字測試',mutation_id:randomUUID()};const sent=await r.local.fetch('/api/admin/member-mail/send','POST',body,admin.headers);assert.equal(sent.status,200,await sent.clone().text());assert.equal((await sent.json()).data.outcome,'sent');assert.equal(relay.sent.length,1);assert.equal((await r.local.fetch('/api/admin/member-mail/send','POST',body,admin.headers)).status,200);assert.equal(relay.sent.length,1);
 assert.equal((await h.db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);assert.deepEqual((await h.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal(r.local.unexpectedUpstreams.length,0);
 }finally{await r.local.runtime.dispose();}
});
