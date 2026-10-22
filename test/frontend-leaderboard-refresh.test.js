import test from 'node:test';
import assert from 'node:assert/strict';
import {RankingClient,LeaderboardRefresher} from '../public/js/leaderboard-refresh.js';
const flush=()=>new Promise(r=>setImmediate(r));
function clock(){let time=0,id=0;const timers=new Map();return {timers,now:()=>time,setTimer(fn,delay){timers.set(++id,{fn,at:time+delay});return id;},clearTimer(id){timers.delete(id);},async advance(ms){const end=time+ms;for(;;){const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}time=end;await flush();}};}
test('all boards share 10-minute refresh, leave pauses, reentry uses fresh data and does not duplicate calls',async()=>{
  const c=clock();let calls=0;const r=new LeaderboardRefresher(async()=>{calls++;return true;},c);
  r.enter(true);r.enter(true);await flush();assert.equal(calls,1);
  await c.advance(599999);assert.equal(calls,1);await c.advance(1);assert.equal(calls,2);
  r.enter(false);assert.equal(c.timers.size,0);await c.advance(600000);assert.equal(calls,2);
  r.enter(true);r.enter(true);await flush();assert.equal(calls,3);r.enter(false);
});
test('hidden page pauses, visible resumes only when overdue, and in-flight calls never overlap',async()=>{
  const c=clock();let calls=0,release;const r=new LeaderboardRefresher(async()=>{calls++;if(calls===2)await new Promise(done=>{release=done;});return true;},c);
  r.enter(true);await flush();r.visibility(false);await c.advance(300000);r.visibility(true);await flush();assert.equal(calls,1);
  r.visibility(false);await c.advance(400000);r.visibility(true);r.visibility(true);await flush();
  assert.equal(calls,2);const pending=r.refresh();assert.equal(pending,r.promise);release();await pending;assert.equal(calls,2);r.enter(false);
});
test('failed/synchronous refresh preserves last success, retries are bounded and timers stop',async()=>{
  const c=clock();let fail=false,calls=0;const r=new LeaderboardRefresher(()=>{calls++;if(fail)throw Error('offline');return true;},c);
  r.enter(true);await flush();fail=true;await c.advance(600000);assert.equal(r.lastSuccess,0);assert.equal(calls,2);
  await c.advance(599999);assert.equal(calls,2);await c.advance(1);assert.equal(calls,3);r.enter(false);assert.equal(c.timers.size,0);
});
test('client shares concurrent reads, separates catalog and board IDs, expires server-aged data without TTL extension',async()=>{
  let now=120000,calls=[];
  const client=new RankingClient(async path=>{calls.push(path);await flush();return {leaderboards:[],refreshed_at:new Date(now-119000).toISOString()};},()=>now);
  await Promise.all([client.get('one'),client.get('one')]);assert.equal(calls.length,1);
  await client.get('one');assert.equal(calls.length,1);now+=1001;await client.get('one');assert.equal(calls.length,2);
  await client.get();await client.get('catalog');assert.deepEqual(calls.slice(-2),['/api/leaderboards?view=catalog','/api/leaderboards?id=catalog&view=live']);
});
