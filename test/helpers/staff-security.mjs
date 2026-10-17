import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emailHash} from '../../src/lib/auth-identity.js';
export async function verifyStaffSecurity(h){
 const owner=await h.identity('super_admin'),admin=await h.identity('admin'),reviewer=await h.identity('reviewer'),member=await h.identity();
 const call=(actor,body,method='POST',headers=actor?.headers)=>h.fetch('/api/admin/staff',method,body,headers);
 async function google(email,actor=undefined){const target=actor??await h.identity();await h.db.prepare(`INSERT INTO auth_identities(provider,provider_subject,member_id,email_lookup_hash,email_ciphertext,email_iv,email_key_version,created_at,google_identity_id) VALUES('supabase',?,?,?,'00','000000000000000000000000',1,?,?)`).bind(randomUUID(),target.memberId,await emailHash(h.env,email),Math.floor(Date.now()/1000),randomUUID()).run();return target;}
 const target=await google('staff-security@example.com'),payload={email:'staff-security@example.com',role:'reviewer'};
 for(const actor of [null,member,admin,reviewer])for(const method of ['GET','POST'])assert.equal((await call(actor,method==='POST'?payload:undefined,method)).status,actor?403:401);
 const csrf={...owner.headers};delete csrf['X-CSRF-Token'];assert.equal((await call(owner,payload,'POST',csrf)).status,403);assert.equal((await call(owner,payload,'POST',{...owner.headers,Origin:'https://evil.example'})).status,403);
 const session=await h.db.prepare('SELECT elevated_until FROM auth_sessions WHERE member_id=?').bind(owner.memberId).first();await h.db.prepare('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?').bind(owner.memberId).run();assert.equal((await call(owner,payload)).status,403);await h.db.prepare('UPDATE auth_sessions SET elevated_until=? WHERE member_id=?').bind(session.elevated_until,owner.memberId).run();
 for(const role of ['super_admin','owner'])assert.equal((await call(owner,{...payload,role})).status,400);
 assert.equal((await call(owner,{...payload,email:'unregistered@example.com'})).status,404);
 const suspended=await google('suspended-staff@example.com');await h.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(suspended.memberId).run();assert.equal((await call(owner,{...payload,email:'suspended-staff@example.com'})).status,404);assert.equal(await h.db.prepare('SELECT id FROM admin_memberships WHERE member_id=?').bind(suspended.memberId).first(),null);
 await google('owner-security@example.com',owner);const before=await h.db.prepare('SELECT * FROM admin_memberships WHERE member_id=?').bind(owner.memberId).first();assert.equal((await call(owner,{email:'owner-security@example.com',role:'admin'})).status,400);
 // There is no role-revoke/delete API in this release. Forged removal is rejected.
 assert.equal((await call(owner,{...payload,action:'revoke'})).status,400);for(const method of ['PATCH','DELETE'])assert.equal((await call(owner,payload,method)).status,405);
 assert.deepEqual(await h.db.prepare('SELECT * FROM admin_memberships WHERE member_id=?').bind(owner.memberId).first(),before);
 const created=await call(owner,payload);assert.equal(created.status,201,await created.clone().text());const updated=await call(owner,{...payload,role:'admin'});assert.equal(updated.status,200,await updated.clone().text());
 const audits=(await h.db.prepare("SELECT * FROM admin_audit_logs WHERE target_type='admin_membership'").all()).results;assert.equal(audits.length,2);assert.ok(audits.every(a=>a.action==='bootstrap_membership'));assert.doesNotMatch(JSON.stringify(audits),/staff-security@example.com|email_lookup_hash|google_identity_id/);
 assert.equal((await h.db.prepare('SELECT role FROM admin_memberships WHERE member_id=?').bind(target.memberId).first()).role,'admin');
 for(const [path,method] of [['/api/admin/staff','GET'],['/api/admin/staff','POST'],['/api/admin/campaigns','POST'],['/api/admin/leaderboards','GET'],['/api/admin/member-tiers','GET'],['/api/admin/submissions','GET'],['/api/admin/submissions/update','POST'],['/api/admin/backups','GET'],['/api/admin/backups/backfill','POST'],['/api/admin/announcements','GET'],['/api/admin/announcements','POST'],['/api/admin/campaign-assets/C','POST'],['/api/admin/audit-logs','GET'],['/api/admin/points/adjustments','POST']]){
  assert.equal((await h.fetch(path,method,method==='POST'?{}:undefined,reviewer.headers)).status,403,path);
 }
 for(const path of ['/api/admin/me','/api/admin/overview','/api/admin/cases','/api/admin/campaigns','/api/admin/solo-targets','/api/admin/image-exports'])assert.equal((await h.fetch(path,'GET',undefined,reviewer.headers)).status,200,path);
 for(const action of ['complete','revoke'])assert.equal((await h.fetch('/api/admin/cases/VP-20261016-'+ 'A'.repeat(16)+'/review','POST',{action,expected_version:0,reason:'forged'},reviewer.headers)).status,403);
 assert.equal((await h.fetch('/api/admin/members/'+member.memberId+'/points','GET',undefined,reviewer.headers)).status,403);
 const extra=await h.identity('super_admin');assert.equal((await call(owner,payload)).status,503);await h.db.prepare("UPDATE admin_memberships SET status='disabled' WHERE member_id=?").bind(extra.memberId).run();
}
