import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {localCaseRuntime,guestBody} from '../scripts/lib/local-case-runtime.mjs';
import {normalizeFanId} from '../src/lib/fan-id.js';
let h,local,admin;
before(async()=>{h=await localAdminRuntime();local=h.local;admin=await h.identity({role:'super_admin',fanId:'idle_voteproof'});});
after(async()=>{await local?.runtime.dispose();});
const data=async r=>{const j=await r.json();assert.equal(j.ok,true,JSON.stringify(j));return j.data;};
const profile=(m,body)=>local.fetch('/api/me/profile','PATCH',body,m.headers);
async function error(r,status,code){assert.equal(r.status,status);assert.equal((await r.json()).error.code,code);}
test('fan ID first claim, normalization collision, and race have one winner',async()=>{
 const a=await h.identity({fanId:null}),b=await h.identity({fanId:null});
 assert.equal((await data(await profile(a,{player_id:'  Idle_VoteProof_Claim  '}))).member.fan_id,'Idle_VoteProof_Claim');
 await error(await profile(b,{player_id:'idle_voteproof_claim'}),409,'FAN_ID_TAKEN');
 const c=await h.identity({fanId:null}),d=await h.identity({fanId:null});
 const results=await Promise.all([profile(c,{player_id:'RACE_FAN'}),profile(d,{player_id:' race_fan '})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM members WHERE lower(trim(player_id))='race_fan'").first()).n,1);
 assert.equal(normalizeFanId(' Idle_VoteProof '),'idle_voteproof');
});
test('fan ID immutable at API and DB; same member concurrent different claims cannot overwrite',async()=>{
 const a=await h.identity({fanId:null});
 const results=await Promise.all([profile(a,{player_id:'claim_a'}),profile(a,{player_id:'claim_b'})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 await error(await profile(admin,{player_id:'changed_admin'}),409,'FAN_ID_IMMUTABLE');
 await assert.rejects(local.db.prepare('UPDATE members SET player_id=? WHERE member_id=?').bind('changed_admin',admin.memberId).run(),/FAN_ID_IMMUTABLE/);
 assert.equal((await local.db.prepare('SELECT player_id FROM members WHERE member_id=?').bind(admin.memberId).first()).player_id,'idle_voteproof');
 await assert.rejects(local.db.prepare("INSERT OR REPLACE INTO members(id,member_id,login_name,nickname,player_id,created_at,updated_at,last_login_at) VALUES('replacefixture','replacefixture','replacefixture','Fixture','IDLE_VOTEPROOF','now','now','now')").run(),/FAN_ID_TAKEN/);
});
test('nickname duplicate advisory returns only boolean, still saves and changes',async()=>{
 const a=await h.identity({nickname:'葉子'}),b=await h.identity();
 const warning=await data(await local.fetch('/api/auth/profile-warning','POST',{nickname:'葉子'},{Origin:'https://voteproof.example','X-VoteProof-Request':'1'}));
 assert.deepEqual(warning,{duplicate:true});
 const saved=await data(await profile(b,{nickname:'葉子'}));assert.equal(saved.member.nickname,'葉子');assert.deepEqual(saved.nickname_warning,{duplicate:true});
 assert.equal((await data(await profile(b,{nickname:'可修改暱稱'}))).member.nickname,'可修改暱稱');
 await error(await local.fetch('/api/me/profile','PATCH',{player_id:'guest_claim'}),401,'AUTH_REQUIRED');
});
test('anonymous submission omits identity and ignores forged legacy identity; fan_id cannot claim identity',async()=>{
 const ref=await local.upload(),body=guestBody(ref);delete body.nickname;delete body.player_id;
 const created=await data(await local.fetch('/api/cases','POST',body));
 const row=await local.db.prepare('SELECT member_id,nickname,player_id FROM cases WHERE case_id=?').bind(created.case_id).first();assert.deepEqual(row,{member_id:null,nickname:'匿名投稿',player_id:'匿名投稿'});
 const second=await data(await local.fetch('/api/cases','POST',guestBody(await local.upload())));
 assert.equal((await local.db.prepare('SELECT nickname FROM cases WHERE case_id=?').bind(second.case_id).first()).nickname,'匿名投稿');
 await error(await local.fetch('/api/cases','POST',{...guestBody(await local.upload()),fan_id:'stolen'}),400,'INVALID_CASE_REQUEST');
 assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM members WHERE player_id='stolen'").first()).n,0);
 const found=await data(await local.fetch('/api/cases/'+created.case_id,'GET',undefined,{'X-Case-Query-Key':created.query_key}));assert.equal(found.nickname,'匿名投稿');
});
test('member submissions use server profile and owner-only query without a query key',async()=>{
 const m=await h.identity({fanId:'owner_fan',nickname:'Owner'}),created=await h.makeCase({member:m,metadata:{nickname:'Forged',player_id:'SomeoneElse'}});
 const row=await local.db.prepare('SELECT member_id,nickname,player_id FROM cases WHERE case_id=?').bind(created.case_id).first();assert.deepEqual(row,{member_id:m.memberId,nickname:'Owner',player_id:'owner_fan'});
 const found=await data(await local.fetch('/api/me/cases/'+created.case_id,'GET',undefined,m.headers));assert.equal(found.case_id,created.case_id);assert.equal('query_key' in found,false);
 const other=await h.identity();await error(await local.fetch('/api/me/cases/'+created.case_id,'GET',undefined,other.headers),404,'CASE_NOT_FOUND');
});
test('campaign category enforces matching type at API and transaction boundary',async()=>{
 await local.campaign({campaign_id:'RULE-GROUP',category:'團體'});
 const body=guestBody(await local.upload());body.campaign_id='RULE-GROUP';
 await error(await local.fetch('/api/cases','POST',body),400,'CAMPAIGN_TYPE_MISMATCH');
 body.vote_type='團體';assert.equal((await local.fetch('/api/cases','POST',body)).status,201);
 await assert.rejects(local.db.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at) VALUES('INVALID','Invalid','Other','2000','2100','UTC','2000','2100',10,NULL,'active','now','now')").run(),/CAMPAIGN_TYPE_INVALID/);
});
test('legacy missing/invalid campaign type fails closed without consuming proof uploads',async()=>{
 const sandbox=await localCaseRuntime({seedCampaign:false,migrationHook:async(db,name)=>{
   if(name==='0013_async_proof_duplicates.sql')await db.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at) VALUES('LEGACY','Fixture','Solo','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','UTC','2000-01-01','2099-12-31',10,NULL,'active','now','now')").run();
 }});
 try{const reference=await sandbox.upload();await error(await sandbox.fetch('/api/cases','POST',{...guestBody(reference),campaign_id:'LEGACY'}),400,'CAMPAIGN_TYPE_INVALID');assert.equal((await sandbox.db.prepare('SELECT consumed_case_id FROM completed_uploads WHERE session_id=?').bind(reference.session_id).first()).consumed_case_id,null);}finally{await sandbox.runtime.dispose();}
});
test('system history/group/Solo are live historical ledger sums; Solo targets combine, reversals and adjustments count',async()=>{
 const m=await h.identity(),campaigns=[['RULE-A','Solo','artist_a'],['RULE-A2','Solo','artist_a'],['RULE-B','Solo','artist_b'],['RULE-G','團體',null]];
 let first;
 for(const [campaign_id,category,solo_target] of campaigns){await local.campaign({campaign_id,category,solo_target,points_per_proof:10,daily_limit:null});const created=await h.makeCase({member:m,metadata:{campaign_id,vote_type:category}});await data(await h.review(admin,created.case_id,'approve'));first??=created;}
 await data(await local.fetch('/api/admin/points/adjustments','POST',{member_id:m.memberId,points:7,reason:'Local valid adjustment'},{...admin.headers,'Idempotency-Key':randomUUID()}));
 let boards=(await data(await local.fetch('/api/leaderboards'))).leaderboards;
 assert.equal(boards.find(b=>b.leaderboard_id==='system-history').rankings.find(r=>r.member_id===m.memberId).points,47);
 assert.equal(boards.find(b=>b.leaderboard_id==='system-group').rankings.find(r=>r.member_id===m.memberId).points,10);
 const solo=boards.filter(b=>b.leaderboard_id==='system-solo');assert.equal(solo.length,1);
 assert.equal(solo[0].rankings.find(r=>r.member_id===m.memberId).points,30);
 assert.equal(solo[0].rankings.find(r=>r.member_id===m.memberId).proof_count,3);
 await data(await h.review(admin,first.case_id,'revoke',1,{reason:'Local reversal'}));
 boards=(await data(await local.fetch('/api/leaderboards'))).leaderboards;
 assert.equal(boards.find(b=>b.leaderboard_id==='system-history').rankings.find(r=>r.member_id===m.memberId).points,37);
 assert.equal(boards.find(b=>b.leaderboard_id==='system-solo').rankings.find(r=>r.member_id===m.memberId).points,20);
 assert.equal(boards.find(b=>b.leaderboard_id==='system-group').rankings.find(r=>r.member_id===m.memberId).points,10);
 for(const id of ['system-history','system-group','system-solo'])await error(await local.fetch('/api/admin/leaderboards/'+id+'/rebuild','POST',{expected_version:0},admin.headers),409,'SYSTEM_LEADERBOARD_FIXED');
});

test('Solo history includes valid legacy ledger with no target key or target metadata',async()=>{
 const memberId='M-'+randomUUID(),caseId=randomUUID(),sessionId=randomUUID(),now='2025-01-01T00:00:00.000Z';
 const sandbox=await localCaseRuntime({seedCampaign:false,migrationHook:async(db,name)=>{
  if(name!=='0013_async_proof_duplicates.sql')return;
  await db.batch([
   db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1'),
   db.prepare("INSERT INTO members(id,member_id,login_name,nickname,status,created_at,updated_at,last_login_at) VALUES(?,?,?,'Legacy fixture','active',?,?,?)").bind(randomUUID(),memberId,randomUUID().replaceAll('-',''),now,now,now),
   db.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at) VALUES('LEGACY-SOLO','Legacy Solo','Solo','2025-01-01','2025-02-01','UTC','2025-01-01','2025-02-01',10,'closed',?,?)").bind(now,now),
   db.prepare('INSERT INTO completed_uploads(session_id,manifest_hash,completed_at) VALUES(?,?,?)').bind(sessionId,'a'.repeat(64),now),
   db.prepare("INSERT INTO cases(id,case_id,created_at,updated_at,member_id,nickname,player_id,campaign_id,vote_type,vote_date,status,query_key_hash,source,upload_session_id) VALUES(?,'VP-20250101-AAAAAAAAAAAAAAAA',?,?,?,'Legacy fixture','legacy-fan','LEGACY-SOLO','Solo','2025-01-01','approved',?,'member',?)").bind(caseId,now,now,memberId,'b'.repeat(64),sessionId),
   db.prepare("INSERT INTO point_transactions(transaction_id,created_at,member_id,case_id,campaign_id,category,vote_type,vote_date,points,reason,created_by,metadata_json) VALUES(?,?,?,?,'LEGACY-SOLO','proof_approved','Solo','2025-01-01',10,'Historical approved fixture',?,NULL)").bind(randomUUID(),now,memberId,caseId,memberId),
  ]);
 }});
 try{const boards=(await data(await sandbox.fetch('/api/leaderboards?id=system-solo'))).leaderboards;assert.equal(boards.length,1);assert.equal(boards[0].rankings[0].points,10);assert.equal(boards[0].rankings[0].proof_count,1);}finally{await sandbox.runtime.dispose();}
});
test('Solo total aggregates miyeon 10 plus minnie 20 plus yuqi 30 without artist dimensions',async()=>{
 const m=await h.identity(),proofs=[];
 for(const [target,points]of [['miyeon',10],['minnie',20],['yuqi',30]]){
  const campaign_id='TOTAL-'+target;
  await local.campaign({campaign_id,category:'Solo',solo_target:target,points_per_proof:points,daily_limit:null});
  const c=await h.makeCase({member:m,metadata:{campaign_id,vote_type:'Solo'}});proofs.push(c);
  await data(await h.review(admin,c.case_id,'approve'));
  await local.db.prepare("UPDATE campaigns SET status='closed',version=version+1 WHERE campaign_id=?").bind(campaign_id).run();
 }
 const rankings=async()=>(await data(await local.fetch('/api/leaderboards?id=system-solo'))).leaderboards[0].rankings;
 const rows=(await rankings()).filter(r=>r.member_id===m.memberId);assert.equal(rows.length,1);assert.equal(rows[0].points,60);assert.equal(rows[0].proof_count,3);
 await data(await h.review(admin,proofs[1].case_id,'revoke',1,{reason:'Total board reversal'}));
 const after=(await rankings()).find(r=>r.member_id===m.memberId);assert.equal(after.points,40);assert.equal(after.proof_count,2);
 await error(await local.fetch('/api/leaderboards/solo-targets'),404,'NOT_FOUND');
 for(const target of ['miyeon','minnie','yuqi'])await error(await local.fetch('/api/leaderboards?id=system-solo&solo_target='+target),400,'INVALID_LEADERBOARD_QUERY');
});
test('campaign/custom publication remains functional alongside immutable system boards',async()=>{
 for(const type of ['campaign','custom']){
 const body={leaderboard_id:'RULE-'+type,name:type,type,campaign_id:'RULE-A',start_date:type==='custom'?'2000-01-01':null,end_date:type==='custom'?'2099-12-31':null,vote_type:null,top_n:100,is_public:true,status:'active'};
 const board=await data(await local.fetch('/api/admin/leaderboards','POST',body,admin.headers));
 await data(await local.fetch('/api/admin/leaderboards/'+board.leaderboard_id+'/rebuild','POST',{expected_version:board.version},admin.headers));
 assert.equal((await data(await local.fetch('/api/leaderboards?id='+board.leaderboard_id))).leaderboards.length,1);
 }
});
test('migration preserves NULL IDs and idle_voteproof; collision fails atomically without deletion or rename',async()=>{
 const checkpoint=await localCaseRuntime({seedCampaign:false,migrationThrough:'0013_async_proof_duplicates.sql'});
 try {
 const db=checkpoint.db,sql=await readFile(new URL('../migrations/0014_fan_campaign_rules.sql',import.meta.url),'utf8');
 const add=async(id,fan)=>db.prepare("INSERT INTO members(id,member_id,login_name,nickname,player_id,created_at,updated_at,last_login_at) VALUES(?,?,?,'Fixture',?,'now','now','now')").bind(id,id,id,fan).run();
 await add('adminfixture','idle_voteproof');await add('nullfixture',null);await add('collisionfixture',' IDLE_VOTEPROOF ');
 await assert.rejects(db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s))),/UNIQUE/);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM members').first()).n,3);
 assert.equal((await db.prepare("SELECT player_id FROM members WHERE member_id='adminfixture'").first()).player_id,'idle_voteproof');
 assert.equal((await db.prepare("SELECT player_id FROM members WHERE member_id='collisionfixture'").first()).player_id,' IDLE_VOTEPROOF ');
 }finally{await checkpoint.runtime.dispose();}
});
