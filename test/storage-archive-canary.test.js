import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const source = readFileSync('apps-script/drive-backup/StorageArchiveCanary.gs','utf8');
const origin='https://voteproof-archive-canary-test-local.example.workers.dev';
function fixture({environment='isolated',enabled='true',origin:target=origin,responses=[]}={}){
  const props=new Map([['ENVIRONMENT',environment],['STORAGE_ARCHIVE_CANARY_ENABLED',enabled],['VOTEPROOF_ORIGIN',target],['STORAGE_ARCHIVE_CANARY_ORIGIN',target],['STORAGE_ARCHIVE_CANARY_TRIGGER_OWNER','canary@example.invalid']]);
  const state={requests:[],released:0,available:true,triggers:[],removed:[],created:[],writeFails:false,createFails:false};
  const ctx=vm.createContext({
    Number,Error,
    Utilities:{getUuid:randomUUID},Session:{getEffectiveUser:()=>({getEmail:()=>state.owner??'canary@example.invalid'})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k),setProperty:(k,v)=>{if(state.writeFails)throw Error('property failure');props.set(k,v);},deleteProperty:k=>props.delete(k)})},
    LockService:{getScriptLock:()=>({tryLock:()=>state.available,releaseLock:()=>state.released++})},
    vpConfig_:()=>({origin:state.configOrigin??target,secret:'dummy'}),
    vpJson_:(_c,path,body)=>{assert.ok(props.has('STORAGE_ARCHIVE_CANARY_JOURNAL'),'journal persisted before POST');state.requests.push({path,body});let reply=responses.shift();if(reply instanceof Error)throw reply;return typeof reply==='function'?reply():reply;},
    ScriptApp:{
      getProjectTriggers:()=>state.triggers,
      newTrigger:name=>({timeBased:()=>({everyMinutes:n=>({create:()=>{state.created.push({name,n});state.triggers.push({getHandlerFunction:()=>name});if(state.createFails)throw Error('lost create ACK');}})})}),
      deleteTrigger:t=>{state.removed.push(t.getHandlerFunction());state.triggers=state.triggers.filter(x=>x!==t);}
    }
  });
  vm.runInContext(source,ctx);
  return {ctx,props,state};
}
const fileId=randomUUID(),handoff=fileId+'.'+randomUUID();
const reply=(state,mode='dry-run',deleted=0,extra={})=>({cleanup:{state,mode,deleted,retention_days:7,phase:['cold','cold_reconciled'].includes(state)?'delete':'verify',file_id:fileId,handoff,...extra}});

