import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localLeaderboardRuntime} from '../scripts/lib/local-leaderboard-runtime.mjs';
import {publicLeaderboardData} from '../src/lib/public-leaderboards.js';
import {publishedBoards} from '../src/lib/leaderboard-store.js';
import {liveSystemBoards} from '../src/lib/system-leaderboards.js';
import {cachedPublicRanking,rankingCacheKey} from '../src/lib/public-ranking-cache.js';
import {getLeaderboards} from '../src/api/leaderboards.js';
import {measuredD1} from '../scripts/lib/measured-d1.mjs';
let h,local;
before(async()=>{h=await localLeaderboardRuntime();local=h.local;});
after(async()=>{await local?.runtime.dispose();});
const read=async id=>(await publicLeaderboardData(local.db,id)).leaderboards[0];
const memoryCache=()=>{const map=new Map();return {map,async match(key){return map.get(String(key))?.clone();},async put(key,response){map.set(String(key),response.clone());}};};

test('live system history/group/Solo preserve historical ranking/tier rules and aggregate distinct Solo targets',async()=>{
  const m=await h.identity(),solo=await h.campaign(),other=await h.campaign({solo_target:'yuqi'}),group=await h.campaign({category:'團體',solo_target:null});
  await h.award(m,solo);await h.award(m,other);await h.award(m,group,{vote_type:'團體'});await h.adjust(m,7);
  for(const [id,points]of [['system-history',37],['system-solo',20],['system-group',10]]){
    const board=await read(id),legacy=(await liveSystemBoards(local.db,id))[0];
    assert.deepEqual(board.rankings,legacy.rankings);
    assert.equal(board.rankings.find(r=>r.member_id===m.memberId).points,points);
  }
});
test('campaign/custom live scores need no run and match audited snapshot scopes, top_n and inclusive vote dates',async()=>{
  const m=await h.identity(),c=await h.campaign();await h.award(m,c);await h.adjust(m,99);
  for(const config of [{type:'campaign',campaign_id:c,top_n:1},{type:'custom',campaign_id:c,start_date:'2000-01-01',end_date:'2099-12-31',vote_type:'Solo',top_n:1}]){
    const b=await h.create(config),before=await read(b.leaderboard_id);assert.equal(before.rankings[0].points,10);
    assert.equal(await local.db.prepare('SELECT COUNT(*) n FROM leaderboard_runs WHERE leaderboard_id=?').bind(b.leaderboard_id).first('n'),0);
    assert.equal((await h.rebuild(b)).status,200);
    assert.deepEqual((await read(b.leaderboard_id)).rankings,(await publishedBoards(local.db,b.leaderboard_id,true)).leaderboards[0].rankings);
  }
  const excluded=await h.create({type:'custom',campaign_id:c,start_date:'2000-01-01',end_date:'2000-01-01'});
  assert.deepEqual((await read(excluded.leaderboard_id)).rankings,[]);
});
test('new approval, revoke and reapproval update campaign live scores without additional snapshot writes',async()=>{
  const c=await h.campaign(),m=await h.identity(),b=await h.create({type:'campaign',campaign_id:c});
  assert.deepEqual((await read(b.leaderboard_id)).rankings,[]);
  const proof=await h.award(m,c);assert.equal((await read(b.leaderboard_id)).rankings[0].points,10);
  assert.equal((await h.review(h.admin,proof.case_id,'revoke',1,{reason:'Synthetic correction'})).status,200);
  assert.deepEqual((await read(b.leaderboard_id)).rankings,[]);
  // Existing API deliberately does not restore revoked cases. Preserve that
  // policy; seed a valid historical reapproval only in this disposable fixture.
  assert.equal((await h.review(h.admin,proof.case_id,'approve',2)).status,409);
  const original=await local.db.prepare('SELECT * FROM point_transactions WHERE case_id=? AND category=\'proof_approved\'').bind(proof.id).first();
  await local.db.prepare("UPDATE cases SET status='approved' WHERE id=?").bind(proof.id).run();
  await local.db.prepare("INSERT INTO point_transactions(transaction_id,created_at,member_id,case_id,campaign_id,category,vote_type,vote_date,points,reason,created_by) VALUES(?,?,?,?,?,'proof_reapproved',?,?,?,'Historical reapproval fixture',?)")
    .bind(randomUUID(),new Date().toISOString(),m.memberId,proof.id,c,original.vote_type,original.vote_date,original.points,h.admin.memberId).run();
  const row=(await read(b.leaderboard_id)).rankings[0];assert.equal(row.points,10);assert.equal(row.proof_count,1);
  assert.equal(await local.db.prepare('SELECT COUNT(*) n FROM leaderboard_runs WHERE leaderboard_id=?').bind(b.leaderboard_id).first('n'),0);
});
test('approved anonymous case never enters member rankings or points',async()=>{
  const c=await h.campaign(),b=await h.create({type:'campaign',campaign_id:c}),guest=await h.makeCase({metadata:{campaign_id:c}});
  assert.equal((await h.review(h.admin,guest.case_id,'approve')).status,200);
  assert.deepEqual((await read(b.leaderboard_id)).rankings,[]);
  assert.equal(await local.db.prepare('SELECT COUNT(*) n FROM point_transactions WHERE case_id=?').bind(guest.id).first('n'),0);
});
test('shared score cache bounds nickname/suspension/restoration staleness and separates board/version/origin',async()=>{
  const c=await h.campaign(),m=await h.identity(),b=await h.create({type:'campaign',campaign_id:c});await h.award(m,c);
  const cache=memoryCache(),url=new URL('https://public.local/api/leaderboards'),definition=await read(b.leaderboard_id);let clock=1000,computations=0;
  const load=()=>cachedPublicRanking(local.db,url,definition,async()=>{computations++;return read(b.leaderboard_id);},{cache,now:()=>clock});
  const original=await load();assert.equal(original.cache_status,'MISS');assert.equal((await load()).cache_status,'HIT');assert.equal(computations,1);
  await local.db.prepare("UPDATE members SET nickname='Updated',status='suspended' WHERE member_id=?").bind(m.memberId).run();
  assert.equal((await load()).cache_status,'HIT');clock+=120000;
  assert.deepEqual((await load()).board.rankings,[]);
  await local.db.prepare("UPDATE members SET status='active' WHERE member_id=?").bind(m.memberId).run();clock+=120000;
  assert.equal((await load()).board.rankings[0].nickname,'Updated');
  assert.notEqual(rankingCacheKey(url,definition),rankingCacheKey(url,{...definition,version:definition.version+1}));
  assert.notEqual(rankingCacheKey(url,definition),rankingCacheKey(url,{...definition,leaderboard_id:'other'}));
  assert.notEqual(rankingCacheKey(url,definition),rankingCacheKey(new URL('https://other.local'),definition));
});
test('cache concurrent misses coalesce per isolate, failures are not stored and cache outage serves validated scores',async()=>{
  const cache=memoryCache(),db={},url=new URL('https://public.local'),b={leaderboard_id:'isolated',version:0};let calls=0,release;
  const gate=new Promise(r=>{release=r;}),compute=async()=>{calls++;await gate;return {rankings:[]};};
  const a=cachedPublicRanking(db,url,b,compute,{cache}),second=cachedPublicRanking(db,url,b,compute,{cache});
  await new Promise(r=>setImmediate(r));release();await Promise.all([a,second]);assert.equal(calls,1);
  const broken={async match(){throw Error('down');},async put(){throw Error('down');}};
  assert.equal((await cachedPublicRanking(db,url,b,async()=>({rankings:[]}),{cache:broken})).cache_status,'BYPASS');
  const fresh=memoryCache();await assert.rejects(cachedPublicRanking(db,url,b,async()=>{throw Error('no data');},{cache:fresh}));assert.equal(fresh.map.size,0);
});
test('catalog does not scan ledger; public GET is read-only, cached scores never authorize hidden or changed definitions',async()=>{
  const measured=measuredD1(local.db),catalog=await publicLeaderboardData(measured.db);
  assert.ok(catalog.leaderboards.every(b=>b.rankings.length===0));assert.equal(measured.totals().statements,1);assert.equal(measured.totals().rows_written,0);
  const c=await h.campaign(),m=await h.identity(),b=await h.create({type:'campaign',campaign_id:c});await h.award(m,c);
  const oldCaches=globalThis.caches;globalThis.caches={default:memoryCache()};
  try{
    const get=()=>getLeaderboards({DB:measured.db},new URL('https://public.local/api/leaderboards?id='+b.leaderboard_id));
    const first=await get();assert.equal(first.status,200);assert.equal(first.headers.get('X-Leaderboard-Cache'),'MISS');
    const beforeHit=measured.totals();assert.equal((await get()).headers.get('X-Leaderboard-Cache'),'HIT');
    const afterHit=measured.totals();assert.equal(afterHit.rows_read-beforeHit.rows_read,1);assert.equal(afterHit.statements-beforeHit.statements,1);
    const changed=(await (await h.update(b,{name:'Changed',top_n:1})).json()).data;
    const next=await get();assert.equal(next.headers.get('X-Leaderboard-Cache'),'MISS');assert.equal((await next.json()).data.leaderboards[0].name,'Changed');
    await h.update(changed,{is_public:false});assert.deepEqual((await (await get()).json()).data.leaderboards,[]);
    assert.equal(measured.totals().rows_written,0);
    for(const query of ['id=x&id=y','solo_target=miyeon','view=live&id=x&private=1','view=catalog&id=x','view=unknown'])assert.equal((await getLeaderboards({DB:local.db},new URL('https://public.local/api/leaderboards?'+query))).status,400);
  }finally{if(oldCaches===undefined)delete globalThis.caches;else globalThis.caches=oldCaches;}
});
test('isolated Worker native Cache API shares public scores with no session cookies',async()=>{
  const b=await h.create(),path='/api/leaderboards?id='+b.leaderboard_id;
  const first=await local.fetch(path),second=await local.fetch(path,'GET',undefined,h.admin.headers);
  assert.equal(first.headers.get('X-Leaderboard-Cache'),'MISS');assert.equal(second.headers.get('X-Leaderboard-Cache'),'HIT');
  assert.equal(second.headers.get('set-cookie'),null);assert.deepEqual(await first.json(),await second.json());
});
