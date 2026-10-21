import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {URI} from 'otpauth';
import {unstable_splitSqlQuery} from 'wrangler';
import {localCaseRuntime,guestBody} from '../scripts/lib/local-case-runtime.mjs';
import {googleMember,googleProof} from '../scripts/lib/local-google-runtime.mjs';
import {login,loginHeaders,responseCookie} from '../scripts/lib/local-auth-runtime.mjs';
import {SESSION_COOKIE,LOGIN_COOKIE} from '../src/lib/auth-session.js';
let local;
before(async()=>{local=await localCaseRuntime({workerEntry:new URL('../scripts/lib/google-mfa-meter-worker.mjs',import.meta.url)});await local.setAuthConfig({GOOGLE_LOGIN_MFA_ENROLLMENT_ENABLED:'true'});});
after(async()=>{await local?.runtime.dispose();});
const post=(path,body,headers=loginHeaders())=>local.fetch('/api/auth/'+path,'POST',body,headers);
const bodyOf=async response=>(await response.json()).data;
const sessionFrom=async(response,old)=>{assert.equal(response.status,200);const data=await bodyOf(response),cookie=responseCookie(response,SESSION_COOKIE);return {...old,...data,cookie,response,headers:{...loginHeaders(),Cookie:cookie,'X-CSRF-Token':data.csrf_token}};};
async function enrolled(){
 const m=await googleMember(local),r=await post('google/totp/enroll/start',{confirmed:true},m.headers),d=await bodyOf(r);
 assert.equal(r.status,202);const otp=URI.parse(d.otpauth_uri);
 const verify=await post('google/totp/enroll/verify',{transaction_id:d.transaction_id,code:otp.generate()},{...m.headers,Cookie:m.cookie+'; '+responseCookie(r,LOGIN_COOKIE)});
 assert.equal(verify.status,200);return {...m,otp,codes:(await bodyOf(verify)).recovery_codes};
}
// Test-clock preparation only. Real requests still execute replay guards; each
// replay/concurrency assertion reuses the same code without resetting this row.
async function code(m){await local.db.prepare('UPDATE member_credentials SET last_used_time_step=0 WHERE member_id=?').bind(m.member.member_id).run();return m.otp.generate();}
const policyProof=(m,action)=>googleProof(local,m.email,m,'security',{mfaPolicyAction:action});
async function change(m,enabled,extra={}){const p=await policyProof(m,enabled?'enable':'disable');return post('google/mfa/'+(enabled?'enable':'disable'),{transaction_id:p.result.transaction_id,code:await code(m),...(enabled?{recovery_confirmed:true}:{}),...extra},p.headers);}
async function enabled(){const m=await enrolled();return sessionFrom(await change(m,true),m);}
async function challenge(m,remember=false){const p=await googleProof(local,m.email);const r=await post('google/confirm',{transaction_id:p.result.transaction_id,confirmed:true,remember_me:remember},p.headers);assert.equal(r.status,202);assert.equal((await bodyOf(r)).status,'GOOGLE_MFA_REQUIRED');assert.ok(!(r.headers.get('set-cookie')??'').includes(SESSION_COOKIE+'='));return p;}
const sessionCount=async m=>(await local.db.prepare('SELECT count(*) n FROM auth_sessions WHERE member_id=?').bind(m.member.member_id).first()).n;

test('default Google MFA is off; Authenticator enrollment alone does not enable it',async()=>{
 const m=await enrolled(),security=await bodyOf(await local.fetch('/api/auth/login-security','GET',undefined,m.headers));
 assert.deepEqual(security.google.mfa,{enabled:false,generation:0,available:true});
 const p=await googleProof(local,m.email),r=await post('google/confirm',{transaction_id:p.result.transaction_id,confirmed:true},p.headers);
 assert.equal(r.status,200);assert.equal((await bodyOf(r)).member.member_id,m.member.member_id);
});