test('disabled by default; production never reaches the archive endpoint',()=>{
  for(const options of [{enabled:undefined},{environment:'production'},{origin:'https://voteproof.i-dle-melon.workers.dev'}]){
    const f=fixture(options);if(options.enabled===undefined)f.props.delete('STORAGE_ARCHIVE_CANARY_ENABLED');
    const r=f.ctx.runStorageArchiveCanary();assert.equal(r.state,'disabled');assert.equal(f.state.requests.length,0);
  }
});
test('isolated dry-run makes only one authenticated server-controlled request',()=>{
  const f=fixture({responses:[reply('dry_run')]});
  const r=f.ctx.runStorageArchiveCanary();assert.equal(r.state,'dry_run');assert.equal(r.deleted,0);
  assert.equal(r.requests,1);assert.deepEqual(JSON.parse(JSON.stringify(f.state.requests[0])),
    {path:'/api/internal/drive-backup/storage/archive',body:{canary:true}});
  assert.equal(f.state.released,1);
});
test('A verification-ready immediately invokes B, not a later scheduled run',()=>{
  const f=fixture({responses:[reply('verification_ready','live'),reply('cold','live',1)]});
  const r=f.ctx.runStorageArchiveCanary();assert.equal(r.state,'cold');assert.equal(r.deleted,1);
  assert.equal(r.requests,2);assert.equal(f.state.requests.length,2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.requests[1].body)),{canary:true,handoff});
  assert.equal(f.props.has('STORAGE_ARCHIVE_CANARY_JOURNAL'),false);
});
test('only one call for idle, blocked, or target reached',()=>{
  for(const state of ['idle','blocked','target_reached','no_eligible_proofs','delete_pending']){
    const f=fixture({responses:[reply(state)]});
    assert.equal(f.ctx.runStorageArchiveCanary().state,state);assert.equal(f.state.requests.length,1);
  }
});
test('lost ACK after A or B stops safely and never silently retries',()=>{
  for(const [responses,expected] of [[[new Error('lost A')],1],[[reply('verification_ready','live'),new Error('lost B')],2]]){
    const f=fixture({responses});const r=f.ctx.runStorageArchiveCanary();
    assert.equal(r.state,'unconfirmed');assert.equal(r.deleted,null);
    assert.equal(f.state.requests.length,expected);
    assert.equal(f.ctx.runStorageArchiveCanary().state,'operator_hold');assert.equal(f.state.requests.length,expected);
    const restarted=fixture();for(const [k,v]of f.props)restarted.props.set(k,v);assert.equal(restarted.ctx.runStorageArchiveCanary().state,'operator_hold');assert.equal(restarted.state.requests.length,0);
  }
});
test('invalid/malicious response rejects without third request',()=>{
  const f=fixture({responses:[reply('verification_ready','live'),{cleanup:{state:'cold',mode:'live',deleted:2,retention_days:7}}]});
  const r=f.ctx.runStorageArchiveCanary();assert.equal(r.state,'unconfirmed');assert.equal(r.code,'ARCHIVE_RESPONSE_INVALID');assert.equal(f.state.requests.length,2);
});
test('malformed dry-run verification-ready response cannot trigger B',()=>{
  const f=fixture({responses:[reply('verification_ready','dry-run')]});
  const r=f.ctx.runStorageArchiveCanary();assert.equal(r.state,'unconfirmed');
  assert.equal(r.code,'ARCHIVE_PHASE_INVALID');assert.equal(f.state.requests.length,1);
});
test('concurrent lock denies all work',()=>{
  const f=fixture({responses:[reply('idle')]});f.state.available=false;
  assert.equal(f.ctx.runStorageArchiveCanary().state,'overlap_skipped');assert.equal(f.state.requests.length,0);
});
test('installer is opt-in, isolated, rejects legacy trigger; remover is scoped',()=>{
  const prod=fixture({environment:'production'});assert.throws(()=>prod.ctx.installStorageArchiveCanaryTrigger(),/ISOLATED_CANARY_ONLY/);
  const f=fixture();f.state.triggers=[{getHandlerFunction:()=> 'runStorageMaintenance'}];
  assert.throws(()=>f.ctx.installStorageArchiveCanaryTrigger(),/LEGACY_MAINTENANCE_TRIGGER_CONFLICT/);
  f.state.triggers=[];f.ctx.installStorageArchiveCanaryTrigger();
  assert.equal(f.state.created.length,1);assert.equal(f.state.created[0].n,5);
  f.ctx.installStorageArchiveCanaryTrigger();assert.equal(f.state.created.length,1);assert.deepEqual(f.state.removed,[]);
  f.ctx.removeStorageArchiveCanaryTriggers();assert.deepEqual(f.state.removed,['runStorageArchiveCanary']);
});

