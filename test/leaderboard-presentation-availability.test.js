import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {embeddedCaseRuntime,origin} from './helpers/embedded-case-runtime.mjs';
import {installResetExtensionLocal} from '../scripts/lib/prelaunch-selective-reset.mjs';
import {memberSession,csrfToken} from '../src/lib/auth-session.js';

async function fixture(t,{flag,install=false}={}){
 const f=await embeddedCaseRuntime();t.after(()=>f.close());
 const admin=await f.identity('admin'),member=await f.identity(),expired=await f.identity('admin');
 f.sqlite.prepare('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?').run(expired.memberId);
 installResetExtensionLocal(f.sqlite,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));
 f.sqlite.exec("UPDATE prelaunch_reset_control SET epoch=1,mode='open'");
 f.env.PRELAUNCH_RESET_FENCE_ENABLED='true';
 if(flag!==undefined)f.env.ADMIN_LEADERBOARD_PRESENTATION_ENABLED=flag;
 if(install)f.sqlite.exec(fs.readFileSync('migrations-admin-presentation/0001_leaderboard_presentation.sql','utf8'));
 for(const actor of[admin,member,expired]){
  const session=await memberSession(new Request(origin,{headers:actor.headers}),f.env);
  actor.headers['X-CSRF-Token']=await csrfToken(session,{...f.env,PRELAUNCH_RESET_CONTEXT:{epoch:1}});
 }
 const sql=[],raw=f.env.DB;f.env.DB={...raw,prepare(query){sql.push(query);return raw.prepare(query);}};
 const totalChanges=()=>f.sqlite.prepare('SELECT total_changes() n').get().n;
 const list=actor=>f.fetch('/api/admin/leaderboards','GET',undefined,(actor??admin).headers);
 const save=(actor=admin,headers=actor.headers)=>f.fetch('/api/admin/leaderboards/system-history/presentation','POST',{
  name:'顯示測試',top_n:20,is_public:false,expected_version:0,
 },headers);
 return{...f,admin,member,expired,sql,totalChanges,list,save};
}

for(const flag of[undefined,'false',true])test(`presentation capability stays off without extension: ${typeof flag}:${String(flag)}`,async t=>{
 const f=await fixture(t,{flag});
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='admin_leaderboard_presentations'").get().n,0);
 const before=f.totalChanges(),r=await f.list();assert.equal(r.status,200);const data=(await r.json()).data;
 assert.equal(data.system_boards.length,3);assert.ok(data.system_boards.every(b=>b.presentation_enabled===false));
 assert.equal(f.totalChanges(),before,'GET must not add Operation, Permit, audit or business writes');
 const denied=await f.save();assert.equal(denied.status,503);assert.equal((await denied.json()).error.code,'PRESENTATION_NOT_READY');
 assert.ok(!f.sql.some(q=>q.includes('admin_leaderboard_presentations')),'OFF must not query or mutate missing extension');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM point_transactions').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE action='leaderboard_update'").get().n,0);
});

test('enabled presentation retains authorization, MFA, CSRF, CAS and display-only saves',async t=>{
 const f=await fixture(t,{flag:'true',install:true}),before=f.totalChanges();
 const r=await f.list();assert.equal(r.status,200);const data=(await r.json()).data;
 assert.ok(data.system_boards.every(b=>b.presentation_enabled===true));assert.equal(f.totalChanges(),before);
 for(const actor of[f.member,f.expired]){assert.equal((await f.list(actor)).status,403);assert.equal((await f.save(actor)).status,403);}
 assert.equal((await f.save(f.admin,{...f.admin.headers,'X-CSRF-Token':'invalid'})).status,403);
 const saved=await f.save();assert.equal(saved.status,200);const board=(await saved.json()).data;
 assert.equal(board.name,'顯示測試');assert.equal(board.version,1);assert.equal(board.type,'all_time');
 assert.equal((await f.save()).status,409,'stale version must still fail');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM point_transactions').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE action='leaderboard_update'").get().n,1);
});

test('enabled flag with missing extension fails closed instead of advertising usable settings',async t=>{
 const f=await fixture(t,{flag:'true'});assert.equal((await f.list()).status,503);
 assert.equal((await f.save()).status,503);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM point_transactions').get().n,0);
});
