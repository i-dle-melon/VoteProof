import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
import {emailHash} from '../src/lib/auth-identity.js';
let h,owner,admin,reviewer;
const call=(method='GET',body,actor=owner)=>h.fetch('/api/admin/staff',method,body,actor?.headers);
const data=async(r,status=200)=>{const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j.data;};
async function google(email,connected=true){const member=await h.identity();await h.db.prepare(`INSERT INTO auth_identities(provider,provider_subject,member_id,email_lookup_hash,email_ciphertext,email_iv,email_key_version,created_at,google_identity_id)
 VALUES('supabase',?,?,?,'00','000000000000000000000000',1,?,?)`).bind(randomUUID(),member.memberId,await emailHash(h.env,email),Math.floor(Date.now()/1000),connected?randomUUID():null).run();return member;}
before(async()=>{h=await embeddedCaseRuntime();owner=await h.identity('super_admin');admin=await h.identity('admin');reviewer=await h.identity('reviewer');});
after(()=>h?.close());
test('only existing sole super admin may list or grant; CSRF, MFA and direct forged roles cannot bypass',async()=>{
 for(const actor of [undefined,await h.identity(),admin,reviewer])for(const method of ['GET','POST']){const r=await h.fetch('/api/admin/staff',method,method==='POST'?{email:'someone@example.com',role:'admin'}:undefined,actor?.headers);assert.ok([401,403].includes(r.status));}
 const headers={...owner.headers};delete headers['X-CSRF-Token'];assert.equal((await h.fetch('/api/admin/staff','POST',{email:'someone@example.com',role:'admin'},headers)).status,403);
 for(const role of ['super_admin','owner','reviewer OR 1=1'])assert.equal((await call('POST',{email:'someone@example.com',role})).status,400);
 const session=await h.db.prepare('SELECT * FROM auth_sessions WHERE member_id=?').bind(owner.memberId).first();await h.db.prepare('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?').bind(owner.memberId).run();assert.equal((await call()).status,403);await h.db.prepare('UPDATE auth_sessions SET elevated_until=? WHERE member_id=?').bind(session.elevated_until,owner.memberId).run();
});
test('verified Google existing member only; unregistered or password-only identity cannot be claimed',async()=>{
 await google('password-only@example.com',false);
 for(const email of ['unknown@example.com','password-only@example.com']){const r=await call('POST',{email,role:'admin'});assert.equal(r.status,404);assert.equal((await r.json()).error.code,'STAFF_GOOGLE_MEMBER_REQUIRED');}
});
test('Google email normalization grants Admin, records audit without email and preserves sole owner',async()=>{
 const target=await google('new-admin@example.com'),before=await h.db.prepare("SELECT * FROM admin_memberships WHERE role='super_admin'").first();
 const granted=await data(await call('POST',{email:' New-Admin@EXAMPLE.COM ',role:'admin'}),201);assert.equal(granted.membership.role,'admin');
 assert.equal((await h.db.prepare('SELECT role FROM admin_memberships WHERE member_id=?').bind(target.memberId).first()).role,'admin');
 assert.equal((await data(await call('POST',{email:'new-admin@example.com',role:'admin'}))).outcome,'already_granted');
 const audit=await h.db.prepare("SELECT * FROM admin_audit_logs WHERE target_type='admin_membership' ORDER BY rowid DESC LIMIT 1").first();assert.equal(audit.action,'bootstrap_membership');assert.doesNotMatch(JSON.stringify(audit),/new-admin@example.com|email_lookup_hash|google_identity_id/);
 assert.deepEqual(await h.db.prepare("SELECT * FROM admin_memberships WHERE role='super_admin'").first(),before);assert.equal((await call('POST',{email:'new-admin@example.com',role:'reviewer'})).status,409);
});
test('Reviewer can be promoted to Admin, with concurrent grants creating exactly one membership',async()=>{
 const target=await google('new-reviewer@example.com');const results=await Promise.all([call('POST',{email:'new-reviewer@example.com',role:'reviewer'}),call('POST',{email:'new-reviewer@example.com',role:'reviewer'})]);assert.ok(results.every(r=>[200,201,409].includes(r.status)));
 assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM admin_memberships WHERE member_id=?').bind(target.memberId).first()).n,1);
 assert.equal((await data(await call('POST',{email:'new-reviewer@example.com',role:'admin'}))).membership.role,'admin');
 const list=await data(await call());assert.ok(list.memberships.every(r=>Object.keys(r).every(k=>['nickname','fan_id','role','status'].includes(k))));
});
test('reviewer export reads/query/snapshot allowed while management remains denied',async()=>{
 const filters={campaign_id:null,entire_campaign:false,from:'2026-10-01T00:00',to:'2026-10-02T00:00',statuses:['pending'],vote_types:['Solo'],sources:['member']};
 assert.equal((await h.fetch('/api/admin/image-exports','GET',undefined,reviewer.headers)).status,200);
 assert.equal((await h.fetch('/api/admin/image-exports/query','POST',filters,reviewer.headers)).status,200);
 const job=await data(await h.fetch('/api/admin/image-exports/jobs','POST',{job_id:randomUUID(),filters},reviewer.headers));assert.equal(job.owner_member_id,undefined);
 for(const path of ['/api/admin/leaderboards','/api/admin/submissions','/api/admin/backups','/api/admin/staff'])assert.equal((await h.fetch(path,'GET',undefined,reviewer.headers)).status,403);
});