test('policy enable needs explicit fresh Google OAuth, CSRF, TOTP and recovery acknowledgement',async()=>{
 const m=await enrolled();assert.equal((await post('google/mfa/enable',{transaction_id:randomUUID(),code:await code(m),recovery_confirmed:true},m.headers)).status,400);
 const p=await policyProof(m,'enable'),body={transaction_id:p.result.transaction_id,code:await code(m),recovery_confirmed:true};
 assert.equal((await post('google/mfa/enable',body,{...p.headers,Origin:'https://other.invalid'})).status,403);
 assert.equal((await post('google/mfa/enable',body,{...p.headers,'X-CSRF-Token':'invalid'})).status,403);
 assert.equal((await post('google/mfa/enable',{...body,recovery_confirmed:false},p.headers)).status,400);
 const response=await post('google/mfa/enable',body,p.headers);assert.equal(response.status,200);
 assert.equal((await local.db.prepare('SELECT enabled FROM google_login_mfa WHERE member_id=?').bind(m.member.member_id).first()).enabled,1);
 assert.equal((await local.fetch('/api/auth/me','GET',undefined,m.headers)).status,401);
 const rotated=await sessionFrom(response,m),row=await local.db.prepare('SELECT * FROM auth_sessions WHERE member_id=? AND revoked_at IS NULL').bind(m.member.member_id).first();
 assert.equal(row.elevated_until,0);assert.equal(row.reauthenticated_until,0);assert.equal(row.expires_at,(await local.db.prepare('SELECT expires_at FROM auth_sessions WHERE member_id=? ORDER BY created_at LIMIT 1').bind(m.member.member_id).first()).expires_at);
 assert.equal((await local.fetch('/api/auth/me','GET',undefined,rotated.headers)).status,200);
});

test('Google MFA challenges issue no session, reject wrong/expired/cross-browser proof, then verify once',async()=>{
 const m=await enabled(),p=await challenge(m),before=await sessionCount(m);
 assert.equal((await local.fetch('/api/me/cases','GET',undefined,p.headers)).status,401);
 assert.equal((await post('google/mfa/verify',{transaction_id:p.result.transaction_id,code:'wrong'},p.headers)).status,400);
 assert.equal((await post('google/mfa/verify',{transaction_id:p.result.transaction_id,code:m.otp.generate({timestamp:Date.now()-120000})},p.headers)).status,400);
 assert.equal((await post('google/mfa/verify',{transaction_id:p.result.transaction_id,code:await code(m)},loginHeaders())).status,400);
 assert.equal(await sessionCount(m),before);
 const r=await post('google/mfa/verify',{transaction_id:p.result.transaction_id,code:await code(m)},p.headers);assert.equal(r.status,200);
 assert.equal((await post('google/mfa/verify',{transaction_id:p.result.transaction_id,code:m.otp.generate()},p.headers)).status,400);
 const s=await sessionFrom(r,m),row=await local.db.prepare('SELECT * FROM auth_sessions WHERE member_id=? AND token_hash NOT IN(SELECT token_hash FROM auth_sessions WHERE revoked_at IS NOT NULL) ORDER BY google_mfa_generation DESC,created_at DESC').bind(m.member.member_id).first();
 assert.equal(row.google_mfa_verified,1);assert.equal(row.elevated_until,0);assert.equal((await local.fetch('/api/auth/me','GET',undefined,s.headers)).status,200);
});

test('Google MFA expired transaction cannot create a session',async()=>{
 const m=await enabled(),p=await challenge(m),count=await sessionCount(m);
 await local.db.prepare('UPDATE auth_transactions SET created_at=1,expires_at=2 WHERE id=?').bind(p.result.transaction_id).run();
 assert.equal((await post('google/mfa/verify',{transaction_id:p.result.transaction_id,code:await code(m)},p.headers)).status,400);assert.equal(await sessionCount(m),count);
});

test('two concurrent TOTP completions and a code replay across transactions create only one session',async()=>{
 const m=await enabled(),a=await challenge(m),b=await challenge(m),token=await code(m),before=await sessionCount(m);
 const results=await Promise.all([a,b].map(p=>post('google/mfa/verify',{transaction_id:p.result.transaction_id,code:token},p.headers)));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);assert.equal(await sessionCount(m),before+1);
});