test('production URL aliases, arbitrary origins and missing independent pin are denied',()=>{
  for(const target of ['https://voteproof.i-dle-melon.workers.dev:443','https://VOTEPROOF.i-dle-melon.workers.dev','https://voteproof.i-dle-melon.workers.dev.','https://other.example','https://voteproof-archive-canary-test-local.example.workers.dev.evil.invalid',origin+'/']){
    const f=fixture({origin:target});assert.equal(f.ctx.runStorageArchiveCanary().state,'disabled');assert.equal(f.state.requests.length,0);
  }
  const f=fixture();f.props.delete('STORAGE_ARCHIVE_CANARY_ORIGIN');assert.equal(f.ctx.runStorageArchiveCanary().state,'disabled');
});
test('pre-call persistence or config mismatch cannot issue any HTTP request',()=>{
  const f=fixture();f.state.writeFails=true;assert.equal(f.ctx.runStorageArchiveCanary().state,'unconfirmed');assert.equal(f.state.requests.length,0);
  const g=fixture();g.state.configOrigin='https://voteproof.i-dle-melon.workers.dev';assert.equal(g.ctx.runStorageArchiveCanary().code,'CONFIG_MISSING');assert.equal(g.state.requests.length,0);
});
test('durable crash and malformed journals never expire into a replay',()=>{
  for(const value of ['broken','{"phase":"verify_in_flight","started_at":1}','{"phase":"delete_in_flight"}']){
    const f=fixture();f.props.set('STORAGE_ARCHIVE_CANARY_JOURNAL',value);assert.equal(f.ctx.runStorageArchiveCanary().state,'operator_hold');assert.equal(f.state.requests.length,0);
  }
});
test('server deletion ambiguity holds across runs and never reports zero confirmed deletions',()=>{
  const f=fixture({responses:[reply('verification_ready','live'),reply('delete_ambiguous','live')]});
  assert.equal(f.ctx.runStorageArchiveCanary().deleted,null);assert.equal(f.ctx.runStorageArchiveCanary().state,'operator_hold');assert.equal(f.state.requests.length,2);
});
test('mismatched file, stale handoff shape, false success and wrong phase stop the canary',()=>{
  for(const responses of [[reply('verification_ready','live',0,{handoff:'invalid'})],
    [reply('verification_ready','live'),reply('cold','live',1,{file_id:randomUUID()})],
    [reply('cold','live',1)],
    [reply('verification_ready','live'),reply('cold','dry-run',1)],
    [reply('verification_ready','live'),reply('cold','live',0)]]){
    const f=fixture({responses});assert.equal(f.ctx.runStorageArchiveCanary().state,'unconfirmed');assert.equal(f.ctx.runStorageArchiveCanary().state,'operator_hold');assert.ok(f.state.requests.length<=2);
  }
});
test('disable or reconfigure between phases never sends B',()=>{
  const f=fixture();f.state.requests.length=0;
  // vpJson callback models a setting change while A is in flight.
  const g=fixture({responses:[()=>{g.props.set('STORAGE_ARCHIVE_CANARY_ENABLED','false');return reply('verification_ready','live');}]});
  assert.equal(g.ctx.runStorageArchiveCanary().state,'unconfirmed');assert.equal(g.state.requests.length,1);
  const write=fixture({responses:[()=>{write.state.writeFails=true;return reply('verification_ready','live');}]});
  assert.equal(write.ctx.runStorageArchiveCanary().state,'unconfirmed');assert.equal(write.state.requests.length,1);assert.equal(write.ctx.runStorageArchiveCanary().state,'operator_hold');
});
test('trigger owner, duplicates and uncertain creation fail closed without touching runBackup',()=>{
  const f=fixture();f.state.owner='other@example.invalid';assert.throws(()=>f.ctx.installStorageArchiveCanaryTrigger(),/CANARY_OWNER_REQUIRED/);
  f.state.owner='canary@example.invalid';f.state.triggers=[{getHandlerFunction:()=> 'runBackup'},{getHandlerFunction:()=> 'runStorageArchiveCanary'},{getHandlerFunction:()=> 'runStorageArchiveCanary'}];
  assert.throws(()=>f.ctx.installStorageArchiveCanaryTrigger(),/DUPLICATE/);assert.equal(f.state.created.length,0);
  const g=fixture();g.state.createFails=true;assert.throws(()=>g.ctx.installStorageArchiveCanaryTrigger(),/lost create ACK/);assert.throws(()=>g.ctx.installStorageArchiveCanaryTrigger(),/CANARY_OPERATOR_HOLD/);assert.equal(g.state.created.length,1);
  const prod=fixture({environment:'production'});assert.throws(()=>prod.ctx.removeStorageArchiveCanaryTriggers(),/ISOLATED_CANARY_ONLY/);
  f.ctx.removeStorageArchiveCanaryTriggers();assert.deepEqual(f.state.triggers.map(t=>t.getHandlerFunction()),['runBackup']);
  const off=fixture();off.props.set('STORAGE_ARCHIVE_CANARY_ENABLED','false');off.state.triggers=[{getHandlerFunction:()=> 'runBackup'},{getHandlerFunction:()=> 'runStorageArchiveCanary'}];off.ctx.removeStorageArchiveCanaryTriggers();assert.deepEqual(off.state.triggers.map(t=>t.getHandlerFunction()),['runBackup']);
});
