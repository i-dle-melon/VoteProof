import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {rankingCte,INTEGRITY_SQL} from '../src/lib/leaderboard-ranking.js';
import {liveBoardRanking} from '../src/lib/public-leaderboards.js';
import {createTierResolver,resolveMemberTier} from '../src/lib/member-tier.js';
import {localTierRows} from '../scripts/lib/local-tier-fixture.mjs';

// Deliberately retains the ORIGINAL snapshot CTE as an independent oracle for
// the optimized live CTE. No Production resources, migrations or credentials.
let runtime,db;
const base={leaderboard_id:'system-history',type:'all_time',campaign_id:null,vote_type:null,top_n:100,version:0};
const scopes=[base,{...base,leaderboard_id:'system-group',vote_type:'團體'},
  {...base,leaderboard_id:'system-solo',vote_type:'Solo'},
  {...base,leaderboard_id:'campaign',type:'campaign',campaign_id:'C'},
  {...base,leaderboard_id:'custom',type:'custom',start_date:'2026-01-02',end_date:'2026-01-03'},
  {...base,leaderboard_id:'combined',type:'custom',campaign_id:'C',vote_type:'Solo',start_date:'2026-01-01',end_date:'2026-01-04'}];
before(async()=>{
  runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default{fetch(){return new Response("local")}}',compatibilityDate:'2026-10-07',d1Databases:['DB']}));
  db=await runtime.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE members(member_id TEXT PRIMARY KEY,nickname TEXT,player_id TEXT,status TEXT)'),
    db.prepare('CREATE TABLE point_transactions(transaction_id TEXT PRIMARY KEY,member_id TEXT,points INTEGER,category TEXT,created_at TEXT,campaign_id TEXT,vote_type TEXT,vote_date TEXT)'),
    db.prepare('CREATE INDEX ledger_member ON point_transactions(member_id,created_at,transaction_id)'),
    db.prepare('CREATE TABLE member_tiers(tier_id TEXT,name TEXT,icon_key TEXT,rank_order INTEGER,min_points INTEGER,status TEXT)'),
  ]);
});
after(async()=>{await runtime?.dispose();});
beforeEach(async()=>{
  await db.batch(['DELETE FROM point_transactions','DELETE FROM members','DELETE FROM member_tiers'].map(q=>db.prepare(q)));
  await db.batch(localTierRows().map(r=>db.prepare('INSERT INTO member_tiers VALUES(?,?,?,?,?,?)').bind(r.tier_id,r.name,r.icon_key,r.rank_order,r.min_points,r.status)));
});
const member=(id,status='active')=>db.prepare('INSERT INTO members VALUES(?,?,?,?)').bind(id,'Nick '+id,'fan_'+id,status).run();
let serial=0;
async function tx(id,points,category='manual_adjustment',step=serial++,extra={}){
  const r={transaction_id:'T'+String(serial++).padStart(8,'0'),created_at:new Date(Date.UTC(2026,0,1,0,0,step)).toISOString(),campaign_id:'C',vote_type:'Solo',vote_date:'2026-01-02',...extra};
  await db.prepare('INSERT INTO point_transactions VALUES(?,?,?,?,?,?,?,?)').bind(r.transaction_id,id,points,category,r.created_at,r.campaign_id,r.vote_type,r.vote_date).run();
}
async function reference(d){
  const where=[],args=[];
  if(d.campaign_id){where.push('t.campaign_id=?');args.push(d.campaign_id);}
  if(d.vote_type){where.push('t.vote_type=?');args.push(d.vote_type);}
  if(d.type==='custom'){where.push('t.vote_date BETWEEN ? AND ?');args.push(d.start_date,d.end_date);}
  const scope=`SELECT t.*,CASE WHEN category IN ('proof_approved','proof_reapproved') THEN 1 WHEN category='proof_revoked' THEN -1 ELSE 0 END proof_delta FROM point_transactions t ${where.length?'WHERE '+where.join(' AND '):''}`;
  const rows=(await db.prepare(`${rankingCte(scope)},meta AS(SELECT MAX(created_at) generated_at FROM scoped)
    SELECT r.*,m.player_id fan_id,meta.generated_at,${INTEGRITY_SQL} integrity_errors
    FROM meta LEFT JOIN ranked r ON r.rank<=? LEFT JOIN members m ON m.member_id=r.member_id ORDER BY r.rank`).bind(...args,d.top_n).all()).results;
  if(rows.some(r=>r.integrity_errors!==0))throw Error('integrity');
  const tiers=(await db.prepare('SELECT * FROM member_tiers ORDER BY rank_order').all()).results,rankings=[];
  for(const row of rows.filter(r=>r.member_id!==null)){
    const {generated_at,integrity_errors,...r}=row;
    const total=d.leaderboard_id==='system-history'?r.points:(await db.prepare('SELECT COALESCE(SUM(points),0) total FROM point_transactions WHERE member_id=?').bind(r.member_id).first('total'));
    const {tier,tier_configuration_ready}=resolveMemberTier(total,tiers);
    rankings.push({...r,tier:{tier_id:tier.tier_id,name:tier.name,icon_key:tier.icon_key},tier_configuration_ready});
  }
  return {...d,generated_at:rows[0]?.generated_at??null,rankings};
}
async function compare(definitions=scopes){
  for(const d of definitions)assert.deepEqual(await liveBoardRanking(db,d),await reference(d),JSON.stringify(d));
}