test('recovery is Google-bound, one-use and atomic under concurrent login without admin elevation',async()=>{
 const m=await enabled(),a=await challenge(m),b=await challenge(m),before=await sessionCount(m);
 const results=await Promise.all([a,b].map(p=>post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0]},p.headers)));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);assert.equal(await sessionCount(m),before+1);
 assert.equal((await local.db.prepare('SELECT count(*) n FROM recovery_codes WHERE member_id=? AND used_at IS NOT NULL').bind(m.member.member_id).first()).n,1);
 const row=await local.db.prepare('SELECT max(elevated_until) n FROM auth_sessions WHERE member_id=?').bind(m.member.member_id).first();assert.equal(row.n,0);
});

for(const remaining of [10,1])test(`any unused recovery code can explicitly disable Google MFA with ${remaining} codes remaining`,async()=>{
 const m=await enabled(),previous=await challenge(m);
 const other=await sessionFrom(await post('google/mfa/verify',{transaction_id:previous.result.transaction_id,code:await code(m)},previous.headers),m);
 const p=await challenge(m),credentialsBefore=await local.db.prepare('SELECT * FROM member_credentials WHERE member_id=?').bind(m.member.member_id).first();
 if(remaining===1){
  const {recoveryHash}=await import('../src/lib/auth-crypto.js'),hash=await recoveryHash(m.member.member_id,m.codes[0]);
  await local.db.prepare('UPDATE recovery_codes SET used_at=CASE WHEN code_hash=? THEN NULL ELSE 1 END WHERE member_id=?').bind(hash,m.member.member_id).run();
 }
 assert.equal((await local.db.prepare('SELECT count(*) n FROM recovery_codes WHERE member_id=? AND used_at IS NULL').bind(m.member.member_id).first()).n,remaining);
 const r=await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0],disable_mfa:true,confirmed:true},p.headers);assert.equal(r.status,200);
 const policy=await local.db.prepare('SELECT enabled,generation FROM google_login_mfa WHERE member_id=?').bind(m.member.member_id).first();assert.deepEqual(policy,{enabled:0,generation:2});
 assert.equal((await local.db.prepare('SELECT count(*) n FROM recovery_codes WHERE member_id=? AND used_at IS NULL').bind(m.member.member_id).first()).n,remaining-1);
 assert.equal((await local.fetch('/api/auth/me','GET',undefined,m.headers)).status,401);
 assert.equal((await local.fetch('/api/auth/me','GET',undefined,other.headers)).status,401);
 const current=await sessionFrom(r,m);assert.equal((await local.fetch('/api/auth/me','GET',undefined,current.headers)).status,200);
 assert.equal((await local.db.prepare("SELECT count(*) n FROM auth_sessions WHERE member_id=? AND auth_method='google' AND revoked_at IS NULL").bind(m.member.member_id).first()).n,1);
 assert.deepEqual(await local.db.prepare('SELECT * FROM member_credentials WHERE member_id=?').bind(m.member.member_id).first(),credentialsBefore);
 assert.equal((await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0],disable_mfa:true,confirmed:true},p.headers)).status,400);
});

test('recovery disable requires both literal true confirmations and rejects invalid intent without consuming proof',async()=>{
 const m=await enabled(),p=await challenge(m),before=await sessionCount(m);
 const transaction=await local.db.prepare('SELECT * FROM auth_transactions WHERE id=?').bind(p.result.transaction_id).first();
 for(const flags of [
  {disable_mfa:true},{disable_mfa:true,confirmed:false},{disable_mfa:true,confirmed:'true'},
  {disable_mfa:true,confirmed:1},{disable_mfa:false,confirmed:true},
  {disable_mfa:'true',confirmed:true},{disable_mfa:1,confirmed:true},{confirmed:true},
 ])assert.equal((await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0],...flags},p.headers)).status,400);
 assert.equal(await sessionCount(m),before);
 assert.deepEqual(await local.db.prepare('SELECT enabled,generation FROM google_login_mfa WHERE member_id=?').bind(m.member.member_id).first(),{enabled:1,generation:1});
 assert.equal((await local.db.prepare('SELECT count(*) n FROM recovery_codes WHERE member_id=? AND used_at IS NOT NULL').bind(m.member.member_id).first()).n,0);
 assert.deepEqual(await local.db.prepare('SELECT * FROM auth_transactions WHERE id=?').bind(p.result.transaction_id).first(),transaction);
 assert.equal((await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0],disable_mfa:true,confirmed:true},p.headers)).status,200);
});

