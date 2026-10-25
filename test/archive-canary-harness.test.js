import test from 'node:test';
import assert from 'node:assert/strict';
import {samplePlan,runPair,cpuReport,nativeTrace,ARCHIVE_PATH} from '../scripts/lib/archive-canary-harness.mjs';
import {isolatedConfig} from '../scripts/prepare-archive-canary-harness.mjs';
import {randomUUID} from 'node:crypto';
import {durableJournal} from '../scripts/run-archive-canary-harness.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const sample=samplePlan(1)[0];
const journal=()=>{let value;return{read:async()=>value,write:async v=>{value=v;},clear:async()=>{value=null;}};};
const a={state:'verification_ready',phase:'verify',mode:'live',retention_days:7,deleted:0,file_id:randomUUID()};a.handoff=a.file_id+'.'+randomUUID();
const b={state:'cold',phase:'delete',mode:'live',retention_days:7,deleted:1,file_id:a.file_id};
const reply=v=>({status:200,body:{ok:true,data:{cleanup:v}}});
test('bounded sample matrix has 15 pairs, no empty-body legacy requests',()=>{
  assert.equal(samplePlan().length,15);assert.deepEqual([...new Set(samplePlan().map(s=>s.mib))],[1,3,5]);
  for(const n of [0,6,1.5])assert.throws(()=>samplePlan(n));
});
test('controller journals before A and B, sends exact server handoff',async()=>{
  const j=journal(),calls=[];
  const result=await runPair(async(body,id)=>{assert.ok(await j.read());calls.push({body,id});return reply(body.handoff?b:a);},j,sample);
  assert.equal(result.state,'complete');assert.deepEqual(calls.map(c=>c.body),[{canary:true},{canary:true,handoff:a.handoff}]);assert.equal(await j.read(),null);
});
for(const phase of ['A','B'])test('lost '+phase+' ACK persists hold and blocks next controller run',async()=>{
  const j=journal();let calls=0;
  const post=async body=>{calls++;if(phase==='A'||body.handoff)throw Error('lost');return reply(a);};
  assert.equal((await runPair(post,j,sample)).state,'operator_hold');assert.ok(await j.read());
  const old=calls;assert.equal((await runPair(post,j,sample)).requests,0);assert.equal(calls,old);
});
test('bad A cannot trigger B or clear hold',async()=>{
  const j=journal();let n=0;assert.equal((await runPair(async()=>{n++;return reply({...a,handoff:'bad'});},j,sample)).state,'operator_hold');assert.equal(n,1);assert.ok(await j.read());
});
const requests=samplePlan(1).flatMap(s=>['A','B'].map(phase=>({sample:s[phase],mib:s.mib,phase,path:ARCHIVE_PATH,success:true})));
const events=requests.map(r=>({sample:r.sample,source:'cloudflare-native-tail',path:ARCHIVE_PATH,method:'POST',cpuTime:7,wallTime:50,outcome:'ok',status:200}));
test('native CPU report uses native CPU and retains all phase/size groups',()=>{
  const r=cpuReport(requests,events);assert.equal(r.readiness,'PASS');assert.equal(r.groups.length,6);assert.ok(r.groups.every(g=>g.max===7&&g.wall_max===50));
});
test('missing traces / no execution are UNKNOWN, not zero CPU',()=>{
  const r=cpuReport(requests,events.slice(1));assert.equal(r.readiness,'UNKNOWN');assert.equal(r.groups[0].missing,1);assert.equal(r.groups[0].max,null);
  assert.equal(cpuReport([],[]).readiness,'UNKNOWN');
});
test('CPU >10, exceededCpu, HTTP1102 and request errors independently fail',()=>{
  for(const event of [{cpuTime:11},{outcome:'exceededCpu'},{status:503}])assert.equal(cpuReport(requests,[{...events[0],...event},...events.slice(1)]).readiness,'FAIL');
  assert.equal(cpuReport([{...requests[0],http1102:true},...requests.slice(1)],events).readiness,'FAIL');
  assert.equal(cpuReport([{...requests[0],success:false},...requests.slice(1)],[]).readiness,'FAIL');
});
test('conflicting traces are UNKNOWN and larger CPU is retained',()=>{
  const r=cpuReport(requests,[...events,{...events[0],cpuTime:8}]);assert.equal(r.readiness,'UNKNOWN');assert.equal(r.groups[0].max,8);assert.equal(r.groups[0].conflicts,1);
});
test('local wall/custom logs/mock paths cannot masquerade as native CPU',()=>{
  const r=cpuReport(requests,[...events.map(e=>({...e,source:'node-wall'})),{...events[0],path:'/__canary_mock'}]);assert.equal(r.readiness,'UNKNOWN');assert.equal(r.rejected,7);
  assert.throws(()=>cpuReport([{...requests[0],sample:'ops-1m-1-A'}],events));
});
test('tail sanitization excludes headers, credentials, full URLs and console payloads',()=>{
  const e=nativeTrace({cpuTime:5,wallTime:9,outcome:'ok',logs:[{message:['private']}],event:{request:{url:'https://example.invalid'+ARCHIVE_PATH,method:'POST',headers:{'X-Isolated-Sample':'arc-1m-1-A',Authorization:'private'}},response:{status:200}}});
  assert.equal(e.cpuTime,5);assert.equal(JSON.stringify(e).includes('private'),false);assert.equal(JSON.stringify(e).includes('https'),false);
});
test('configuration is isolated; production D1/name/expired configs are rejected',()=>{
  const args={name:'voteproof-archive-canary-test-cpu-v3',account:'isolated',accountId:'1'.repeat(32),databaseId:randomUUID(),expires:Date.now()+3600000,writerEvidenceHash:'a'.repeat(64)};
  const c=isolatedConfig(args);assert.equal(c.r2_buckets[0].bucket_name,args.name);assert.equal(c.services[0].service,args.name);assert.equal(c.vars.STORAGE_ALERT_ENABLED,'false');assert.equal(c.observability.head_sampling_rate,1);assert.equal(Object.hasOwn(c.vars,'TEST_ACCESS'),false);
  for(const change of [{databaseId:'9e2b885d-66e2-4e4d-b768-4bded261296a'},{name:'voteproof'},{expires:0}])assert.throws(()=>isolatedConfig({...args,...change}));
});
test('disk journal is durable, exclusive at A, malformed state holds, no secret/handoff persisted',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'voteproof-archive-journal-')),file=join(dir,'journal');
  try{
    const j=durableJournal(file);assert.equal(await j.read(),null);await j.write({phase:'A',sample:sample.A});
    await assert.rejects(durableJournal(file).write({phase:'A'}),{code:'EEXIST'});
    assert.equal((await durableJournal(file).read()).phase,'A');await j.write({phase:'B',sample:sample.B});
    assert.equal((await j.read()).phase,'B');await j.clear();assert.equal(await j.read(),null);
    await writeFile(file,'{broken');assert.equal((await j.read()).state,'operator_hold');
  }finally{assert.ok(dir.startsWith(join(tmpdir(),'voteproof-archive-journal-')));await rm(dir,{recursive:true,force:true});}
});
