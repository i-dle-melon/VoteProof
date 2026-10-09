import test,{ before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localLeaderboardRuntime,definition } from '../scripts/lib/local-leaderboard-runtime.mjs';
import { rebuildBoard,saveBoard,getBoard } from '../src/lib/leaderboard-store.js';
import { boardInput } from '../src/lib/leaderboard-policy.js';
import { adminIdentity } from '../src/lib/admin-identity.js';
import worker from '../src/index.js';
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
test('Definition create, unique ID, actors and audit; no public snapshot before rebuild',async () => {
  const b = await h.create(); assert.equal(b.version,0); assert.equal(b.created_by,h.admin.memberId); assert.equal(b.last_mutation_id,undefined);
  assert.equal(await h.snapshot(b),undefined);
  await err(await local.fetch('/api/admin/leaderboards','POST',definition({leaderboard_id:b.leaderboard_id}),h.admin.headers),409,'LEADERBOARD_EXISTS');
  assert.equal((await local.db.prepare("SELECT action FROM admin_audit_logs WHERE target_type='leaderboard' AND target_id=?").bind(b.leaderboard_id).first()).action,'leaderboard_create');
});
for (const [name,change] of [
  ['top zero',{top_n:0}],['top large',{top_n:101}],['top fractional',{top_n:1.5}],['top string',{top_n:'10'}],
  ['bad id',{leaderboard_id:'../bad'}],['long id',{leaderboard_id:'x'.repeat(101)}],['name empty',{name:''}],['name long',{name:'x'.repeat(101)}],
  ['type',{type:'magic'}],['boolean',{is_public:1}],['vote type',{vote_type:'other'}],['status',{status:'closed'}],['archived create',{status:'archived'}],
  ['campaign missing',{type:'campaign'}],['all-time campaign',{campaign_id:'C-local'}],['all-time dates',{start_date:'2026-01-01'}],
  ['custom dates missing',{type:'custom'}],['invalid day',{type:'custom',start_date:'2026-02-30',end_date:'2026-03-01'}],
  ['reverse dates',{type:'custom',start_date:'2026-02-02',end_date:'2026-02-01'}],['client actor',{created_by:'forged'}],['client result',{points:100}],
]) test('Definition rejects '+name,async () => { await err(await local.fetch('/api/admin/leaderboards','POST',definition(change),h.admin.headers),400,'INVALID_LEADERBOARD_REQUEST'); });
test('Campaign FK validation, archived campaign cannot acquire new scope',async () => {
  await err(await local.fetch('/api/admin/leaderboards','POST',definition({type:'campaign',campaign_id:'MISSING'}),h.admin.headers),400,'INVALID_CAMPAIGN');
  const c = await h.campaign({status:'archived'});
  await err(await local.fetch('/api/admin/leaderboards','POST',definition({type:'campaign',campaign_id:c}),h.admin.headers),409,'LEADERBOARD_CONFLICT');
});
test('Definition CAS protects concurrent updates; mutations invalidate current snapshot',async () => {
  const b = await h.create(); await publish(b); const row = await current(b);
  const r = await Promise.all([h.update(row,{name:'A'}),h.update(row,{name:'B'})]); assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);
  assert.equal((await current(b)).current_run_id,null); assert.equal(await h.snapshot(b),undefined);
});
test('Archive preserves historical run for admin, hides public and is immutable',async () => {
  const b = await h.create(); const run = await publish(b), row = await current(b);
  assert.equal((await h.update(row,{status:'archived'})).status,200);
  assert.equal((await current(b)).current_run_id,run.run_id); assert.equal(await h.snapshot(b),undefined);
  assert.ok(await h.snapshot(b,true)); const archived = await current(b);
  await err(await h.update(archived,{name:'change'}),409,'LEADERBOARD_CONFLICT');
  await err(await h.rebuild(archived),409,'LEADERBOARD_CONFLICT');
  await assert.rejects(local.db.prepare('DELETE FROM leaderboards WHERE leaderboard_id=?').bind(b.leaderboard_id).run());
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
  const board = await h.create({type:'campaign',campaign_id:c}); await publish(board);
  const rankings = (await h.snapshot(board)).rankings;
  const tie = [d.memberId,e.memberId].sort(); assert.deepEqual(rankings.map(r=>r.member_id),[f.memberId,b.memberId,...tie,a.memberId]);
  assert.deepEqual(rankings.map(r=>r.rank),[1,2,3,4,5]); assert.equal(rankings[1].proof_count,2);
});
test('Reached_at resets after leaving final pair: positive/negative adjustment oscillations',async () => {
  const m = await h.identity();
  await h.adjust(m,10,at(1)); await h.adjust(m,5,at(2)); await h.adjust(m,-5,at(3));
  const b = await h.create(); await publish(b);
  const row = (await h.snapshot(b)).rankings.find(r=>r.member_id===m.memberId);
  assert.equal(row.points,10); assert.equal(row.proof_count,0); assert.equal(row.reached_at,at(3));
});
test('Reached_at tracks the pair, not MIN/MAX positive award or first equal points',async () => {
  const m = await h.identity(), c = await h.campaign();
  await fixtureProof(m,c,10,at(1)); const second = await fixtureProof(m,c,10,at(2)); await fixtureRevoke(second,at(4));
  const b = await h.create({type:'campaign',campaign_id:c}); await publish(b); const row = (await h.snapshot(b)).rankings[0];
  assert.equal(row.points,10); assert.equal(row.proof_count,1); assert.equal(row.reached_at,at(4));
});
test('Same timestamp chronology gives original award precedence over reversal',async () => {
  const m = await h.identity(), c = await h.campaign(); const p = await fixtureProof(m,c,10,at(1));
  await fixtureProof(m,c,10,at(1)); await fixtureRevoke(p,at(1));
  const b = await h.create({type:'campaign',campaign_id:c}); await publish(b); const row = (await h.snapshot(b)).rankings[0];
  assert.equal(row.proof_count,1); assert.equal(row.reached_at,at(1));
});
test('Completed never adds activity; revoke nets zero and zero/negative/inactive members are absent',async () => {
  const m = await h.identity(), zero = await h.identity(), negative = await h.identity(), empty = await h.identity(), c = await h.campaign();
  const p = await h.award(m,c); assert.equal((await h.review(h.admin,p.case_id,'complete',1)).status,200);
  let b = await h.create({type:'campaign',campaign_id:c}); await publish(b); assert.equal((await h.snapshot(b)).rankings[0].proof_count,1);
  assert.equal((await h.review(h.admin,p.case_id,'revoke',2,{reason:'Local correction'})).status,200);
  await h.adjust(zero,10,at(1)); await h.adjust(zero,-10,at(2)); await h.adjust(negative,-10,at(1));
  await h.adjust(m,3,at(5)); await local.db.prepare("UPDATE members SET status='suspended' WHERE member_id=?").bind(m.memberId).run();
  b = await h.create(); await publish(b); const ids = (await h.snapshot(b)).rankings.map(r=>r.member_id);
  for (const person of [m,zero,negative,empty]) assert.equal(ids.includes(person.memberId),false);
});
test('Campaign/Solo/團體/custom vote_date filtering; unscoped manual points only all-time',async () => {
  const m = await h.identity(), c = await h.campaign(), other = await h.campaign();
  await fixtureProof(m,c,10,at(1),{vote_type:'Solo',vote_date:'2026-10-01'});
  await fixtureProof(m,c,20,at(2),{vote_type:'團體',vote_date:'2026-10-02'});
  await fixtureProof(m,other,30,at(3),{vote_type:'Solo',vote_date:'2026-10-03'}); await h.adjust(m,7,at(4));
  for (const [scope,points,count] of [[{type:'campaign',campaign_id:c},30,2],[{type:'campaign',campaign_id:c,vote_type:'Solo'},10,1],
    [{type:'campaign',campaign_id:c,vote_type:'團體'},20,1],[{vote_type:'Solo'},40,2],
    [{type:'custom',start_date:'2026-10-02',end_date:'2026-10-02',campaign_id:c},20,1],
    [{type:'custom',start_date:'2026-10-01',end_date:'2026-10-03'},60,3]]) {
    const b = await h.create(scope); await publish(b); const row = (await h.snapshot(b)).rankings.find(r=>r.member_id===m.memberId);
    assert.equal(row.points,points); assert.equal(row.proof_count,count);
  }
  const b = await h.create(); await publish(b); assert.equal((await h.snapshot(b)).rankings.find(r=>r.member_id===m.memberId).points,67);
});
test('Custom uses vote_date inclusive calendar boundaries, not UTC review/created time',async () => {
  const c = await h.campaign({campaign_timezone:'Asia/Taipei'}), m = await h.identity();
  await fixtureProof(m,c,10,'2026-10-02T23:59:59.999Z',{vote_date:'2026-10-01'});
  await fixtureProof(m,c,20,'2026-10-01T00:00:00.000Z',{vote_date:'2026-10-02'});
  const b = await h.create({type:'custom',campaign_id:c,start_date:'2026-10-01',end_date:'2026-10-01'}); await publish(b);
  assert.equal((await h.snapshot(b)).rankings[0].points,10);
});
test('Nickname snapshot and ledger source survive profile/snapshot-field changes until rebuild',async () => {
  const c = await h.campaign(), m = await h.identity(); await fixtureProof(m,c,10,at(1));
  const b = await h.create({type:'campaign',campaign_id:c}); const run = await publish(b); const initial = await h.snapshot(b);
  await local.db.prepare("UPDATE members SET nickname='New nickname' WHERE member_id=?").bind(m.memberId).run();
  await local.db.prepare('UPDATE cases SET points_awarded=999 WHERE member_id=?').bind(m.memberId).run();
  assert.deepEqual(await h.snapshot(b),initial); await publish(await current(b));
  assert.equal((await h.snapshot(b)).rankings[0].nickname,'New nickname'); assert.equal((await h.snapshot(b)).rankings[0].points,10);
  assert.equal((await local.db.prepare('SELECT nickname FROM leaderboard_results WHERE run_id=?').bind(run.run_id).first()).nickname,initial.rankings[0].nickname);
});
test('Top N, empty published run, run/results immutable with composite FK/publish validation',async () => {
  const c = await h.campaign(); for (let i=1;i<=4;i++) await fixtureProof(await h.identity(),c,i,at(i));
  const b = await h.create({type:'campaign',campaign_id:c,top_n:2}), r = await publish(b);
  assert.equal(r.row_count,2); assert.deepEqual((await h.snapshot(b)).rankings.map(x=>x.points),[4,3]);
  for (const sql of ["UPDATE leaderboard_results SET points=1 WHERE run_id=?","DELETE FROM leaderboard_results WHERE run_id=?",
    "UPDATE leaderboard_runs SET row_count=0 WHERE run_id=?","DELETE FROM leaderboard_runs WHERE run_id=?",
    "INSERT OR REPLACE INTO leaderboard_results SELECT * FROM leaderboard_results WHERE run_id=?"]) await assert.rejects(local.db.prepare(sql).bind(r.run_id).run());
  await assert.rejects(local.db.prepare('UPDATE leaderboards SET current_run_id=? WHERE leaderboard_id=?').bind(randomUUID(),b.leaderboard_id).run());
  const empty = await h.create({type:'campaign',campaign_id:await h.campaign()}); const e = await publish(empty);
  assert.equal(e.row_count,0); assert.deepEqual((await h.snapshot(empty)).rankings,[]);
});
test('Public reads only current successful active public run and safe B1-compatible fields',async () => {
  for (const extra of [{is_public:false},{status:'draft'}]) { const b = await h.create(extra); await publish(b); assert.equal(await h.snapshot(b),undefined); assert.ok(await h.snapshot(b,true)); }
  const b = await h.create(); await publish(b); const response = await local.fetch('/api/leaderboards?id='+b.leaderboard_id);
  assert.equal(response.headers.get('cache-control'),'public, max-age=15, must-revalidate'); const json = await response.json();
  assert.deepEqual(Object.keys(json.data).sort(),['generated_at','leaderboards']); const board = json.data.leaderboards[0];
  assert.deepEqual(Object.keys(board).sort(),['generated_at','leaderboard_id','name','rankings']);
  for (const row of board.rankings) assert.deepEqual(Object.keys(row).sort(),['member_id','nickname','points','proof_count','rank','reached_at']);
  assert.equal(/email|player_id|token|hash|object_key|run_id|created_by/.test(JSON.stringify(json)),false);
  assert.deepEqual((await (await local.fetch('/api/leaderboards?id=missing')).json()).data.leaderboards,[]);
});
test('No Apps Script dependency, empty registry and sanitized D1 failure',async t => {
  t.mock.method(globalThis,'fetch',()=>assert.fail('must not fetch Google'));
  const db = {prepare(sql) { assert.equal(sql.includes('point_transactions'),false); return {bind(){return {all:async()=>({results:[]})}}};}};
  const r = await worker.fetch(new Request('https://voteproof.example/api/leaderboards'),{DB:db,GOOGLE_PUBLIC_API_URL:'https://example.invalid/unused'});
  assert.deepEqual(await r.json(),{ok:true,data:{generated_at:null,leaderboards:[]}});
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
test('Concurrent ledger append gives one coherent run boundary, never mixed totals/history',async () => {
  const m = await h.identity(), b = await h.create(); await h.adjust(m,10,at(1));
  await Promise.all([publish(b),h.adjust(m,5,at(2))]);
  const r = (await h.snapshot(b)).rankings.find(x=>x.member_id===m.memberId); assert.ok([10,15].includes(r.points));
  assert.equal(r.reached_at,r.points===10 ? at(1) : at(2));
  await publish(await current(b)); assert.equal((await h.snapshot(b)).rankings.find(x=>x.member_id===m.memberId).points,15);
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
  const b = await h.create({type:'campaign',campaign_id:c}); await publish(b);
  await local.db.prepare("UPDATE campaigns SET status='closed' WHERE campaign_id=?").bind(c).run();
  await local.db.prepare("UPDATE campaigns SET status='archived' WHERE campaign_id=?").bind(c).run();
  await publish(await current(b)); assert.equal((await h.snapshot(b)).rankings[0].points,10);
  await err(await h.update(await current(b),{type:'all_time',campaign_id:null}),409,'LEADERBOARD_CONFLICT');
});
test('Integrity error fails rebuild instead of clamping negative proof history',async () => {
  const c = await h.campaign(), m = await h.identity(); const p = await fixtureProof(m,c,10,at(2));
  const b = await h.create({type:'campaign',campaign_id:c}); await publish(b); const previous = await h.snapshot(b);
  await fixtureRevoke(p,at(1));
  await err(await h.rebuild(await current(b)),503,'LEADERBOARD_REBUILD_FAILED'); assert.deepEqual(await h.snapshot(b),previous);
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
