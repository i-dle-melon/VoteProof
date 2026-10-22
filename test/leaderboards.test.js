import test,{ before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localLeaderboardRuntime,definition } from '../scripts/lib/local-leaderboard-runtime.mjs';
import { rebuildBoard,saveBoard,getBoard } from '../src/lib/leaderboard-store.js';
import { boardInput } from '../src/lib/leaderboard-policy.js';
import { adminIdentity } from '../src/lib/admin-identity.js';
import worker from '../src/index.js';
import {publicLeaderboardData} from '../src/lib/public-leaderboards.js';
import { localCaseRuntime } from '../scripts/lib/local-case-runtime.mjs';
let h,local;
before(async () => { h = await localLeaderboardRuntime(); local = h.local; });
after(async () => { await local?.runtime.dispose(); });
const at = n => `2026-10-01T00:00:${String(n).padStart(2,'0')}.000Z`;
const get = (path,actor = h.admin) => local.fetch(path,'GET',undefined,actor.headers);
const actor = async () => adminIdentity(new Request('https://voteproof.example',{headers:h.admin.headers}),{ DB:local.db });
async function err(response,status,code) { assert.equal(response.status,status); assert.equal(response.headers.get('cache-control'),'no-store'); const json = await response.json(); assert.equal(json.error.code,code); return json; }
async function publish(board) { const r = await h.rebuild(board); assert.equal(r.status,200,JSON.stringify(await r.clone().json())); return (await r.json()).data; }
async function current(board) { return (await (await get('/api/admin/leaderboards/'+board.leaderboard_id)).json()).data; }
async function fixtureProof(member,campaign,points,time,extra = {}) {
  const proof = await h.makeCase({member,metadata:{campaign_id:campaign,...extra}}), tx = randomUUID();
  const row = await local.db.prepare('SELECT * FROM cases WHERE id = ?').bind(proof.id).first();
  await local.db.prepare("UPDATE cases SET status = 'approved' WHERE id = ?").bind(proof.id).run();
  await local.db.prepare(`INSERT INTO point_transactions(transaction_id,created_at,member_id,case_id,campaign_id,category,vote_type,vote_date,points,reason,created_by)
    VALUES(?,?,?,?,?,'proof_approved',?,?,?,'Local history',?)`).bind(tx,time,member.memberId,proof.id,campaign,row.vote_type,row.vote_date,points,h.admin.memberId).run();
  return {...proof,tx,points,member,campaign,voteType:row.vote_type,voteDate:row.vote_date};
}
async function fixtureRevoke(proof,time) {
  await local.db.prepare("UPDATE cases SET status = 'revoked' WHERE id = ?").bind(proof.id).run();
  await local.db.prepare(`INSERT INTO point_transactions(transaction_id,created_at,member_id,case_id,campaign_id,category,vote_type,vote_date,points,reason,created_by,reference_transaction_id)
    VALUES(?,?,?,?,?,'proof_revoked',?,?,?,'Local reversal',?,?)`).bind(randomUUID(),time,proof.member.memberId,proof.id,proof.campaign,proof.voteType,proof.voteDate,-proof.points,h.admin.memberId,proof.tx).run();
}
test('Definition create, unique ID, actors and audit; public empty definition before rebuild',async () => {
  const b = await h.create(); assert.equal(b.version,0); assert.equal(b.created_by,h.admin.memberId); assert.equal(b.last_mutation_id,undefined);
  assert.deepEqual((await h.live(b)).rankings,[]); assert.equal((await h.live(b)).generated_at,null);
  await err(await local.fetch('/api/admin/leaderboards','POST',definition({leaderboard_id:b.leaderboard_id}),h.admin.headers),409,'LEADERBOARD_EXISTS');
  assert.equal((await local.db.prepare("SELECT action FROM admin_audit_logs WHERE target_type='leaderboard' AND target_id=?").bind(b.leaderboard_id).first()).action,'leaderboard_create');
});
test('enabled custom button registry exposes safe names before scores; OFF and draft hide it',async()=>{
  const b=await h.create({type:'custom',name:'生日應援榜',start_date:'2026-01-01',end_date:'2026-12-31'});
  const read=async()=> (await (await local.fetch('/api/leaderboards?id='+b.leaderboard_id)).json()).data;
  let data=await read();assert.equal(data.leaderboards.length,1);assert.deepEqual(data.leaderboards[0].rankings,[]);assert.equal(data.leaderboards[0].generated_at,null);assert.equal(data.generated_at,null);
  assert.deepEqual(data.custom_boards,[{leaderboard_id:b.leaderboard_id,name:'生日應援榜',type:'custom',campaign_id:null,vote_type:null}]);
  const off=await h.update(b,{is_public:false});assert.equal(off.status,200);assert.deepEqual((await read()).custom_boards,[]);
  const offRow=(await off.json()).data;const on=await h.update(offRow,{is_public:true,name:'新的按鈕名稱'});assert.equal(on.status,200);
  data=await read();assert.equal(data.custom_boards[0].name,'新的按鈕名稱');assert.equal(data.leaderboards[0].name,'新的按鈕名稱');assert.deepEqual(data.leaderboards[0].rankings,[]);
  const draft=await h.create({type:'custom',status:'draft',start_date:'2026-01-01',end_date:'2026-12-31'});
  assert.deepEqual((await (await local.fetch('/api/leaderboards?id='+draft.leaderboard_id)).json()).data.custom_boards,[]);
  assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM leaderboard_runs WHERE leaderboard_id=?').bind(b.leaderboard_id).first()).n,0);
});
for (const [name,change] of [
  ['top zero',{top_n:0}],['top large',{top_n:101}],['top fractional',{top_n:1.5}],['top string',{top_n:'10'}],
  ['bad id',{leaderboard_id:'../bad'}],['long id',{leaderboard_id:'x'.repeat(101)}],['name empty',{name:''}],['name long',{name:'x'.repeat(101)}],
  ['type',{type:'magic'}],['boolean',{is_public:1}],['vote type',{vote_type:'other'}],['status',{status:'closed'}],['archived create',{status:'archived'}],
  ['campaign missing',{type:'campaign',campaign_id:null,start_date:null,end_date:null}],['all-time campaign',{type:'all_time',campaign_id:'C-local',start_date:null,end_date:null}],['all-time dates',{type:'all_time',start_date:'2026-01-01',end_date:null}],
  ['custom dates missing',{type:'custom',start_date:null,end_date:null}],['invalid day',{type:'custom',start_date:'2026-02-30',end_date:'2026-03-01'}],
  ['reverse dates',{type:'custom',start_date:'2026-02-02',end_date:'2026-02-01'}],['client actor',{created_by:'forged'}],['client result',{points:100}],
]) test('Definition rejects '+name,async () => { await err(await local.fetch('/api/admin/leaderboards','POST',definition(change),h.admin.headers),400,'INVALID_LEADERBOARD_REQUEST'); });
test('Campaign FK validation, archived campaign cannot acquire new scope',async () => {
  await err(await local.fetch('/api/admin/leaderboards','POST',definition({type:'campaign',campaign_id:'MISSING',start_date:null,end_date:null}),h.admin.headers),400,'INVALID_CAMPAIGN');
  const c = await h.campaign({status:'archived'});
  await err(await local.fetch('/api/admin/leaderboards','POST',definition({type:'campaign',campaign_id:c,start_date:null,end_date:null}),h.admin.headers),409,'LEADERBOARD_CONFLICT');
});
test('Definition CAS protects concurrent updates; mutations invalidate current snapshot',async () => {
  const b = await h.create(); await publish(b); const row = await current(b);
  const r = await Promise.all([h.update(row,{name:'A'}),h.update(row,{name:'B'})]); assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);
  assert.equal((await current(b)).current_run_id,null);
  const pending = await h.live(b); assert.deepEqual(pending.rankings,[]);assert.equal(pending.generated_at,null);
});
test('Archive preserves historical run for admin, hides public and is immutable',async () => {
  const b = await h.create(); const run = await publish(b), row = await current(b);
  assert.equal((await h.update(row,{status:'archived'})).status,200);
  assert.equal((await current(b)).current_run_id,run.run_id); assert.equal(await h.live(b),undefined);
  assert.ok(await h.snapshot(b)); const archived = await current(b);
  await err(await h.update(archived,{name:'change'}),409,'LEADERBOARD_CONFLICT');
  await err(await h.rebuild(archived),409,'LEADERBOARD_CONFLICT');
  await assert.rejects(local.db.prepare('DELETE FROM leaderboards WHERE leaderboard_id=?').bind(b.leaderboard_id).run());
});
test('Public active comeback is discoverable with no run, never guesses points and respects privacy',async()=>{
  const c=await h.campaign({category:'團體'});
  const target=await h.create({name:'本次回歸測試空榜',type:'campaign',campaign_id:c,vote_type:'團體',is_current_comeback:true});
  const read=async id => (await (await local.fetch('/api/leaderboards'+(id?'?id='+encodeURIComponent(id):''))).json()).data;
  let all=await read(),board=all.leaderboards.find(b=>b.leaderboard_id===target.leaderboard_id);
  assert.ok(board);assert.equal(board.name,'本次回歸測試空榜');assert.equal(board.is_current_comeback,true);
  assert.equal(board.generated_at,null);assert.deepEqual(board.rankings,[]);
  assert.equal((await local.db.prepare('SELECT COUNT(*) AS n FROM leaderboard_runs WHERE leaderboard_id=?').bind(target.leaderboard_id).first()).n,0);
  assert.equal((await read(target.leaderboard_id)).leaderboards.length,1);
  assert.ok(!JSON.stringify(board).includes('run_id'));
  const privateBoard=await h.create({name:'私人回歸',type:'campaign',campaign_id:c,is_public:false});
  const draft=await h.create({name:'草稿回歸',type:'campaign',campaign_id:c,status:'draft'});
  for(const hidden of [privateBoard,draft]){
    assert.deepEqual((await read(hidden.leaderboard_id)).leaderboards,[]);
  }
  const published=await publish(target);assert.equal(published.row_count,0);
  board=(await read(target.leaderboard_id)).leaderboards[0];
  assert.equal(board.generated_at,null);assert.deepEqual(board.rankings,[]); // Empty live ledger, retained successful audit snapshot.
  await h.update(await current(target),{status:'archived'});
  assert.deepEqual((await read(target.leaderboard_id)).leaderboards,[]);
});
test('Updated definition uses live scope without requiring another snapshot',async()=>{
  const c=await h.campaign(),member=await h.identity();
  await fixtureProof(member,c,10,at(7));
  const board=await h.create({type:'campaign',campaign_id:c,start_date:null,end_date:null});
  await publish(board);
  const old=(await h.live(board));assert.equal(old.rankings.find(r=>r.member_id===member.memberId).points,10);
  const response=await h.update(await current(board),{name:'新範圍未公布'});
  assert.equal(response.status,200);
  const next=await h.live(board);
  assert.equal(next.name,'新範圍未公布');assert.equal(next.rankings[0].points,10);
  assert.ok(!(await local.fetch('/api/leaderboards?id='+board.leaderboard_id)).headers.get('cache-control').includes('no-store'));
});
test('Admin RBAC and auth statuses apply to ALL definition/preview/rebuild endpoints',async () => {
  const b = await h.create(), member = await h.identity(), suspended = await h.identity({role:'admin',status:'suspended'}), expired = await h.identity({role:'admin',expired:true});
  for (const a of [h.reviewer,member]) {
    for (const suffix of ['', '/'+b.leaderboard_id,'/'+b.leaderboard_id+'/results']) await err(await get('/api/admin/leaderboards'+suffix,a),403,'ADMIN_FORBIDDEN');
    await err(await h.rebuild(b,a),403,'ADMIN_FORBIDDEN');
    await err(await h.update(b,{name:'denied'},a),403,'ADMIN_FORBIDDEN');
    await err(await local.fetch('/api/admin/leaderboards','POST',definition(),a.headers),403,'ADMIN_FORBIDDEN');
  }
  assert.equal((await h.rebuild(b,suspended)).status,403); assert.equal((await h.rebuild(b,expired)).status,401);
  assert.equal((await local.fetch('/api/admin/leaderboards')).status,401);
  const superAdmin = await h.identity({role:'super_admin'}); assert.equal((await h.rebuild(b,superAdmin)).status,200);
});
test('CSRF, exact Origin, body limit, method and result mutation protections',async () => {
  const b = await h.create();
  for (const headers of [{...h.admin.headers,'X-CSRF-Token':''},{...h.admin.headers,Origin:'https://evil.example'}]) assert.equal((await local.fetch('/api/admin/leaderboards/'+b.leaderboard_id+'/rebuild','POST',{expected_version:0},headers)).status,403);
  assert.equal((await local.fetch('/api/admin/leaderboards','POST','x'.repeat(17000),h.admin.headers)).status,413);
  assert.equal((await local.fetch('/api/admin/leaderboards/'+b.leaderboard_id+'/rebuild','GET',undefined,h.admin.headers)).status,405);
  assert.equal((await local.fetch('/api/admin/leaderboards/'+b.leaderboard_id+'/results','POST',{},h.admin.headers)).status,405);
  assert.equal((await local.fetch('/api/leaderboards','POST',{})).status,405);
  await err(await local.fetch('/api/admin/leaderboards/'+b.leaderboard_id+'/rebuild','POST',{expected_version:0,points:100},h.admin.headers),400,'INVALID_LEADERBOARD_REQUEST');
});
test('Points DESC, proof_count DESC, reached_at ASC, member_id ASC; nickname never sorts',async () => {
  const c = await h.campaign(); const people = await Promise.all(Array.from({length:5},()=>h.identity()));
  const [a,b,d,e,f] = people;
  await fixtureProof(a,c,20,at(9)); await fixtureProof(b,c,10,at(2)); await fixtureProof(b,c,10,at(3));
  await fixtureProof(d,c,20,at(8)); await fixtureProof(e,c,20,at(8)); await fixtureProof(f,c,30,at(20));
  const board = await h.create({type:'campaign',campaign_id:c,start_date:null,end_date:null}); await publish(board);
  const rankings = (await h.live(board)).rankings;
  const tie = [d.memberId,e.memberId].sort(); assert.deepEqual(rankings.map(r=>r.member_id),[f.memberId,b.memberId,...tie,a.memberId]);
  assert.deepEqual(rankings.map(r=>r.rank),[1,2,3,4,5]); assert.equal(rankings[1].proof_count,2);
});
test('Reached_at resets after leaving final pair: positive/negative adjustment oscillations',async () => {
  const m = await h.identity();
  await h.adjust(m,10,at(1)); await h.adjust(m,5,at(2)); await h.adjust(m,-5,at(3));
  const board=(await publicLeaderboardData(local.db,'system-history')).leaderboards[0];
  const row = board.rankings.find(r=>r.member_id===m.memberId);
  assert.equal(row.points,10); assert.equal(row.proof_count,0); assert.equal(row.reached_at,at(3));
});
test('Reached_at tracks the pair, not MIN/MAX positive award or first equal points',async () => {
  const m = await h.identity(), c = await h.campaign();
  await fixtureProof(m,c,10,at(1)); const second = await fixtureProof(m,c,10,at(2)); await fixtureRevoke(second,at(4));
  const b = await h.create({type:'campaign',campaign_id:c,start_date:null,end_date:null}); await publish(b); const row = (await h.live(b)).rankings[0];
  assert.equal(row.points,10); assert.equal(row.proof_count,1); assert.equal(row.reached_at,at(4));
});
test('Same timestamp chronology gives original award precedence over reversal',async () => {
  const m = await h.identity(), c = await h.campaign(); const p = await fixtureProof(m,c,10,at(1));
  await fixtureProof(m,c,10,at(1)); await fixtureRevoke(p,at(1));
  const b = await h.create({type:'campaign',campaign_id:c,start_date:null,end_date:null}); await publish(b); const row = (await h.live(b)).rankings[0];
  assert.equal(row.proof_count,1); assert.equal(row.reached_at,at(1));
});
test('Completed never adds activity; revoke nets zero and zero/negative/inactive members are absent',async () => {
  const m = await h.identity(), zero = await h.identity(), negative = await h.identity(), empty = await h.identity(), c = await h.campaign();
  const p = await h.award(m,c); assert.equal((await h.review(h.admin,p.case_id,'complete',1)).status,200);
  let b = await h.create({type:'campaign',campaign_id:c,start_date:null,end_date:null}); await publish(b); assert.equal((await h.live(b)).rankings[0].proof_count,1);
  assert.equal((await h.review(h.admin,p.case_id,'revoke',2,{reason:'Local correction'})).status,200);
  await h.adjust(zero,10,at(1)); await h.adjust(zero,-10,at(2)); await h.adjust(negative,-10,at(1));
  await h.adjust(m,3,at(5)); await local.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(m.memberId).run();
  b = await h.create(); await publish(b); const ids = (await h.live(b)).rankings.map(r=>r.member_id);
  for (const person of [m,zero,negative,empty]) assert.equal(ids.includes(person.memberId),false);
});
test('Campaign and custom scopes exclude unscoped adjustments; system history includes them',async()=>{
  const m=await h.identity(),c=await h.campaign(),other=await h.campaign({category:'團體'});
  await fixtureProof(m,c,10,at(1),{vote_type:'Solo',vote_date:'2026-10-01'});
  await fixtureProof(m,other,20,at(2),{vote_type:'團體',vote_date:'2026-10-02'});await h.adjust(m,7,at(4));
  for(const [scope,points] of [[{type:'campaign',campaign_id:c},10],[{type:'custom',start_date:'2026-10-01',end_date:'2026-10-03'},30]]){
    const board=await h.create(scope);await publish(board);assert.equal((await h.live(board)).rankings.find(r=>r.member_id===m.memberId).points,points);
  }
  const system=(await publicLeaderboardData(local.db,'system-history')).leaderboards[0];assert.equal(system.rankings.find(r=>r.member_id===m.memberId).points,37);
});