test('empty board and all supported scopes exactly match the original CTE',async()=>{await compare();});
test('final suffix, zero deltas, partial/full reversal, reapproval and negative adjustments preserve every ranking field',async()=>{
  for(const id of ['A','B','C','D','zero','negative','blocked'])await member(id,id==='blocked'?'suspended':'active');
  for(const id of ['A','B','C','D','blocked']){
    await tx(id,10,'proof_approved',1);await tx(id,10,'proof_approved',2);
    await tx(id,-10,'proof_revoked',3);await tx(id,5,'manual_adjustment',4);
    await tx(id,-5,'manual_adjustment',5);await tx(id,0,'manual_adjustment',6);
  }
  await tx('B',-10,'proof_revoked',7);await tx('B',10,'proof_reapproved',8);
  await tx('C',10,'proof_approved',9,{vote_type:'團體',campaign_id:'other',vote_date:'2026-01-04'});
  await tx('zero',10);await tx('zero',-10);await tx('negative',-50);
  await compare();
  const a=(await liveBoardRanking(db,base)).rankings.find(r=>r.member_id==='A');
  assert.equal(a.reached_at,'2026-01-01T00:00:05.000Z');assert.equal(a.proof_count,1);
});
test('equal timestamps use transaction ID and reversal precedence; late insertion/backfill and current profile remain equivalent',async()=>{
  for(const id of ['Z','A','B'])await member(id);
  for(const id of ['Z','A','B']){
    await tx(id,10,'proof_approved',10,{transaction_id:id+'-z'});
    await tx(id,-10,'proof_revoked',10,{transaction_id:id+'-a'});
    await tx(id,20,'proof_approved',10,{transaction_id:id+'-b'});
    await tx(id,5,'manual_adjustment',1,{transaction_id:id+'-late'});
  }
  await compare();
  assert.deepEqual((await liveBoardRanking(db,base)).rankings.map(r=>r.member_id),['A','B','Z']);
  await db.prepare("UPDATE members SET nickname='Renamed',player_id='fan_changed',status='suspended' WHERE member_id='A'").run();await compare();
  await db.prepare("UPDATE members SET status='active' WHERE member_id='A'").run();await compare();
});
test('seeded mixed histories, ties, top_n, scope and date boundaries shadow the original on exactly the same D1 rows',async()=>{
  let random=41023;const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
  const statements=[];
  for(let i=0;i<40;i++){
    const id='M'+i;await member(id,i%9===0?'suspended':'active');let proofs=0;
    for(let j=0;j<24;j++){
      const roll=next()%4,category=roll===0&&proofs>0?'proof_revoked':roll===1?'manual_adjustment':j%2?'proof_reapproved':'proof_approved';
      const points=category==='proof_revoked'?-10:category==='manual_adjustment'?(next()%11)-5:10;
      if(category==='proof_revoked')proofs--;else if(category!=='manual_adjustment')proofs++;
      // Every member has a stable scope so scoped proof prefixes stay valid.
      statements.push(db.prepare('INSERT INTO point_transactions VALUES(?,?,?,?,?,?,?,?)').bind(`R${i}-${j}`,id,points,category,new Date(Date.UTC(2026,0,1,0,0,Math.floor(j/2))).toISOString(),i%3?'C':'other',i%2?'Solo':'團體','2026-01-0'+(i%4+1)));
    }
  }
  await db.batch(statements);
  for(const top_n of [1,7,100])await compare(scopes.map(d=>({...d,top_n})));
});
for(const [label,points,category,created_at] of [
  ['negative proof prefix',-10,'proof_revoked','2026-01-01T00:00:00.000Z'],
  ['unsafe points',Number.MAX_SAFE_INTEGER+1,'manual_adjustment','2026-01-01T00:00:00.000Z'],
  ['fractional points',0.5,'manual_adjustment','2026-01-01T00:00:00.000Z'],
  ['malformed date',10,'manual_adjustment','not-an-iso-date'],
])for(const status of ['active','suspended'])test(`integrity fails closed: ${label}, ${status}, including zero/negative participants`,async()=>{
  await member('bad',status);await tx('bad',points,category,0,{created_at});
  await assert.rejects(reference(base));await assert.rejects(liveBoardRanking(db,base),e=>e.code==='LEADERBOARD_SERVICE_UNAVAILABLE');
});
test('negative prefix is checked even when final proof balance is zero and member cannot rank',async()=>{
  await member('bad','suspended');await tx('bad',-10,'proof_revoked',1);await tx('bad',10,'proof_approved',2);
  await assert.rejects(liveBoardRanking(db,base),e=>e.code==='LEADERBOARD_SERVICE_UNAVAILABLE');
});
test('one SQL snapshot, bounded public payload and no extra query after a concurrent append',async()=>{
  await member('A');await tx('A',10,'proof_approved',1);const expected=await reference(scopes[2]);let calls=0;
  const wrapped={prepare(sql){const prepared=db.prepare(sql);return{bind(...args){const bound=prepared.bind(...args);return{async all(){calls++;const result=await bound.all();await tx('A',100,'manual_adjustment',2);return result;}};}};}};
  const result=await liveBoardRanking(wrapped,scopes[2]);assert.equal(calls,1);assert.deepEqual(result,expected);
  assert.equal(JSON.stringify(result).includes('total_points'),false);await compare();
});
test('per-request reuse holds only configuration; balances, profile and tier edits are read fresh',async()=>{
  await member('A');await tx('A',10,'proof_approved',1);const context={tierResolvers:new Map()};
  await liveBoardRanking(db,scopes[2],context);assert.equal(context.tierResolvers.size,1);
  await tx('A',200,'manual_adjustment',2);await db.prepare("UPDATE members SET player_id='new_fan' WHERE member_id='A'").run();
  assert.deepEqual(await liveBoardRanking(db,scopes[2],context),await reference(scopes[2]));assert.equal(context.tierResolvers.size,1);
  await db.prepare("UPDATE member_tiers SET status='disabled' WHERE tier_id='bronze'").run();
  assert.deepEqual(await liveBoardRanking(db,scopes[2],context),await reference(scopes[2]));assert.equal(context.tierResolvers.size,2);
});
test('compiled tier policy copies inputs, returns independent objects and preserves safe integer checks',()=>{
  const rows=localTierRows(),resolve=createTierResolver(rows),before=resolve(150);
  rows[1].min_points=999;rows[1].status='disabled';assert.deepEqual(resolve(150),before);
  const first=resolve(150);first.tier.name='mutated';assert.deepEqual(resolve(150),before);
  for(const total of [NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>resolve(total),e=>e.code==='POINT_SUMMARY_UNAVAILABLE');
  for(const total of [-Number.MAX_SAFE_INTEGER,-100,0,99,100,500,20000,Number.MAX_SAFE_INTEGER])assert.deepEqual(createTierResolver(localTierRows())(total),resolveMemberTier(total,localTierRows()));
  assert.equal(createTierResolver([])(10).tier_configuration_ready,false);
});
