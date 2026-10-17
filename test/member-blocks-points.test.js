import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';

async function verifyBlocks(h){
 const admin=await h.identity('admin'),reviewer=await h.identity('reviewer'),owner=await h.identity('super_admin'),member=await h.identity();
 const fan=(await h.db.prepare('SELECT player_id FROM members WHERE member_id=?').bind(member.memberId).first()).player_id;
 const input={fan_id:' '+fan.toUpperCase()+' ',confirmed_fan_id:fan.toLowerCase(),reason:'重複違規投稿',action:'block'};
 const call=(actor,body=input,method='POST',headers=actor?.headers)=>h.fetch('/api/admin/member-blocks',method,method==='GET'?undefined:body,headers);
 for(const a of [null,member,reviewer])for(const method of ['GET','POST'])assert.equal((await call(a,input,method)).status,a?403:401);
 const noCsrf={...admin.headers};delete noCsrf['X-CSRF-Token'];assert.equal((await call(admin,input,'POST',noCsrf)).status,403);assert.equal((await call(admin,input,'POST',{...admin.headers,Origin:'https://evil.example'})).status,403);
 for(const body of [{...input,reason:' '},{...input,confirmed_fan_id:'wrong'},{...input,action:'delete'},{...input,member_id:member.memberId}])assert.equal((await call(admin,body)).status,400);
 for(const target of [admin,owner]){const {player_id}=await h.db.prepare('SELECT player_id FROM members WHERE member_id=?').bind(target.memberId).first();assert.equal((await call(admin,{...input,fan_id:player_id,confirmed_fan_id:player_id})).status,403);}
 const before=(await h.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n;
 const responses=await Promise.all([call(admin),call(admin)]);for(const r of responses)assert.equal(r.status,200,await r.clone().text());
 assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM member_status_events WHERE member_id=?').bind(member.memberId).first()).n,1);
 for(const path of ['/api/auth/me','/api/me/points','/api/me/point-transactions','/api/me/cases','/api/auth/login-security','/api/admin/me']){const r=await h.fetch(path,'GET',undefined,member.headers);assert.equal(r.status,403,path);assert.equal((await r.json()).error.code,'MEMBER_SUSPENDED');}
 assert.equal((await h.fetch('/api/me/profile','PATCH',{nickname:'forged'},member.headers)).status,403);
 assert.equal((await h.db.prepare('SELECT elevated_until FROM auth_sessions WHERE member_id=?').bind(member.memberId).first()).elevated_until,0);
 const list=(await (await call(admin,input,'GET')).json()).data;assert.equal(list.members.find(m=>m.fan_id===fan).reason,input.reason);assert.doesNotMatch(JSON.stringify(list),/token_hash|email|member_id/);
 const audit=(await (await h.fetch('/api/admin/audit-logs?action=member_block','GET',undefined,admin.headers)).json()).data;assert.equal(audit.logs.length,1);
 const restore=await call(admin,{...input,action:'restore',reason:'管理員確認後恢復會員'});assert.equal(restore.status,200,await restore.clone().text());
 assert.equal((await h.fetch('/api/auth/me','GET',undefined,member.headers)).status,200);
 assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM member_status_events WHERE member_id=?').bind(member.memberId).first()).n,2);
 assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,before);
 assert.equal((await (await call(admin,input,'GET')).json()).data.members.length,0);
 await assert.rejects(h.db.prepare("UPDATE member_status_events SET reason='erase'").run());await assert.rejects(h.db.prepare('DELETE FROM member_status_events').run());
}
test('native member block/restore: MFA RBAC CSRF normalization concurrent duplicate and immutable audit',async()=>{const h=await embeddedCaseRuntime();try{await verifyBlocks(h);}finally{h.close();}});
test('real Miniflare member block/restore denies every protected member path and preserves points',async()=>{const r=await localAdminRuntime();try{await verifyBlocks({db:r.local.db,fetch:r.local.fetch,identity:role=>r.identity({role})});}finally{await r.local.runtime.dispose();}});
test('block transaction rechecks actor after read and rolls back if audit insertion fails',async()=>{
 const h=await embeddedCaseRuntime();try{
 const admin=await h.identity('admin'),target=await h.identity(),fan=(await h.db.prepare('SELECT player_id FROM members WHERE member_id=?').bind(target.memberId).first()).player_id;
 const body={fan_id:fan,confirmed_fan_id:fan,reason:'reason',action:'block'},original=h.db.batch.bind(h.db);let invalidate=true;
 h.db.batch=async statements=>{if(invalidate&&statements[0].sql.startsWith('UPDATE members SET status=')){invalidate=false;await h.db.prepare('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?').bind(admin.memberId).run();}return original(statements);};
 assert.equal((await h.fetch('/api/admin/member-blocks','POST',body,admin.headers)).status,403);assert.equal((await h.db.prepare('SELECT status FROM members WHERE member_id=?').bind(target.memberId).first()).status,'active');
 h.db.batch=original;await h.db.prepare('UPDATE auth_sessions SET elevated_until=? WHERE member_id=?').bind(Math.floor(Date.now()/1000)+3600,admin.memberId).run();
 await h.db.prepare("CREATE TRIGGER fail_block_audit BEFORE INSERT ON member_status_events BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
 assert.equal((await h.fetch('/api/admin/member-blocks','POST',body,admin.headers)).status,409);assert.equal((await h.db.prepare('SELECT status FROM members WHERE member_id=?').bind(target.memberId).first()).status,'active');assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM member_status_events').first()).n,0);
 }finally{h.close();}
});
test('point history is owned, fixed ten-row keyset pages without staff identity or metadata',async()=>{
 const h=await embeddedCaseRuntime();try{const admin=await h.identity('admin'),member=await h.identity(),other=await h.identity();
 for(const [target,n] of [[member,23],[other,2]])for(let i=0;i<n;i++){const r=await h.fetch('/api/admin/points/adjustments','POST',{member_id:target.memberId,points:i%2?-1:10,reason:target===member?'自己的點數異動':'另一會員的私人紀錄'},{...admin.headers,'Idempotency-Key':randomUUID()});assert.equal(r.status,201,await r.clone().text());}
 let cursor=null;const sizes=[],ids=[];do{const r=await h.fetch('/api/me/point-transactions?limit=10'+(cursor?'&cursor='+cursor:''),'GET',undefined,member.headers);assert.equal(r.status,200);const data=(await r.json()).data;sizes.push(data.transactions.length);ids.push(...data.transactions.map(t=>t.transaction_id));assert.doesNotMatch(JSON.stringify(data),/另一會員|created_by|metadata_json|member_id|token/);cursor=data.next_cursor;}while(cursor);
 assert.deepEqual(sizes,[10,10,3]);assert.equal(new Set(ids).size,23);
 for(const query of ['?limit=20','?cursor=invalid','?member_id='+other.memberId,'?limit=10&limit=10'])assert.equal((await h.fetch('/api/me/point-transactions'+query,'GET',undefined,member.headers)).status,400);
 assert.equal((await h.fetch('/api/me/point-transactions','GET')).status,401);
 }finally{h.close();}
});