for(const differentCodes of [false,true])test(`concurrent recovery disable with ${differentCodes?'different codes':'the same code'} commits exactly once`,async()=>{
 const m=await enabled(),a=await challenge(m),b=await challenge(m),before=await sessionCount(m);
 const results=await Promise.all([a,b].map((p,i)=>post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[differentCodes?i:0],disable_mfa:true,confirmed:true},p.headers)));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);assert.equal(await sessionCount(m),before+1);
 assert.deepEqual(await local.db.prepare('SELECT enabled,generation FROM google_login_mfa WHERE member_id=?').bind(m.member.member_id).first(),{enabled:0,generation:2});
 assert.equal((await local.db.prepare('SELECT count(*) n FROM recovery_codes WHERE member_id=? AND used_at IS NOT NULL').bind(m.member.member_id).first()).n,1);
 assert.equal((await local.db.prepare("SELECT count(*) n FROM google_login_mfa_events WHERE member_id=? AND action='disable'").bind(m.member.member_id).first()).n,1);
 assert.equal((await local.db.prepare("SELECT count(*) n FROM auth_sessions WHERE member_id=? AND auth_method='google' AND revoked_at IS NULL").bind(m.member.member_id).first()).n,1);
});

test('recovery disable never elevates reviewer, admin or super_admin sessions or changes their roles',async()=>{
 for(const role of ['reviewer','admin','super_admin']){
  const m=await enabled(),now=new Date().toISOString(),id=randomUUID();
  await local.db.prepare("INSERT INTO admin_memberships(id,member_id,role,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").bind(id,m.member.member_id,role,now,now).run();
  const p=await challenge(m),s=await sessionFrom(await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0],disable_mfa:true,confirmed:true},p.headers),m);
  assert.equal((await local.fetch('/api/admin/me','GET',undefined,s.headers)).status,403);
  const sessions=await local.db.prepare('SELECT elevated_until,reauthenticated_until FROM auth_sessions WHERE member_id=? AND revoked_at IS NULL').bind(m.member.member_id).all();
  assert.equal(sessions.results.length,1);assert.deepEqual(sessions.results[0],{elevated_until:0,reauthenticated_until:0});
  assert.deepEqual(await local.db.prepare('SELECT role,status FROM admin_memberships WHERE id=?').bind(id).first(),{role,status:'active'});
 }
});

test('failed recovery disable rolls back policy, session revocation, code consumption and audit together',async()=>{
 const m=await enabled(),p=await challenge(m),before=await sessionCount(m);
 await local.db.prepare("CREATE TRIGGER fixture_disable_failure BEFORE INSERT ON google_login_mfa_events WHEN NEW.action='login_recovery' BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
 try{assert.equal((await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0],disable_mfa:true,confirmed:true},p.headers)).status,503);}finally{await local.db.prepare('DROP TRIGGER fixture_disable_failure').run();}
 assert.equal(await sessionCount(m),before);assert.equal((await local.fetch('/api/auth/me','GET',undefined,m.headers)).status,200);
 assert.deepEqual(await local.db.prepare('SELECT enabled,generation FROM google_login_mfa WHERE member_id=?').bind(m.member.member_id).first(),{enabled:1,generation:1});
 assert.equal((await local.db.prepare('SELECT count(*) n FROM recovery_codes WHERE member_id=? AND used_at IS NOT NULL').bind(m.member.member_id).first()).n,0);
 assert.equal((await local.db.prepare("SELECT count(*) n FROM google_login_mfa_events WHERE member_id=? AND action='disable'").bind(m.member.member_id).first()).n,0);
 assert.equal((await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0],disable_mfa:true,confirmed:true},p.headers)).status,200);
});

