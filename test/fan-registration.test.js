import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localCaseRuntime, guestBody } from '../scripts/lib/local-case-runtime.mjs';
import { begin, finish, login, loginHeaders, responseCookie, expectError } from '../scripts/lib/local-auth-runtime.mjs';
import { googleProof } from '../scripts/lib/local-google-runtime.mjs';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../src/lib/auth-session.js';
import { profileInput } from '../src/api/auth-validation.js';
import { encryptEmail, emailHash } from '../src/lib/auth-identity.js';

let local;
before(async()=>{local=await localCaseRuntime();});
after(async()=>{await local?.runtime.dispose();});
const post=(path,body,headers)=>local.fetch('/api/auth/'+path,'POST',body,headers);
const count=async table=>(await local.db.prepare(`SELECT count(*) n FROM ${table}`).first()).n;
async function verifiedEmail(){
  const headers=loginHeaders(),email=randomUUID()+'@local.example';
  const started=await post('register/start',{email,turnstile_token:randomUUID()},headers);
  assert.equal(started.status,202);
  const verified=await post('register/verify-email',{challenge_id:(await started.json()).data.challenge_id,code:local.provider.codeFor(email)},
    {...headers,Cookie:responseCookie(started,LOGIN_COOKIE)});
  assert.equal(verified.status,202);
  return {transaction_id:(await verified.json()).data.transaction_id,headers:{...headers,Cookie:responseCookie(verified,LOGIN_COOKIE)}};
}
test('new registration profile requires nonblank Fan ID and retains existing length/control limits',()=>{
  for(const player_id of [undefined,null,'',' ','\t\n','　'])assert.throws(()=>profileInput({nickname:'葉子',...(player_id===undefined?{}:{player_id})},{requireFanId:true}),{code:'FAN_ID_REQUIRED'});
  for(const player_id of [123,'x'.repeat(101),'bad\nID'])assert.throws(()=>profileInput({nickname:'葉子',player_id},{requireFanId:true}),{code:'INVALID_AUTH_REQUEST'});
  assert.equal(profileInput({nickname:'葉子',player_id:'  fan_yeh  '},{requireFanId:true}).player_id,'fan_yeh');
  assert.deepEqual(profileInput({nickname:'歷史會員'}),{nickname:'歷史會員'}); // Profile PATCH remains partial.
});
test('password registration rejects missing/whitespace Fan ID before creating provider enrollment',async()=>{
  const tx=await verifiedEmail(),members=await count('members'),enrollments=await count('auth_enrollments');
  for(const player_id of [undefined,'','   ','　']){
    const body={transaction_id:tx.transaction_id,password:'local-safe-password-123',nickname:'葉子',...(player_id===undefined?{}:{player_id})};
    const result=await expectError(await post('register/credentials',body,tx.headers),400,'FAN_ID_REQUIRED');
    assert.equal(result.error.message,'請填寫粉絲 ID，才能完成註冊。');
  }
  assert.equal(await count('members'),members);assert.equal(await count('auth_enrollments'),enrollments);
});
test('valid password registration and existing password login work; normalized duplicates reject early',async()=>{
  const m=await login(local),again=await login(local,m);
  assert.equal(again.member.member_id,m.member.member_id);
  const tx=await verifiedEmail();
  const result=await expectError(await post('register/credentials',{transaction_id:tx.transaction_id,password:'local-safe-password-123',nickname:'別人',player_id:' '+m.member.player_id.toUpperCase()+' '},tx.headers),409,'FAN_ID_TAKEN');
  assert.equal(result.error.message,'此粉絲 ID 已被使用，請確認後重新輸入。');
});
test('concurrent password claims remain DB authoritative; established Fan ID is immutable',async()=>{
  const fan='race-'+randomUUID(),a=await begin(local,undefined,undefined,{player_id:fan}),b=await begin(local,undefined,undefined,{player_id:fan.toUpperCase()});
  const before=await count('members'),responses=await Promise.all([finish(local,a),finish(local,b)]);
  assert.equal(responses.filter(r=>r.status===200).length,1);
  await expectError(responses.find(r=>r.status!==200),409,'FAN_ID_TAKEN');
  assert.equal(await count('members'),before+1);
  const success=responses.find(r=>r.status===200),data=(await success.json()).data;
  const headers={...loginHeaders(),Cookie:responseCookie(success,SESSION_COOKIE),'X-CSRF-Token':data.csrf_token};
  await expectError(await local.fetch('/api/me/profile','PATCH',{player_id:'different-'+randomUUID()},headers),409,'FAN_ID_IMMUTABLE');
  const rename=await local.fetch('/api/me/profile','PATCH',{nickname:'可修改暱稱'},headers);
  assert.equal(rename.status,200);assert.equal((await rename.json()).data.member.player_id,data.member.player_id);
});
test('pre-update password enrollment without Fan ID cannot finalize into a member/session',async()=>{
  const setup=await begin(local),tx=await local.db.prepare('SELECT payload FROM auth_transactions WHERE id=?').bind(setup.id).first();
  const payload=JSON.parse(tx.payload);delete payload.player_id;
  await local.db.prepare('UPDATE auth_transactions SET payload=? WHERE id=?').bind(JSON.stringify(payload),setup.id).run();
  const before=await count('members'),sessions=await count('auth_sessions');
  await expectError(await finish(local,setup),400,'FAN_ID_REQUIRED');
  assert.equal(await count('members'),before);assert.equal(await count('auth_sessions'),sessions);
});
test('Google first profile requires Fan ID, rejects normalized duplicates and succeeds on retry',async()=>{
  const existing=await login(local),p=await googleProof(local),before=await count('members');
  const confirm=extra=>post('google/confirm',{transaction_id:p.result.transaction_id,confirmed:true,nickname:'葉子',...extra},p.headers);
  for(const extra of [{},{player_id:''},{player_id:' 　'}])await expectError(await confirm(extra),400,'FAN_ID_REQUIRED');
  await expectError(await confirm({player_id:existing.member.player_id.toUpperCase()}),409,'FAN_ID_TAKEN');
  assert.equal(await count('members'),before);
  const fan='google-'+randomUUID(),result=await confirm({player_id:fan});assert.equal(result.status,200);
  const member=(await result.json()).data.member;assert.equal(member.player_id,fan);assert.equal(await count('members'),before+1);
  const again=await googleProof(local,p.oauth.user.email);
  const loggedIn=await post('google/confirm',{transaction_id:again.result.transaction_id,confirmed:true},again.headers);
  assert.equal(loggedIn.status,200);assert.equal((await loggedIn.json()).data.member.member_id,member.member_id);
});
test('historical Google member without Fan ID can login and claim through existing profile completion',async()=>{
  const p=await googleProof(local),id='M-'+randomUUID(),now=new Date().toISOString(),subject=p.oauth.user.id;
  const protectedEmail=await encryptEmail(local.authConfig,p.oauth.user.email,subject);
  await local.db.prepare('INSERT INTO members(id,member_id,login_name,nickname,player_id,created_at,updated_at,last_login_at) VALUES(?,?,?,?,NULL,?,?,?)')
    .bind(randomUUID(),id,randomUUID().replaceAll('-',''),'歷史會員',now,now,now).run();
  await local.db.prepare("INSERT INTO auth_identities(provider,provider_subject,member_id,email_lookup_hash,email_ciphertext,email_iv,email_key_version,created_at,password_enabled,google_identity_id) VALUES('supabase',?,?,?,?,?,?,?,0,?)")
    .bind(subject,id,await emailHash(local.authConfig,p.oauth.user.email),protectedEmail.email_ciphertext,protectedEmail.email_iv,protectedEmail.email_key_version,Math.floor(Date.now()/1000),p.oauth.user.identities.find(i=>i.provider==='google').id).run();
  const before=await count('members'),response=await post('google/confirm',{transaction_id:p.result.transaction_id,confirmed:true},p.headers);
  assert.equal(response.status,200);const data=(await response.json()).data;
  assert.equal(data.member.member_id,id);assert.equal(data.member.player_id,null);assert.equal(await count('members'),before);
  const headers={...loginHeaders(),Cookie:responseCookie(response,SESSION_COOKIE),'X-CSRF-Token':data.csrf_token};
  const patched=await local.fetch('/api/me/profile','PATCH',{player_id:'legacy-'+randomUUID()},headers);
  assert.equal(patched.status,200);assert.equal((await patched.json()).data.member.member_id,id);assert.equal(await count('members'),before);
});
test('anonymous quick submission requires neither Fan ID nor nickname and claims no member',async()=>{
  const body=guestBody(await local.upload());delete body.nickname;delete body.player_id;
  const before=await count('members'),response=await local.fetch('/api/cases','POST',body,{'Idempotency-Key':randomUUID()});
  assert.equal(response.status,201);const result=(await response.json()).data;
  const row=await local.db.prepare('SELECT member_id,nickname FROM cases WHERE case_id=?').bind(result.case_id).first();
  assert.equal(row.member_id,null);assert.equal(row.nickname,'匿名投稿');assert.equal(await count('members'),before);
  assert.equal((await local.fetch('/api/cases/'+result.case_id+'?key='+result.query_key)).status,200);
});
