import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localAdminRuntime } from '../scripts/lib/local-admin-runtime.mjs';
import { localCaseRuntime } from '../scripts/lib/local-case-runtime.mjs';
import { configureLocalTiers,localTierRows } from '../scripts/lib/local-tier-fixture.mjs';
import { TIER_IDENTITIES,resolveMemberTier,tierConfigurationReady,memberPointTier,updateMemberTier,tierUpdateInput } from '../src/lib/member-tier.js';
import { adminIdentity } from '../src/lib/admin-identity.js';
import { definition } from '../scripts/lib/local-leaderboard-runtime.mjs';
let h,local,admin,reviewer;
before(async()=>{h=await localAdminRuntime(); local=h.local; admin=await h.identity({role:'admin'}); reviewer=await h.identity({role:'reviewer'});});
after(async()=>{await local?.runtime.dispose();});
const list = async()=> (await (await local.fetch('/api/admin/member-tiers','GET',undefined,admin.headers)).json()).data;
const row = async id=>(await list()).tiers.find(t=>t.tier_id===id);
const edit = (tier,extra={},actor=admin)=>local.fetch('/api/admin/member-tiers/'+tier.tier_id+'/update','POST',
  {min_points:tier.min_points,status:tier.status,expected_version:tier.version,reason:'Local tier policy',...extra},actor.headers);
async function error(response,status,code){assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();assert.equal(body.error.code,code);return body;}
const points = async member=>(await (await local.fetch('/api/me/points','GET',undefined,member.headers)).json()).data;
const adjust = (member,value)=>local.fetch('/api/admin/points/adjustments','POST',{member_id:member.memberId,points:value,reason:'Local tier fixture'},
  {...admin.headers,'Idempotency-Key':randomUUID()});