test('D1/audit failure rolls back factor consumption and session issuance; explicit retry can succeed',async()=>{
 const m=await enabled(),p=await challenge(m),before=await sessionCount(m),token=await code(m);
 await local.db.prepare("CREATE TRIGGER fixture_mfa_failure BEFORE INSERT ON google_login_mfa_events WHEN NEW.action='login_recovery' BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
 try{assert.equal((await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0]},p.headers)).status,503);}finally{await local.db.prepare('DROP TRIGGER fixture_mfa_failure').run();}
 assert.equal(await sessionCount(m),before);assert.equal((await local.db.prepare('SELECT used_at FROM recovery_codes WHERE member_id=? LIMIT 1').bind(m.member.member_id).first()).used_at,null);
 assert.equal((await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0]},p.headers)).status,200);
});

test('policy enable racing an OAuth-only login leaves no active unverified Google session',async()=>{
 const m=await enrolled(),p=await googleProof(local,m.email),q=await policyProof(m,'enable'),token=await code(m);
 const results=await Promise.all([post('google/confirm',{transaction_id:p.result.transaction_id,confirmed:true},p.headers),post('google/mfa/enable',{transaction_id:q.result.transaction_id,code:token,recovery_confirmed:true},q.headers)]);
 assert.equal(results[1].status,200);
 assert.equal((await local.db.prepare("SELECT count(*) n FROM auth_sessions WHERE member_id=? AND auth_method='google' AND revoked_at IS NULL AND google_mfa_verified=0").bind(m.member.member_id).first()).n,0);
});

test('policy disable racing MFA login rejects or revokes the old generation and preserves Authenticator',async()=>{
 const m=await enabled(),p=await challenge(m),q=await policyProof(m,'disable'),token=await code(m);
 const results=await Promise.all([post('google/mfa/verify',{transaction_id:p.result.transaction_id,code:token},p.headers),post('google/mfa/disable',{transaction_id:q.result.transaction_id,recovery_code:m.codes[0]},q.headers)]);
 assert.equal(results[1].status,200);
 assert.equal((await local.db.prepare("SELECT count(*) n FROM auth_sessions WHERE member_id=? AND auth_method='google' AND revoked_at IS NULL AND google_mfa_generation=1").bind(m.member.member_id).first()).n,0);
 assert.ok(await local.db.prepare('SELECT member_id FROM member_credentials WHERE member_id=?').bind(m.member.member_id).first());
});

test('database downgrade gate prevents old Worker Google session inserts while enabled',async()=>{
 const m=await enabled(),now=Math.floor(Date.now()/1000);
 await assert.rejects(local.db.prepare("INSERT INTO auth_sessions(token_hash,member_id,created_at,expires_at,auth_method) VALUES(?,?,?,?,'google')").bind(randomBytes(32).toString('hex'),m.member.member_id,now,now+100).run(),/GOOGLE_LOGIN_MFA_REQUIRED/);
 await assert.rejects(local.db.prepare('DELETE FROM google_login_mfa WHERE member_id=?').bind(m.member.member_id).run());
 await assert.rejects(local.db.prepare('UPDATE google_login_mfa SET generation=generation+2 WHERE member_id=?').bind(m.member.member_id).run());
 await assert.rejects(local.db.prepare('DELETE FROM google_login_mfa_events WHERE member_id=?').bind(m.member.member_id).run());
});

test('policy OAuth proof cannot be reused as administrative step-up and concurrent enable commits once',async()=>{
 const m=await enrolled(),a=await policyProof(m,'enable'),b=await policyProof(m,'enable'),token=await code(m);
 assert.equal((await post('google/step-up',{transaction_id:a.result.transaction_id,code:token},a.headers)).status,400);
 const results=await Promise.all([a,b].map(p=>post('google/mfa/enable',{transaction_id:p.result.transaction_id,code:token,recovery_confirmed:true},p.headers)));
 assert.equal(results.filter(r=>r.status===200).length,1);
 assert.equal((await local.db.prepare("SELECT count(*) n FROM google_login_mfa_events WHERE member_id=? AND action='enable'").bind(m.member.member_id).first()).n,1);
});

