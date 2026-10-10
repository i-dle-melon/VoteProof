import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { localCaseRuntime, guestBody } from '../scripts/lib/local-case-runtime.mjs';
import { localAdminRuntime } from '../scripts/lib/local-admin-runtime.mjs';
import worker from '../src/index.js';
import { login } from '../scripts/lib/local-auth-runtime.mjs';
import { insertCase } from '../src/lib/case-store.js';
import { rememberCompletedUpload, requireCompletedUpload } from '../src/lib/completed-uploads.js';
const toggle=(local,on)=>local.db.prepare('UPDATE submission_settings SET submissions_enabled=? WHERE id=1').bind(Number(on)).run();
const error=async(response,code,status=503)=>{assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).error.code,code);};
const isolated=async(fn)=>{const local=await localCaseRuntime({submissionsEnabled:false});try{await fn(local);}finally{await local.runtime.dispose();}};
const adminIsolated=async(fn)=>{const h=await localAdminRuntime();try{await fn(h);}finally{await h.local.runtime.dispose();}};

test('submission migration defaults OFF; public response exposes only two safe fields',()=>isolated(async local=>{
  const r=await local.fetch('/api/submissions/status');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
  assert.deepEqual((await r.json()).data,{submissions_enabled:false,submissions_message:'投稿暫停開放，請稍後再試。'});
  await error(await local.fetch('/api/cases','POST',guestBody({session_id:randomUUID(),keys:[`proofs/staging/2026/10/10/${randomUUID()}/${randomUUID()}.png`]})),'INVALID_UPLOAD_REFERENCE',400);
}));
test('OFF blocks prepare and complete with no upload rows or signed URLs',()=>isolated(async local=>{
  const r=await local.fetch('/api/uploads/prepare','POST',{turnstile_token:randomBytes(24).toString('hex'),files:[{name:'x.png',type:'image/png',size:3}]});await error(r,'SUBMISSIONS_DISABLED');
  const session=randomUUID(),key=`proofs/staging/2026/10/10/${session}/${randomUUID()}.png`;
  await local.bucket.put(key,new Uint8Array([1,2,3]),{httpMetadata:{contentType:'image/png'}});
  await error(await local.fetch('/api/uploads/complete','POST',{session_id:session,keys:[key]}),'SUBMISSIONS_DISABLED');
  assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM completed_uploads').first()).n,0);
}));
test('OFF blocks guest case creation using a previously completed upload',()=>isolated(async local=>{
  await toggle(local,true);const reference=await local.upload();await toggle(local,false);
  await error(await local.fetch('/api/cases','POST',guestBody(reference)),'SUBMISSIONS_DISABLED');
  assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,0);
  assert.equal((await local.db.prepare('SELECT consumed_case_id FROM completed_uploads WHERE session_id=?').bind(reference.session_id).first()).consumed_case_id,null);
}));
test('OFF blocks authenticated member case creation without changing member APIs',()=>adminIsolated(async h=>{
  const member=await h.identity();const reference=await h.local.upload();await toggle(h.local,false);
  await error(await h.local.fetch('/api/cases','POST',guestBody(reference),member.headers),'SUBMISSIONS_DISABLED');
  assert.equal((await h.local.fetch('/api/auth/me','GET',undefined,member.headers)).status,200);
  assert.equal((await h.local.fetch('/api/me/cases','GET',undefined,member.headers)).status,200);
}));
test('OFF leaves real password registration and trusted-device login functional',()=>isolated(async local=>{
  const member=await login(local),again=await login(local,member);
  assert.equal(again.member.member_id,member.member.member_id);
  assert.equal((await local.fetch('/api/auth/me','GET',undefined,again.headers)).status,200);
  assert.equal((await local.db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);
}));
test('OFF preserves lookup, committed idempotency replay, leaderboard, login and admin review',()=>adminIsolated(async h=>{
  const admin=await h.identity({role:'admin'}),c=await h.makeCase();await toggle(h.local,false);
  assert.equal((await h.local.fetch('/api/cases/'+c.case_id+'?key='+c.query_key)).status,200);
  const replay=await h.local.fetch('/api/cases','POST',c.body,c.headers);assert.equal(replay.status,201);assert.equal((await replay.json()).data.query_key,c.query_key);
  for(const path of ['/api/health','/api/campaigns','/api/leaderboards'])assert.equal((await h.local.fetch(path)).status,200);
  assert.equal((await h.local.fetch('/api/auth/registration-status')).status,200);
  assert.equal((await h.local.fetch('/api/admin/cases','GET',undefined,admin.headers)).status,200);
  assert.equal((await h.review(admin,c.case_id,'reject',0,{reason:'local rejection'})).status,200);
  assert.equal((await h.local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,1);
}));
test('ON + active campaign allows Guest and Member submission',()=>adminIsolated(async h=>{
  const member=await h.identity(),guest=await h.makeCase(),owned=await h.makeCase({member});
  assert.notEqual(guest.case_id,owned.case_id);
  assert.equal((await h.local.db.prepare('SELECT member_id FROM cases WHERE case_id=?').bind(owned.case_id).first()).member_id,member.memberId);
}));
for(const status of ['missing','draft','closed','archived','future','expired'])test('ON still rejects '+status+' campaign',()=>isolated(async local=>{
  await toggle(local,true);const reference=await local.upload(),body=guestBody(reference);
  if(status==='missing')body.campaign_id='NOT-EXISTING';
  else if(status==='future'||status==='expired'){
    const id='WINDOW-'+status;await local.campaign({campaign_id:id,start_at:status==='future'?'2090-01-01T00:00:00.000Z':'2000-01-01T00:00:00.000Z',end_at:status==='future'?'2100-01-01T00:00:00.000Z':'2001-01-01T00:00:00.000Z'});body.campaign_id=id;
  }else {const id='STATUS-'+status;await local.campaign({campaign_id:id,status});body.campaign_id=id;}
  await error(await local.fetch('/api/cases','POST',body),status==='missing'?'CAMPAIGN_NOT_FOUND':'CAMPAIGN_NOT_OPEN',400);
}));
test('missing row / missing DB / failed DB all fail closed without leaking internals',()=>isolated(async local=>{
  await local.db.prepare('DELETE FROM submission_settings').run();assert.equal((await (await local.fetch('/api/submissions/status')).json()).data.submissions_enabled,false);
  for(const env of [{},{DB:{prepare(){throw Error('private detail');}}}]){
    const r=await worker.fetch(new Request('https://voteproof.example/api/submissions/status'),env);assert.equal(r.status,503);assert.equal((await r.text()).includes('private detail'),false);
  }
}));
test('admin toggle requires RBAC, MFA, exact Origin and CSRF; no public mutation',()=>adminIsolated(async h=>{
  const request={submissions_enabled:false,submissions_message:null,expected_version:0};
  await error(await h.local.fetch('/api/admin/submissions/update','POST',request),'AUTH_REQUIRED',401);
  for(const options of [{},{role:'reviewer'},{role:'admin',elevated:false}]){
    const actor=await h.identity(options);const response=await h.local.fetch('/api/admin/submissions/update','POST',request,actor.headers);
    assert.equal(response.status,403);
  }
  const actor=await h.identity({role:'admin'});
  for(const headers of [{...actor.headers,Origin:'https://evil.example'},{...actor.headers,'X-CSRF-Token':'bad'}])assert.equal((await h.local.fetch('/api/admin/submissions/update','POST',request,headers)).status,403);
  assert.equal((await h.local.fetch('/api/submissions/status','POST',request)).status,405);
}));
test('admin toggle is versioned and audited atomically; message is plaintext and length bounded',()=>adminIsolated(async h=>{
  const actor=await h.identity({role:'super_admin'}),message='<img src=x onerror=alert(1)> 暫停';
  const update={submissions_enabled:false,submissions_message:message,expected_version:0};
  const response=await h.local.fetch('/api/admin/submissions/update','POST',update,actor.headers);assert.equal(response.status,200);assert.equal((await response.json()).data.version,1);
  assert.deepEqual((await (await h.local.fetch('/api/submissions/status')).json()).data,{submissions_enabled:false,submissions_message:message});
  await error(await h.local.fetch('/api/admin/submissions/update','POST',update,actor.headers),'SUBMISSION_SETTINGS_CONFLICT',409);
  for(const bad of [{submissions_message:'x'.repeat(501)},{submissions_message:'bad\nmessage'},{submissions_enabled:1},{extra:'private'}])await error(await h.local.fetch('/api/admin/submissions/update','POST',{...update,expected_version:1,...bad},actor.headers),'INVALID_SUBMISSION_SETTINGS',400);
  assert.equal((await h.local.db.prepare('SELECT COUNT(*) n FROM submission_settings_audit').first()).n,1);
  await assert.rejects(h.local.db.prepare("UPDATE submission_settings_audit SET admin_role='admin'").run());
  await h.local.db.prepare("CREATE TRIGGER local_fail_gate_audit BEFORE INSERT ON submission_settings_audit BEGIN SELECT RAISE(ABORT,'local'); END").run();
  assert.equal((await h.local.fetch('/api/admin/submissions/update','POST',{...update,submissions_enabled:true,expected_version:1},actor.headers)).status,503);
  assert.equal((await h.local.db.prepare('SELECT submissions_enabled FROM submission_settings').first()).submissions_enabled,0);
}));
test('concurrent admin updates have one version/audit winner',()=>adminIsolated(async h=>{
  const a=await h.identity({role:'admin'}),b=await h.identity({role:'super_admin'});
  const results=await Promise.all([a,b].map(actor=>h.local.fetch('/api/admin/submissions/update','POST',{submissions_enabled:false,submissions_message:null,expected_version:0},actor.headers)));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await h.local.db.prepare('SELECT COUNT(*) n FROM submission_settings_audit').first()).n,1);
}));
test('in-flight completed upload and R2 copy cannot commit after gate closes',()=>isolated(async local=>{
  await toggle(local,true);const reference=await local.upload(),completed=await requireCompletedUpload(local.db,reference.session_id,reference.keys),body=guestBody(reference);
  await toggle(local,false);
  await assert.rejects(rememberCompletedUpload({DB:local.db},randomUUID(),completed.files),e=>e.code==='SUBMISSIONS_DISABLED');
  const record={id:randomUUID(),caseId:'VP-20261010-'+'A'.repeat(16),now:new Date().toISOString(),queryHash:randomBytes(32).toString('hex')};
  await assert.rejects(insertCase(local.db,{sessionId:reference.session_id,nickname:body.nickname,playerId:body.player_id,campaignId:body.campaign_id,voteType:'Solo',voteDate:body.vote_date,campaignVersion:0,note:null},record,[],completed.hash),e=>e.code==='SUBMISSIONS_DISABLED');
  assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,0);
}));