test('Migration seeds exact eight immutable identities and only normal approved threshold',async()=>{
  const data=await list(); assert.equal(data.configuration_ready,false); assert.equal(data.tiers.length,8);
  assert.deepEqual(data.tiers.map(r=>r.tier_id),TIER_IDENTITIES.map(r=>r.tier_id));
  assert.deepEqual(data.tiers.map(r=>r.name),['普通','青銅','白銀','黃金','白金','翡翠','鑽石','星耀']);
  assert.deepEqual(data.tiers.map(r=>r.min_points),[0,null,null,null,null,null,null,null]);
  assert.equal(data.tiers[0].status,'active'); assert.ok(data.tiers.slice(1).every(r=>r.status==='disabled'));
  const m=await h.identity(); assert.equal((await points(m)).tier.tier_id,'normal'); assert.equal((await points(m)).tier_configuration_ready,false);
});
test('Partial config stays safe normal; admin update is actor-bound, audited and local configuration completes explicitly',async()=>{
  const bronze=await row('bronze'); const r=await edit(bronze,{min_points:100,status:'active'}); assert.equal(r.status,200);
  const updated=(await r.json()).data; assert.equal(updated.updated_by,admin.memberId); assert.equal(updated.version,1); assert.equal(updated.last_mutation_id,undefined);
  const audit=await local.db.prepare("SELECT * FROM admin_audit_logs WHERE target_type='member_tier' AND target_id='bronze'").first();
  assert.equal(audit.action,'member_tier_update'); assert.equal(audit.admin_member_id,admin.memberId); assert.equal(JSON.parse(audit.before_json).min_points,null); assert.equal(JSON.parse(audit.after_json).min_points,100);
  const m=await h.identity(); assert.equal((await adjust(m,10000)).status,201); assert.equal((await points(m)).tier.tier_id,'normal');
  await configureLocalTiers(local,admin); assert.equal((await list()).configuration_ready,true); assert.equal((await points(m)).tier.tier_id,'diamond');
});
for (const [total,tier,next,deficit,progress] of [
  [0,'normal','bronze',100,0],[99,'normal','bronze',1,99],[100,'bronze','silver',400,0],[300,'bronze','silver',200,50],
  [500,'silver','gold',500,0],[1000,'gold','platinum',1000,0],[2000,'platinum','emerald',3000,0],
  [5000,'emerald','diamond',5000,0],[10000,'diamond','stellar',10000,0],[20000,'stellar',null,0,100],
  [50000,'stellar',null,0,100],[-100,'normal','bronze',200,0],
]) test('Resolution/progress at '+total,()=>{
  const r=resolveMemberTier(total,localTierRows()); assert.equal(r.tier.tier_id,tier); assert.equal(r.next_tier?.tier_id??null,next);
  assert.equal(r.points_to_next_tier,deficit); assert.equal(r.tier_progress,progress); assert.equal(r.tier_configuration_ready,true);
});
test('Progress is bounded and precise; negative safe integer deficit never produces unsafe numeric value',()=>{
  for(let p=-3;p<=22000;p+=137){const r=resolveMemberTier(p,localTierRows());assert.ok(r.tier_progress>=0&&r.tier_progress<=100);assert.ok(Number.isSafeInteger(r.points_to_next_tier));}
  const r=resolveMemberTier(-Number.MAX_SAFE_INTEGER,localTierRows()); assert.equal(r.points_to_next_tier,Number.MAX_SAFE_INTEGER); assert.equal(r.tier_progress,0);
  assert.throws(()=>resolveMemberTier(Infinity,localTierRows()),e=>e.code==='POINT_SUMMARY_UNAVAILABLE');
});
for(const [name,mutate] of [
  ['missing normal',r=>r.slice(1)],['unconfigured',r=>{r[2].min_points=null;return r;}],['wrong normal',r=>{r[0].min_points=1;return r;}],
  ['duplicate order',r=>{r[1].rank_order=1;return r;}],['inverted threshold',r=>{r[1].min_points=900;return r;}],['disabled normal',r=>{r[0].status='disabled';return r;}],
]) test('Malformed/not-ready definitions safely fallback: '+name,()=>{
  const rows=mutate(localTierRows()); assert.equal(tierConfigurationReady(rows),false);
  const result=resolveMemberTier(50000,rows); assert.equal(result.tier.tier_id,'normal'); assert.equal(result.tier_configuration_ready,false); assert.equal(result.next_tier,null); assert.equal(result.tier_progress,0);
});
test('Disabled tiers retain thresholds but are skipped; highest active tier has terminal progress',()=>{
  const rows=localTierRows();rows[1].status='disabled'; const r=resolveMemberTier(100,rows);
  assert.equal(r.tier.tier_id,'normal');assert.equal(r.next_tier.tier_id,'silver');assert.equal(r.tier_progress,20);
  rows[7].status='disabled';const max=resolveMemberTier(30000,rows);assert.equal(max.tier.tier_id,'diamond');assert.equal(max.next_tier,null);assert.equal(max.tier_progress,100);
});
for (const [name,extra] of [
  ['negative threshold',{min_points:-1}],['fractional',{min_points:100.5}],['numeric string',{min_points:'100'}],['oversize',{min_points:1000000001}],
  ['null threshold',{min_points:null}],['empty reason',{reason:''}],['long reason',{reason:'x'.repeat(501)}],['control reason',{reason:'bad\n'}],
  ['invalid status',{status:'archived'}],['invalid version',{expected_version:-1}],['identity',{tier_id:'stellar'}],['rank order',{rank_order:8}],
  ['name',{name:'other'}],['icon',{icon_key:'other'}],['direct assignment',{member_id:'forged'}],
]) test('Tier update rejects '+name,async()=>{await error(await edit(await row('bronze'),extra),400,'INVALID_TIER_REQUEST');});
test('Normal must stay active/zero; duplicate and out-of-order thresholds rejected',async()=>{
  await error(await edit(await row('normal'),{min_points:1}),409,'TIER_CONFIG_CONFLICT');
  await error(await edit(await row('normal'),{status:'disabled'}),409,'TIER_CONFIG_CONFLICT');
  await error(await edit(await row('bronze'),{min_points:500}),409,'TIER_CONFIG_CONFLICT');
  await error(await edit(await row('bronze'),{min_points:501}),409,'TIER_CONFIG_CONFLICT');
  await error(await edit(await row('silver'),{min_points:99}),409,'TIER_CONFIG_CONFLICT');
});
test('DB constraints prevent ninth tier, identity changes, REPLACE/DELETE, duplicates and reversed ordering',async()=>{
  for(const sql of ["UPDATE member_tiers SET tier_id='ninth' WHERE tier_id='bronze'","UPDATE member_tiers SET name='fake' WHERE tier_id='bronze'",
    "UPDATE member_tiers SET icon_key='fake' WHERE tier_id='bronze'","UPDATE member_tiers SET rank_order=8 WHERE tier_id='bronze'",
    "UPDATE member_tiers SET min_points=500 WHERE tier_id='bronze'","UPDATE member_tiers SET min_points=501 WHERE tier_id='bronze'",
    "UPDATE member_tiers SET min_points=1 WHERE tier_id='normal'","UPDATE member_tiers SET status='disabled' WHERE tier_id='normal'",
    "DELETE FROM member_tiers WHERE tier_id='normal'","INSERT OR REPLACE INTO member_tiers SELECT * FROM member_tiers WHERE tier_id='bronze'",
    "INSERT INTO member_tiers(tier_id,name,rank_order,min_points,icon_key,status,created_at,updated_at) VALUES('ninth','九',9,99999,'ninth','active','now','now')"])
    await assert.rejects(local.db.prepare(sql).run());
  assert.equal((await list()).tiers.length,8);
});
test('RBAC denies reviewer/member/Guest, suspended/expired admin; super_admin allowed',async()=>{
  const bronze=await row('bronze'), member=await h.identity();
  for(const a of [reviewer,member]){await error(await edit(bronze,{},a),403,'ADMIN_FORBIDDEN');assert.equal((await local.fetch('/api/admin/member-tiers','GET',undefined,a.headers)).status,403);}
  assert.equal((await local.fetch('/api/admin/member-tiers')).status,401);
  const suspended=await h.identity({role:'admin',status:'suspended'}), expired=await h.identity({role:'admin',expired:true});
  assert.equal((await edit(bronze,{},suspended)).status,403);assert.equal((await edit(bronze,{},expired)).status,401);
  const superAdmin=await h.identity({role:'super_admin'});assert.equal((await edit(bronze,{},superAdmin)).status,200);
});
test('CSRF/Origin/body/method bounds and no arbitrary tier assignment routes',async()=>{
  const bronze=await row('bronze');for(const headers of [{...admin.headers,Origin:'https://evil.example'},{...admin.headers,'X-CSRF-Token':''}]){
    const r=await local.fetch('/api/admin/member-tiers/bronze/update','POST',{min_points:100,status:'active',expected_version:bronze.version,reason:'local'},headers);assert.equal(r.status,403);}
  assert.equal((await local.fetch('/api/admin/member-tiers/bronze/update','POST','x'.repeat(17000),admin.headers)).status,413);
  assert.equal((await local.fetch('/api/admin/member-tiers/bronze/update','POST','{bad',admin.headers)).status,400);
  assert.equal((await local.fetch('/api/admin/member-tiers/bronze/update','GET',undefined,admin.headers)).status,405);
  assert.equal((await local.fetch('/api/admin/member-tiers','POST',{},admin.headers)).status,405);
  await error(await local.fetch('/api/admin/member-tiers/ninth/update','POST',{min_points:1,status:'active',expected_version:0,reason:'local'},admin.headers),404,'TIER_NOT_FOUND');
  assert.equal((await local.fetch('/api/admin/members/anything/tier','POST',{tier_id:'stellar'},admin.headers)).status,404);
});
test('Same-row concurrent updates have one winner; stale version returns 409',async()=>{
  const bronze=await row('bronze');const responses=await Promise.all([edit(bronze,{min_points:110}),edit(bronze,{min_points:120})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  await error(await edit(bronze),409,'TIER_CONFIG_CONFLICT');assert.equal((await edit(await row('bronze'),{min_points:100})).status,200);
});
test('Different-row concurrent crossing edits cannot invert global ordering',async()=>{
  const bronze=await row('bronze'),silver=await row('silver');
  const responses=await Promise.all([edit(bronze,{min_points:450}),edit(silver,{min_points:200})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal((await list()).configuration_ready,true);
  // Restore in valid order regardless of race winner.
  assert.equal((await edit(await row('bronze'),{min_points:100})).status,200);assert.equal((await edit(await row('silver'),{min_points:500})).status,200);
});
test('Disabled tier still participates in ordering; re-enable cannot break hierarchy',async()=>{
  assert.equal((await edit(await row('silver'),{status:'disabled'})).status,200);
  await error(await edit(await row('bronze'),{min_points:600}),409,'TIER_CONFIG_CONFLICT');
  assert.equal((await edit(await row('silver'),{status:'active'})).status,200);
});
test('Audit failure rolls back threshold/version and preserves ledger',async()=>{
  const before=await row('bronze'),ledger=(await local.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n;
  await local.db.prepare("CREATE TRIGGER local_tier_failure BEFORE INSERT ON admin_audit_logs WHEN NEW.action='member_tier_update' BEGIN SELECT RAISE(ABORT,'local failure'); END").run();
  try{await error(await edit(before,{min_points:101}),503,'TIER_SERVICE_UNAVAILABLE');}finally{await local.db.prepare('DROP TRIGGER local_tier_failure').run();}
  assert.deepEqual(await row('bronze'),before);assert.equal((await local.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,ledger);
});
test('Membership revocation after verified actor read is rechecked inside mutation batch',async()=>{
  const actor=await adminIdentity(new Request('https://voteproof.example',{headers:admin.headers}),{DB:local.db}),bronze=await row('bronze');
  await local.db.prepare("UPDATE admin_memberships SET status='disabled' WHERE member_id=?").bind(admin.memberId).run();
  try{await assert.rejects(updateMemberTier(local.db,actor,'bronze',tierUpdateInput({min_points:101,status:'active',expected_version:bronze.version,reason:'local'})),e=>e.code==='TIER_CONFIG_CONFLICT');}
  finally{await local.db.prepare("UPDATE admin_memberships SET status='active' WHERE member_id=?").bind(admin.memberId).run();}
  assert.equal((await row('bronze')).min_points,100);
});
test('Ledger award/completion/revoke and positive/negative adjustments dynamically promote/demote',async()=>{
  const m=await h.identity(),campaign='TC-'+randomUUID();await local.campaign({campaign_id:campaign,points_per_proof:100,daily_limit:1});
  const proof=await h.makeCase({member:m,metadata:{campaign_id:campaign}});assert.equal((await h.review(reviewer,proof.case_id,'approve')).status,200);
  assert.equal((await points(m)).tier.tier_id,'bronze');assert.equal((await h.review(admin,proof.case_id,'complete',1)).status,200);assert.equal((await points(m)).total_points,100);
  assert.equal((await h.review(admin,proof.case_id,'revoke',2,{reason:'Local correction'})).status,200);assert.equal((await points(m)).tier.tier_id,'normal');
  assert.equal((await adjust(m,500)).status,201);assert.equal((await points(m)).tier.tier_id,'silver');
  assert.equal((await adjust(m,-450)).status,201);assert.equal((await points(m)).tier.tier_id,'normal');assert.equal((await points(m)).total_points,50);
});
test('Threshold edits immediately recalculate current tier without rewriting point ledger or members',async()=>{
  const m=await h.identity();await adjust(m,100);assert.equal((await points(m)).tier.tier_id,'bronze');
  const ledger=(await local.db.prepare('SELECT * FROM point_transactions WHERE member_id=?').bind(m.memberId).all()).results;
  assert.equal((await edit(await row('bronze'),{min_points:150})).status,200);assert.equal((await points(m)).tier.tier_id,'normal');
  assert.deepEqual((await local.db.prepare('SELECT * FROM point_transactions WHERE member_id=?').bind(m.memberId).all()).results,ledger);
  assert.equal((await edit(await row('bronze'),{min_points:100})).status,200);
  const columns=(await local.db.prepare('PRAGMA table_info(members)').all()).results.map(r=>r.name);assert.equal(columns.includes('tier_id'),false);assert.equal(columns.includes('total_points'),false);
});
test('Member/admin summaries use same ledger+definition snapshot, safe fields and no-store; no N+1',async()=>{
  const m=await h.identity();await adjust(m,300);const memberResponse=await local.fetch('/api/me/points','GET',undefined,m.headers);
  const adminResponse=await local.fetch('/api/admin/members/'+m.memberId+'/points','GET',undefined,admin.headers);
  assert.equal(memberResponse.headers.get('cache-control'),'no-store');assert.equal(adminResponse.headers.get('cache-control'),'no-store');
  const data=(await memberResponse.json()).data;assert.deepEqual((await adminResponse.json()).data,data);assert.equal(data.tier_progress,50);assert.equal(data.next_tier.tier_id,'silver');
  assert.equal(/email|player_id|token|hash|admin_role|member_id|created_by/.test(JSON.stringify(data)),false);
  let queries=0;const db={prepare(sql){queries++;return local.db.prepare(sql);}};assert.deepEqual(await memberPointTier(db,m.memberId),data);assert.equal(queries,1);
  assert.equal((await local.fetch('/api/me/points')).status,401);
});
test('Stellar member has no administrative authorization; normal admin remains authorized',async()=>{
  const m=await h.identity();await adjust(m,20000);assert.equal((await points(m)).tier.tier_id,'stellar');
  assert.equal((await local.fetch('/api/admin/member-tiers','GET',undefined,m.headers)).status,403);
  assert.equal((await points(admin)).tier.tier_id,'normal');assert.equal((await local.fetch('/api/admin/member-tiers','GET',undefined,admin.headers)).status,200);
});
test('Leaderboard ranking/snapshots remain byte-equivalent after tier config changes; no badge N+1',async()=>{
  const body=definition(),created=await local.fetch('/api/admin/leaderboards','POST',body,admin.headers);assert.equal(created.status,201);
  assert.equal((await local.fetch('/api/admin/leaderboards/'+body.leaderboard_id+'/rebuild','POST',{expected_version:0},admin.headers)).status,200);
  const before=await (await local.fetch('/api/leaderboards?id='+body.leaderboard_id)).text();
  assert.equal((await edit(await row('bronze'),{min_points:101})).status,200);
  assert.equal(await (await local.fetch('/api/leaderboards?id='+body.leaderboard_id)).text(),before);
  assert.equal((await edit(await row('bronze'),{min_points:100})).status,200);
});
test('0007 preserves existing B5C audit/run while adding only identity seeds',async()=>{
  const member='M-'+randomUUID(),audit=randomUUID(),run=randomUUID();
  const sandbox=await localCaseRuntime({seedCampaign:false,migrationHook:async(db,name)=>{
    if(name!=='0006_leaderboards.sql')return;const now=new Date().toISOString();
    await db.batch([db.prepare(`INSERT INTO members(id,member_id,login_name,nickname,status,created_at,updated_at,last_login_at) VALUES(?,?,?,'Local','active',?,?,?)`).bind(randomUUID(),member,randomUUID().replaceAll('-',''),now,now,now),
      db.prepare(`INSERT INTO leaderboards(leaderboard_id,name,type,top_n,is_public,status,created_at,updated_at,created_by,updated_by)
        VALUES('LOCAL-UPGRADE','Local snapshot','all_time',10,1,'active',?,?,?,?)`).bind(now,now,member,member),
      db.prepare(`INSERT INTO leaderboard_runs(run_id,leaderboard_id,generated_at,definition_version,source_count,status,definition_json,integrity_errors)
        VALUES(?,'LOCAL-UPGRADE',?,0,0,'building','{}',0)`).bind(run,now),
      db.prepare("UPDATE leaderboard_runs SET status='success' WHERE run_id=?").bind(run),
      db.prepare("UPDATE leaderboards SET current_run_id=?,version=1 WHERE leaderboard_id='LOCAL-UPGRADE'").bind(run),
      db.prepare(`INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json) VALUES(?,?,?,'admin','leaderboard_create','leaderboard','LOCAL-UPGRADE',0,'{}','{}')`).bind(audit,now,member)]);
  }});
  try{assert.equal((await sandbox.db.prepare('SELECT id FROM admin_audit_logs WHERE id=?').bind(audit).first()).id,audit);
    assert.equal((await sandbox.db.prepare("SELECT current_run_id FROM leaderboards WHERE leaderboard_id='LOCAL-UPGRADE'").first()).current_run_id,run);
    assert.equal((await sandbox.db.prepare('SELECT status FROM leaderboard_runs WHERE run_id=?').bind(run).first()).status,'success');
    await assert.rejects(sandbox.db.prepare('DELETE FROM admin_audit_logs WHERE id=?').bind(audit).run());
    assert.equal((await sandbox.db.prepare('SELECT COUNT(*) n FROM member_tiers WHERE min_points IS NULL').first()).n,7);
    assert.deepEqual((await sandbox.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await sandbox.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
  }finally{await sandbox.runtime.dispose();}
});