test('Authenticator reset keeps Google MFA enabled and invalidates old factors and sessions',async()=>{
 const m=await enabled(),pending=await challenge(m),step=await googleProof(local,m.email,m,'security');
 assert.equal((await post('google/step-up',{transaction_id:step.result.transaction_id,code:await code(m)},step.headers)).status,200);
 const reset=await post('totp/reset/start',{},m.headers);assert.equal(reset.status,202);const setup=await bodyOf(reset),otp=URI.parse(setup.otpauth_uri);
 const headers={...m.headers,Cookie:m.cookie+'; '+responseCookie(reset,LOGIN_COOKIE)};
 assert.equal((await post('totp/reset/verify',{transaction_id:setup.transaction_id,code:otp.generate()},headers)).status,200);
 assert.equal((await local.fetch('/api/auth/me','GET',undefined,m.headers)).status,401);
 assert.equal((await local.db.prepare('SELECT enabled FROM google_login_mfa WHERE member_id=?').bind(m.member.member_id).first()).enabled,1);
 assert.equal((await post('google/mfa/recovery',{transaction_id:pending.result.transaction_id,recovery_code:m.codes[0]},pending.headers)).status,400);
 const next=await challenge(m);assert.equal((await post('google/mfa/verify',{transaction_id:next.result.transaction_id,code:await code({...m,otp})},next.headers)).status,200);
});

test('new policy flow enrolls Authenticator without enabling, then requires saved recovery codes and fresh TOTP',async()=>{
 const m=await googleMember(local),p=await policyProof(m,'enable');assert.equal(p.result.authenticator_configured,false);
 const s=await post('google/mfa/enroll/start',{transaction_id:p.result.transaction_id},p.headers);assert.equal(s.status,200);const otp=URI.parse((await bodyOf(s)).otpauth_uri);
 const r=await post('google/mfa/enroll/verify',{transaction_id:p.result.transaction_id,code:otp.generate()},p.headers);assert.equal(r.status,200);
 assert.equal((await bodyOf(r)).google_mfa_enabled,false);assert.equal(await local.db.prepare('SELECT * FROM google_login_mfa WHERE member_id=?').bind(m.member.member_id).first(),null);
 assert.equal((await post('google/mfa/enable',{transaction_id:p.result.transaction_id,code:otp.generate(),recovery_confirmed:true},p.headers)).status,400);
 assert.equal((await post('google/mfa/enable',{transaction_id:p.result.transaction_id,code:otp.generate({timestamp:Date.now()+30000}),recovery_confirmed:true},p.headers)).status,200);
});

test('new MFA login preserves 7/30-day durations and cannot bypass using password or Google step-up routes',async()=>{
 for(const remember of [false,true]){
  const m=await enabled(),p=await challenge(m,remember),r=await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0]},p.headers);
  assert.equal(r.status,200);assert.equal((await bodyOf(r)).expires_in,(remember?30:7)*86400);
 }
 const m=await enabled(),p=await challenge(m);
 assert.equal((await post('google/step-up',{transaction_id:p.result.transaction_id,code:await code(m)},p.headers)).status,400);
 const recovery=await post('recovery/password/start',{email:m.email,recovery_code:m.codes[0]});const d=await bodyOf(recovery);
 assert.equal((await post('recovery/password/finish',{transaction_id:d.transaction_id,new_password:randomBytes(24).toString('base64url')},{...loginHeaders(),Cookie:responseCookie(recovery,LOGIN_COOKIE)})).status,400);
});

