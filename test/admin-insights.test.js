import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';

test('member overview: only elevated admins, bounded list, indexed searches and on-demand detail',async()=>{
  const h=await embeddedCaseRuntime();
  try{
    const admin=await h.identity('admin'),reviewer=await h.identity('reviewer'),member=await h.identity();
    for(const [actor,expected] of [[null,401],[reviewer,403],[member,403]]){
      const r=await h.fetch('/api/admin/members-overview','GET',undefined,actor?.headers);
      assert.equal(r.status,expected,await r.clone().text());
    }
    const fan=(await h.db.prepare('SELECT player_id FROM members WHERE member_id=?').bind(member.memberId).first()).player_id;
    const query=async path=>h.fetch(path,'GET',undefined,admin.headers);
    const r=await query('/api/admin/members-overview');
    assert.equal(r.status,200,await r.clone().text());
    const data=(await r.json()).data;
    assert.ok(data.members.some(m=>m.member_id===member.memberId));
    assert.ok(data.members.length<=20);
    assert.equal(data.page_size,20);
    assert.doesNotMatch(JSON.stringify(data),/email_ciphertext|token_hash|password_hash|last_login_at/);
    const exact=await query('/api/admin/members-overview?fan_id='+encodeURIComponent(fan.toUpperCase()));
    assert.equal((await exact.json()).data.members.length,1);
    const search=await query('/api/admin/members-overview?nickname=Component');
    assert.equal(search.status,200);
    assert.ok((await search.json()).data.members.length>=1);
    const detail=await query('/api/admin/members-overview/'+member.memberId);
    assert.equal(detail.status,200,await detail.clone().text());
    assert.equal((await detail.json()).data.member.total_points,0);
    for(const type of ['cases','transactions']){
      const x=await query('/api/admin/members-overview/'+member.memberId+'/'+type);
      assert.equal(x.status,200,await x.clone().text());
      assert.deepEqual((await x.json()).data[type],[]);
    }
    for(const qs of ['?bad=1','?cursor=broken','?nickname=a&fan_id=foo','?status=invalid','?nickname=x&nickname=y']){
      assert.equal((await query('/api/admin/members-overview'+qs)).status,400,qs);
    }
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM admin_member_contact_audit').first()).n,0);
  }finally{h.close();}
});

test('member list uses stable 20-record keyset pages without a full member scan or PII',async()=>{
 const h=await embeddedCaseRuntime();
 try{
   const admin=await h.identity('super_admin');
   for(let i=0;i<42;i++)await h.identity();
   const seen=new Set();let cursor=null,sizes=[];
   do{
     const r=await h.fetch('/api/admin/members-overview'+(cursor?'?cursor='+encodeURIComponent(cursor):''),'GET',undefined,admin.headers);
     assert.equal(r.status,200,await r.clone().text());
     const d=(await r.json()).data;sizes.push(d.members.length);
     for(const m of d.members){assert.ok(!seen.has(m.member_id));seen.add(m.member_id);}
     cursor=d.next_cursor;
   }while(cursor);
   assert.deepEqual(sizes,[20,20,3]);
   assert.equal(seen.size,43);
 }finally{h.close();}
});

test('health monitor reads bounded D1 metadata only; not R2, Drive, background cleanup or writes',async()=>{
 const h=await embeddedCaseRuntime();
 try{
   const admin=await h.identity('admin'),reviewer=await h.identity('reviewer'),member=await h.identity();
   const now=Math.floor(Date.now()/1000);
   await h.db.prepare("INSERT INTO storage_alerts(id,episode,kind,created_at,state) VALUES(?,?,'cleanup_failed',?,'pending')").bind(randomUUID(),1234,now).run();
   await h.db.prepare("INSERT INTO storage_audit(id,created_at,action,target,detail) VALUES(?,?,'alert_rejected','synthetic','{}')").bind(randomUUID(),now).run();
   for(const method of ['put','head','get','list','delete'])h.bucket[method]=()=>{throw Error('HEALTH_MUST_NOT_TOUCH_R2');};
   const fetch=async path=>h.fetch(path,'GET',undefined,admin.headers);
   for(const a of [reviewer,member])assert.equal((await h.fetch('/api/admin/health-monitor/summary','GET',undefined,a.headers)).status,403);
   const result=await fetch('/api/admin/health-monitor/summary');
   assert.equal(result.status,200,await result.clone().text());
   const data=(await result.json()).data;
   assert.equal(data.upload_failures.count,null);
   assert.equal(data.cleanup_failures.count,1);
   assert.equal(data.pending_operations.legacy_ack_unverified,true);
   const events=await fetch('/api/admin/health-monitor/events?type=cleanup');
   assert.equal(events.status,200,await events.clone().text());
   assert.equal((await events.json()).data.events[0].code,'cleanup_failed');
   const audit=await fetch('/api/admin/health-monitor/events?type=capacity&status=pending');
   assert.equal(audit.status,200,await audit.clone().text());
   assert.ok((await audit.json()).data.events.some(e=>e.code==='alert_rejected'));
   for(const qs of ['?type=bogus','?status=not_a_state','?cursor=bad','?type=all&type=backup']){
     assert.equal((await fetch('/api/admin/health-monitor/events'+qs)).status,400,qs);
   }
   assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM storage_audit').first()).n,1);
   assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM storage_alerts').first()).n,1);
 }finally{h.close();}
});