test('Custom uses vote_date inclusive calendar boundaries, not UTC review/created time',async () => {
  const c = await h.campaign({campaign_timezone:'Asia/Taipei'}), m = await h.identity();
  await fixtureProof(m,c,10,'2026-10-02T23:59:59.999Z',{vote_date:'2026-10-01'});
  await fixtureProof(m,c,20,'2026-10-01T00:00:00.000Z',{vote_date:'2026-10-02'});
  const b = await h.create({type:'custom',campaign_id:c,start_date:'2026-10-01',end_date:'2026-10-01'}); await publish(b);
  assert.equal((await h.live(b)).rankings[0].points,10);
});
test('Nickname snapshot and ledger source survive profile/snapshot-field changes until rebuild',async () => {
  const c = await h.campaign(), m = await h.identity(); await fixtureProof(m,c,10,at(1));
  const b = await h.create({type:'campaign',campaign_id:c,start_date:null,end_date:null}); const run = await publish(b); const initial = await h.snapshot(b);
  await local.db.prepare("UPDATE members SET nickname='New nickname' WHERE member_id=?").bind(m.memberId).run();
  await local.db.prepare('UPDATE cases SET points_awarded=999 WHERE member_id=?').bind(m.memberId).run();
  assert.deepEqual(await h.snapshot(b),initial);assert.equal((await h.live(b)).rankings[0].nickname,'New nickname');await publish(await current(b));
  assert.equal((await h.live(b)).rankings[0].nickname,'New nickname'); assert.equal((await h.live(b)).rankings[0].points,10);
  assert.equal((await local.db.prepare('SELECT nickname FROM leaderboard_results WHERE run_id=?').bind(run.run_id).first()).nickname,initial.rankings[0].nickname);
});
test('Top N, empty published run, run/results immutable with composite FK/publish validation',async () => {
  const c = await h.campaign(); for (let i=1;i<=4;i++) await fixtureProof(await h.identity(),c,i,at(i));
  const b = await h.create({type:'campaign',campaign_id:c,top_n:2}), r = await publish(b);
  assert.equal(r.row_count,2); assert.deepEqual((await h.live(b)).rankings.map(x=>x.points),[4,3]);
  for (const sql of ["UPDATE leaderboard_results SET points=1 WHERE run_id=?","DELETE FROM leaderboard_results WHERE run_id=?",
    "UPDATE leaderboard_runs SET row_count=0 WHERE run_id=?","DELETE FROM leaderboard_runs WHERE run_id=?",
    "INSERT OR REPLACE INTO leaderboard_results SELECT * FROM leaderboard_results WHERE run_id=?"]) await assert.rejects(local.db.prepare(sql).bind(r.run_id).run());
  await assert.rejects(local.db.prepare('UPDATE leaderboards SET current_run_id=? WHERE leaderboard_id=?').bind(randomUUID(),b.leaderboard_id).run());
  const empty = await h.create({type:'campaign',campaign_id:await h.campaign()}); const e = await publish(empty);
  assert.equal(e.row_count,0); assert.deepEqual((await h.live(empty)).rankings,[]);
});
test('Public live reads require active public definition and retain safe ranking fields',async () => {
  for (const extra of [{is_public:false},{status:'draft'}]) { const b = await h.create(extra); await publish(b); assert.equal(await h.live(b),undefined); assert.ok(await h.snapshot(b)); }
  const b = await h.create(); await publish(b); const response = await local.fetch('/api/leaderboards?id='+b.leaderboard_id);
  assert.equal(response.headers.get('cache-control'),'public, max-age=0, must-revalidate'); const json = await response.json();
  assert.deepEqual(Object.keys(json.data).sort(),['custom_boards','generated_at','leaderboards']); const board = json.data.leaderboards[0];
  assert.deepEqual(Object.keys(board).sort(),['campaign_id','generated_at','is_current_comeback','leaderboard_id','name','rankings','type','vote_type']);
  for (const row of board.rankings) assert.deepEqual(Object.keys(row).sort(),['fan_id','member_id','nickname','points','proof_count','rank','reached_at','tier','tier_configuration_ready']);
  assert.equal(/email|player_id|token|hash|object_key|run_id|created_by/.test(JSON.stringify(json)),false);
  assert.deepEqual((await (await local.fetch('/api/leaderboards?id=missing')).json()).data.leaderboards,[]);
  const opted=(await (await local.fetch('/api/leaderboards?id='+b.leaderboard_id+'&view=live')).json()).data;
  assert.deepEqual(Object.keys(opted).sort(),['custom_boards','generated_at','leaderboards','refreshed_at']);
  assert.deepEqual(Object.keys(opted.leaderboards[0]).sort(),['campaign_id','end_date','generated_at','is_current_comeback','leaderboard_id','name','rankings','start_date','top_n','type','version','vote_type']);
});
test('No Apps Script dependency; immutable system registry works with no ledger rows and sanitizes failure',async()=>{
  const sandbox=await localCaseRuntime({seedCampaign:false});
  try{const response=await sandbox.fetch('/api/leaderboards');assert.equal(response.status,200);const data=(await response.json()).data;assert.equal(data.leaderboards.length,3);assert.ok(data.leaderboards.every(b=>b.system_fixed && !b.rankings.length));}finally{await sandbox.runtime.dispose();}
  await err(await worker.fetch(new Request('https://voteproof.example/api/leaderboards'),{}),503,'DB_NOT_CONFIGURED');
  await err(await worker.fetch(new Request('https://voteproof.example/api/leaderboards'),{DB:{prepare(){throw Error('sensitive metadata')}}}),503,'LEADERBOARD_SERVICE_UNAVAILABLE');
});