test('opt-in feature flag defaults off but never disables enforcement or recovery for existing policy',async()=>{
 const m=await enabled();await local.setAuthConfig({GOOGLE_LOGIN_MFA_ENROLLMENT_ENABLED:undefined});
 try{
  assert.equal((await post('google/start',{purpose:'security',confirmed:true,mfa_policy_action:'enable'},m.headers)).status,503);
  const p=await challenge(m);assert.equal((await post('google/mfa/recovery',{transaction_id:p.result.transaction_id,recovery_code:m.codes[0]},p.headers)).status,200);
 }finally{await local.setAuthConfig({GOOGLE_LOGIN_MFA_ENROLLMENT_ENABLED:'true'});}
});

test('password sessions and 30-day trusted devices survive Google policy changes',async()=>{
 const password=await login(local),p=await googleProof(local,password.email);
 const linked=await sessionFrom(await post('google/confirm',{transaction_id:p.result.transaction_id,confirmed:true},p.headers),password);
 const original=await local.db.prepare('SELECT * FROM trusted_devices WHERE member_id=?').bind(password.member.member_id).first();
 const r=await local.fetch('/api/auth/login','POST',{email:password.email,password:password.password},{...loginHeaders(),Cookie:password.deviceCookie});
 const current=await sessionFrom(r,password),q=await policyProof(current,'enable');
 const enable=await post('google/mfa/enable',{transaction_id:q.result.transaction_id,code:await code(password),recovery_confirmed:true},q.headers);
 assert.equal(enable.status,200);assert.ok(!(enable.headers.get('set-cookie')??'').includes(SESSION_COOKIE+'='));
 assert.equal((await local.fetch('/api/auth/me','GET',undefined,current.headers)).status,200);
 const device=await local.db.prepare('SELECT * FROM trusted_devices WHERE id=?').bind(original.id).first();assert.deepEqual(device,original);
 assert.equal((await local.fetch('/api/auth/login','POST',{email:password.email,password:password.password},{...loginHeaders(),Cookie:password.deviceCookie})).status,200);
});

test('reviewer/admin/super_admin Google MFA login never substitutes for explicit administrative step-up',async()=>{
 for(const role of ['reviewer','admin','super_admin']){
  const m=await enabled(),now=new Date().toISOString();
  await local.db.prepare("INSERT INTO admin_memberships(id,member_id,role,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").bind(randomUUID(),m.member.member_id,role,now,now).run();
  const p=await challenge(m),s=await sessionFrom(await post('google/mfa/verify',{transaction_id:p.result.transaction_id,code:await code(m)},p.headers),m);
  assert.equal((await local.fetch('/api/admin/me','GET',undefined,s.headers)).status,403);
  const q=await googleProof(local,s.email,s,'security');
  assert.equal((await post('google/step-up',{transaction_id:q.result.transaction_id,code:await code(m)},q.headers)).status,200);
  const actor=await local.fetch('/api/admin/me','GET',undefined,s.headers);assert.equal(actor.status,200);assert.equal((await bodyOf(actor)).role,role);
 }
});