test('Rebuild audit summary has run/count/time; no full rankings; CAS increments version',async () => {
  const b = await h.create(); const r = await publish(b);
  const audit = await local.db.prepare('SELECT * FROM admin_audit_logs WHERE id=?').bind(r.run_id).first();
  assert.equal(audit.action,'leaderboard_rebuild'); const summary = JSON.parse(audit.after_json);
  assert.deepEqual(summary,{leaderboard_id:b.leaderboard_id,run_id:r.run_id,row_count:r.row_count,generated_at:r.generated_at});
  assert.equal((await current(b)).version,1); assert.equal(audit.admin_member_id,h.admin.memberId);
});
for (const stage of ['result','run','publish','audit']) test('Failure at '+stage+' rolls back new run and preserves published snapshot',async () => {
  const b = await h.create(); await publish(b); const row = await current(b), initial = await h.snapshot(b);
  const table = {result:'leaderboard_results',run:'leaderboard_runs',publish:'leaderboards',audit:'admin_audit_logs'}[stage];
  const op = ['run','publish'].includes(stage) ? 'UPDATE' : 'INSERT';
  const filter = stage === 'audit' ? "NEW.action = 'leaderboard_rebuild' AND NEW.target_id = '"+b.leaderboard_id+"'" : "NEW.leaderboard_id = '"+b.leaderboard_id+"'";
  await local.db.prepare(`CREATE TRIGGER local_rebuild_failure BEFORE ${op} ON ${table} WHEN ${filter} BEGIN SELECT RAISE(ABORT,'fixture failure'); END`).run();
  try { await err(await h.rebuild(row),503,'LEADERBOARD_REBUILD_FAILED'); } finally { await local.db.prepare('DROP TRIGGER local_rebuild_failure').run(); }
  assert.deepEqual(await h.snapshot(b),initial); assert.equal((await current(b)).current_run_id,row.current_run_id);
  assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM leaderboard_runs WHERE leaderboard_id=?').bind(b.leaderboard_id).first()).n,1);
});
test('Concurrent rebuild only publishes one complete run and no loser artifact/audit',async () => {
  const b = await h.create(); const responses = await Promise.all([h.rebuild(b),h.rebuild(b)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM leaderboard_runs WHERE leaderboard_id=?').bind(b.leaderboard_id).first()).n,1);
  assert.equal((await local.db.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE target_id=? AND action='leaderboard_rebuild'").bind(b.leaderboard_id).first()).n,1);
  assert.ok(await h.snapshot(b));
});
test('Live system ranking reflects concurrent ledger appends without an admin snapshot',async()=>{
  const m=await h.identity();await h.adjust(m,10,at(1));
  await Promise.all([local.fetch('/api/leaderboards?id=system-history'),h.adjust(m,5,at(2))]);
  const system=(await publicLeaderboardData(local.db,'system-history')).leaderboards[0];const row=system.rankings.find(x=>x.member_id===m.memberId);assert.equal(row.points,15);assert.equal(row.reached_at,at(2));
});

test('Authorization revoked after read is rechecked in rebuild/definition transaction',async () => {
  const a = await actor(), b = await h.create();
  await local.db.prepare("UPDATE admin_memberships SET status='disabled' WHERE member_id=?").bind(h.admin.memberId).run();
  try {
    await assert.rejects(rebuildBoard(local.db,a,b,0),e=>e.code==='LEADERBOARD_CONFLICT');
    await assert.rejects(saveBoard(local.db,a,boardInput(definition())),e=>e.code==='ADMIN_FORBIDDEN');
  } finally { await local.db.prepare("UPDATE admin_memberships SET status='active' WHERE member_id=?").bind(h.admin.memberId).run(); }
  assert.equal((await current(b)).current_run_id,null);
});
test('Archived Campaign retains snapshot, supports corrective rebuild, freezes leaderboard scope',async () => {
  const c = await h.campaign(), m = await h.identity(); await fixtureProof(m,c,10,at(1));
  const b = await h.create({type:'campaign',campaign_id:c,start_date:null,end_date:null}); await publish(b);
  await local.db.prepare("UPDATE campaigns SET status='closed' WHERE campaign_id=?").bind(c).run();
  await local.db.prepare("UPDATE campaigns SET status='archived' WHERE campaign_id=?").bind(c).run();
  await publish(await current(b)); assert.equal((await h.snapshot(b)).rankings[0].points,10);
  await err(await h.update(await current(b),{type:'all_time',campaign_id:null}),409,'SYSTEM_LEADERBOARD_FIXED');
});
test('Integrity error fails rebuild instead of clamping negative proof history',async () => {
  const c = await h.campaign(), m = await h.identity(); const p = await fixtureProof(m,c,10,at(2));
  const b = await h.create({type:'campaign',campaign_id:c,start_date:null,end_date:null}); await publish(b); const previous = await h.snapshot(b);
  await fixtureRevoke(p,at(1));
  await err(await h.rebuild(await current(b)),503,'LEADERBOARD_REBUILD_FAILED'); assert.deepEqual(await h.snapshot(b),previous);
  await assert.rejects(h.live(b),{code:'LEADERBOARD_SERVICE_UNAVAILABLE'});
});
test('Admin pagination is bounded/deterministic and filter-bound; list no-store',async () => {
  const r = await get('/api/admin/leaderboards?limit=2'); assert.equal(r.headers.get('cache-control'),'no-store'); const body = (await r.json()).data;
  assert.equal(body.leaderboards.length,2); assert.ok(body.next_cursor);
  const next = (await (await get('/api/admin/leaderboards?limit=2&cursor='+body.next_cursor)).json()).data;
  assert.equal(body.leaderboards.some(b=>next.leaderboards.some(n=>n.leaderboard_id===b.leaderboard_id)),false);
  await err(await get('/api/admin/leaderboards?status=draft&cursor='+body.next_cursor),400,'INVALID_ADMIN_QUERY');
  await err(await get('/api/admin/leaderboards?limit=51'),400,'INVALID_ADMIN_QUERY');
});
test('0006 preserves populated B5B ledger/audit and historical migration protections',async () => {
  const member = 'M-'+randomUUID(), auditId = randomUUID(), transaction = randomUUID(), timestamp = at(1);
  const sandbox = await localCaseRuntime({seedCampaign:false,migrationHook:async (db,name) => {
    if (name !== '0005_campaign_point_ledger.sql') return;
    await db.batch([
      db.prepare(`INSERT INTO members(id,member_id,login_name,nickname,status,created_at,updated_at,last_login_at)
        VALUES(?,?,?,'Local migration','active',?,?,?)`).bind(randomUUID(),member,randomUUID().replaceAll('-',''),timestamp,timestamp,timestamp),
      db.prepare(`INSERT INTO point_transactions(transaction_id,created_at,member_id,category,points,reason,created_by,idempotency_hash,request_hash)
        VALUES(?,?,?,'manual_adjustment',7,'Local migration',?,?,?)`).bind(transaction,timestamp,member,member,randomUUID().replaceAll('-','').repeat(2),randomUUID().replaceAll('-','').repeat(2)),
      db.prepare(`INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json)
        VALUES(?,?,?,'admin','manual_adjustment','point_transaction',?,0,'{}','{}')`).bind(auditId,timestamp,member,transaction),
    ]);
  }});
  try {
    assert.equal((await sandbox.db.prepare('SELECT points FROM point_transactions WHERE transaction_id=?').bind(transaction).first()).points,7);
    assert.equal((await sandbox.db.prepare('SELECT id FROM admin_audit_logs WHERE id=?').bind(auditId).first()).id,auditId);
    await assert.rejects(sandbox.db.prepare('UPDATE admin_audit_logs SET reason=? WHERE id=?').bind('edit',auditId).run());
    await assert.rejects(sandbox.db.prepare('UPDATE point_transactions SET points=8 WHERE transaction_id=?').bind(transaction).run());
    assert.deepEqual((await sandbox.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    assert.equal((await sandbox.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
  } finally { await sandbox.runtime.dispose(); }
});
for (const operation of ['create','update']) test('Definition '+operation+' audit failure rolls back config and preserves old pointer',async () => {
  const b = await h.create({type:'campaign',campaign_id:await h.campaign()}); await publish(b); const previous = await current(b), snapshot = await h.snapshot(b);
  const id = operation === 'create' ? 'LB-'+randomUUID() : b.leaderboard_id;
  await local.db.prepare(`CREATE TRIGGER local_definition_failure BEFORE INSERT ON admin_audit_logs
    WHEN NEW.target_type = 'leaderboard' AND NEW.target_id = '${id}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`).run();
  try {
    const response = operation === 'create' ? await local.fetch('/api/admin/leaderboards','POST',definition({leaderboard_id:id}),h.admin.headers) : await h.update(previous,{name:'failure'});
    await err(response,503,'LEADERBOARD_SERVICE_UNAVAILABLE');
  } finally { await local.db.prepare('DROP TRIGGER local_definition_failure').run(); }
  assert.deepEqual(await h.snapshot(b),snapshot); assert.deepEqual(await current(b),previous);
  if (operation === 'create') assert.equal(await local.db.prepare('SELECT leaderboard_id FROM leaderboards WHERE leaderboard_id=?').bind(id).first(),null);
});
test('Definition update versus rebuild CAS cannot publish a snapshot for a changed scope',async () => {
  const b = await h.create({type:'campaign',campaign_id:await h.campaign()}); const responses = await Promise.all([h.update(b,{vote_type:'Solo'}),h.rebuild(b)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]); const row = await current(b);
  if (row.vote_type === 'Solo') assert.equal(row.current_run_id,null);
  else { assert.ok(row.current_run_id); const run = await local.db.prepare('SELECT definition_json FROM leaderboard_runs WHERE run_id=?').bind(row.current_run_id).first(); assert.equal(JSON.parse(run.definition_json).vote_type,null); }
});
test('Public duplicate/oversize id rejects; query punctuation cannot inject SQL or reveal private data',async () => {
  await err(await local.fetch('/api/leaderboards?id=a&id=b'),400,'INVALID_LEADERBOARD_QUERY');
  await err(await local.fetch('/api/leaderboards?id='+ 'x'.repeat(101)),400,'INVALID_LEADERBOARD_QUERY');
  assert.deepEqual((await (await local.fetch('/api/leaderboards?id='+encodeURIComponent("' OR 1=1 --"))).json()).data.leaderboards,[]);
});