test('local workerd D1 and wall-time measurements do not introduce policy reads on ordinary APIs',async()=>{
 const meter=(name,r,wall_ms)=>({name,status:r.status,reads:Number(r.headers.get('X-Local-D1-reads')),writes:Number(r.headers.get('X-Local-D1-writes')),trips:Number(r.headers.get('X-Local-D1-trips')),policy_reads:Number(r.headers.get('X-Local-D1-policy_reads')),wall_ms:Number(wall_ms.toFixed(2)),worker_cpu_ms:'UNMEASURED'});
 const m=await enrolled(),p=await googleProof(local,m.email),metrics=[];
 for(const[name,response,wall]of [['start',p.start,p.measurements.start_ms],['callback',p.callback,p.measurements.callback_ms],['result',p.resultResponse,p.measurements.result_ms]])metrics.push(meter('MFA_OFF_'+name,response,wall));
 let start=performance.now(),r=await post('google/confirm',{transaction_id:p.result.transaction_id,confirmed:true},p.headers);metrics.push(meter('MFA_OFF_confirm',r,performance.now()-start));assert.equal(r.status,200);
 const s=await sessionFrom(await change(m,true),m),q=await googleProof(local,m.email);
 for(const[name,response,wall]of [['start',q.start,q.measurements.start_ms],['callback',q.callback,q.measurements.callback_ms],['result',q.resultResponse,q.measurements.result_ms]])metrics.push(meter('MFA_ON_'+name,response,wall));
 start=performance.now();r=await post('google/confirm',{transaction_id:q.result.transaction_id,confirmed:true},q.headers);metrics.push(meter('MFA_ON_challenge',r,performance.now()-start));assert.equal(r.status,202);
 const token=await code(m);start=performance.now();r=await post('google/mfa/verify',{transaction_id:q.result.transaction_id,code:token},q.headers);metrics.push(meter('MFA_ON_verify',r,performance.now()-start));assert.equal(r.status,200);
 const logged=await sessionFrom(r,m);
 for(const path of ['/api/auth/me','/api/me/cases','/api/submissions/status','/api/leaderboards']){
  start=performance.now();const read=await local.fetch(path,'GET',undefined,logged.headers),item=meter(path,read,performance.now()-start);metrics.push(item);assert.equal(item.policy_reads,0);assert.equal(read.status,200);
 }
 const bytes=new Uint8Array([1,2,3]);start=performance.now();
 const prepare=await local.fetch('/api/uploads/prepare','POST',{turnstile_token:randomBytes(24).toString('hex'),files:[{name:'local.png',type:'image/png',size:3,algorithm:'sha256',sha256:createHash('sha256').update(bytes).digest('hex')}]},logged.headers);
 assert.equal(prepare.status,200);metrics.push(meter('upload_prepare',prepare,performance.now()-start));const data=await bodyOf(prepare);
 start=performance.now();const put=await local.put(data.uploads[0],bytes);metrics.push(meter('image_PUT',put,performance.now()-start));
 const ref={session_id:data.session_id,keys:data.uploads.map(file=>file.key)};
 start=performance.now();const complete=await local.fetch('/api/uploads/complete','POST',ref,logged.headers);assert.equal(complete.status,200);metrics.push(meter('upload_complete',complete,performance.now()-start));
 start=performance.now();const submitted=await local.fetch('/api/cases','POST',guestBody(ref),{...logged.headers,'Idempotency-Key':randomUUID()});assert.equal(submitted.status,201);metrics.push(meter('case_create',submitted,performance.now()-start));
 for(const metric of metrics.filter(m=>['upload_prepare','image_PUT','upload_complete','case_create'].includes(m.name)))assert.equal(metric.policy_reads,0);
 console.log('GOOGLE_MFA_LOCAL_MEASUREMENTS '+JSON.stringify(metrics));
});

test('0028 is additive for pending transactions and old sessions; missing migration blocks Google, not password login',async()=>{
 const old=await localCaseRuntime({migrationThrough:'0027_storage_inventory_phases.sql'});
 try{
  const m=await login(old),id=randomUUID(),now=Math.floor(Date.now()/1000);
  await old.db.prepare("INSERT INTO auth_transactions(id,kind,member_id,browser_hash,payload,created_at,expires_at) VALUES(?,'google',?,?,?, ?,?)").bind(id,m.member.member_id,'a'.repeat(64),'{}',now,now+300).run();
  assert.equal((await old.fetch('/api/auth/google/start','POST',{},loginHeaders())).status,503);
  assert.equal((await old.fetch('/api/auth/me','GET',undefined,m.headers)).status,200);
  const before=await old.db.prepare('SELECT count(*) n FROM auth_sessions').first();
  const migration=await readFile(new URL('../migrations/0028_google_login_mfa.sql',import.meta.url),'utf8');
  await old.db.batch(unstable_splitSqlQuery(migration).map(sql=>old.db.prepare(sql)));
  assert.equal((await old.db.prepare('SELECT consumed_at FROM auth_transactions WHERE id=?').bind(id).first()).consumed_at,null);
  assert.equal((await old.db.prepare('SELECT count(*) n FROM auth_sessions').first()).n,before.n);
  assert.equal((await old.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');assert.deepEqual((await old.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await old.runtime.dispose();}
});
