import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';

const backup = readFileSync('apps-script/drive-backup/Code.gs', 'utf8');
const source = readFileSync('apps-script/drive-backup/StorageInventory.gs', 'utf8');
const handler = 'runStorageInventory';
const tickPath = '/api/internal/drive-backup/storage/tick';
const finalPath = '/api/internal/drive-backup/storage/inventory/finalize';
const inventoryId='00000000-0000-4000-8000-000000000001';
const reply = (inventory = {complete:true,bytes:472081,anomaly:null}) => ({
  fixtureFinal:inventory.complete?inventory:null,
  ok:true, data:{inventory_only:true,inventory:{...inventory,complete:false,
    phase:inventory.complete?'finalize':'scan',inventory_id:inventoryId,inventory_version:7},cleanup:null,
    alerts:{state:'skipped_inventory_only',sent:0}},
});

function fixture() {
  const secret = randomBytes(32).toString('hex');
  const properties = new Map([['VOTEPROOF_ORIGIN','https://isolated.invalid'],
    ['DRIVE_BACKUP_RELAY_SECRET',secret],['CLAIM_REQUEST_ID','backup-must-keep']]);
  const state = {locked:false, now:0, calls:[], finalizeCalls:[], quotaCalls:[], aboutCalls:0, logs:[], triggers:[], createFails:false,
    about:{storageQuota:{limit:'15000000000',usage:'7000000000'}}};
  const forbidden = new Proxy({}, {get(){assert.fail('Inventory touched Drive images or MailApp');}});
  const context = vm.createContext({
    Date:class extends Date { static now(){return state.now;} },
    console:{log:s=>state.logs.push(JSON.parse(s))},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k)??null})},
    LockService:{getUserLock:()=>({
      tryLock:()=>{if(state.locked)return false;state.locked=true;return true;},
      releaseLock:()=>{state.locked=false;},
    }), getScriptLock:()=>assert.fail('Inventory must not contend with backup ScriptLock')},
    Utilities:{getUuid:randomUUID},
    Drive:{About:{get:options=>{
      assert.deepEqual(JSON.parse(JSON.stringify(options)),{fields:'storageQuota'});
      state.aboutCalls++;
      state.now += state.aboutDelayMs ?? 0;
      if(state.about instanceof Error)throw state.about;
      return state.about;
    }},Files:forbidden,Permissions:forbidden}, MailApp:forbidden,
    UrlFetchApp:{fetch:(url,options)=>{
      assert.equal(options.method,'post');
      assert.equal(options.headers.Authorization,'Bearer '+secret);
      assert.equal(options.followRedirects,false);
      assert.equal(options.validateHttpsCertificates,true);
      if(url==='https://isolated.invalid/api/internal/drive-backup/storage/quota'){
        state.quotaCalls.push(JSON.parse(options.payload));
        if(state.quotaPostFails)throw Error('sensitive fixture error '+secret);
        return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({ok:true,data:{accepted:!state.quotaNotAccepted}})};
      }
      if(url==='https://isolated.invalid'+finalPath){
        const payload=JSON.parse(options.payload);state.finalizeCalls.push(payload);
        assert.deepEqual(payload,{inventory_id:inventoryId,inventory_version:7});
        const r=state.finalizeFetch?.()??{ok:true,data:{inventory_only:true,cleanup:null,
          alerts:{state:'skipped_inventory_only',sent:0},inventory:{...state.pendingFinal,complete:true,
            phase:'finalize',inventory_id:inventoryId,inventory_version:7,replayed:false}}};
        return{getResponseCode:()=>r.status??200,getContentText:()=>JSON.stringify(r)};
      }
      assert.equal(url,'https://isolated.invalid'+tickPath);
      assert.deepEqual(JSON.parse(options.payload),{inventory_only:true});
      state.calls.push({url,body:JSON.parse(options.payload)});
      const r=state.fetch?.()??reply();
      if(r.fixtureFinal)state.pendingFinal=r.fixtureFinal;
      return {getResponseCode:()=>r.status??200,getContentText:()=>r.raw??JSON.stringify(r)};
    }},
    ScriptApp:{getProjectTriggers:()=>state.triggers,
      deleteTrigger:t=>{state.triggers=state.triggers.filter(x=>x!==t);},
      newTrigger:name=>({timeBased(){return this;},everyMinutes(n){assert.equal(n,5);return this;},
        create(){if(state.createFails)throw Error('fixture create failure');state.triggers.push(trigger(name));}})},
  });
  vm.runInContext(backup,context);vm.runInContext(source,context);
  return {context,state,properties,secret};
}
const trigger = name => ({getHandlerFunction:()=>name});

test('maintenance only reads quota metadata and ticks; never images, archive, mail, backup or auto-install',()=>{
  assert.doesNotMatch(source,/\/storage\/archive|Drive\.(Files|Permissions)|MailApp|runStorageMaintenance\(/);
  const f=fixture();assert.equal(f.state.triggers.length,0);
  assert.equal(f.context.runStorageInventory().state,'complete');
  assert.equal(f.state.calls.length,1);assert.equal(f.state.locked,false);
  assert.equal(f.state.finalizeCalls.length,1);
  assert.equal(f.state.aboutCalls,1);assert.equal(f.state.quotaCalls.length,1);
  assert.equal(f.properties.get('CLAIM_REQUEST_ID'),'backup-must-keep');
  assert.equal(f.properties.size,3); // No root, identity or OAuth token property is needed.
});

test('soft pause requested during a page preserves its progress and skips Finalize without deleting triggers',()=>{
  const f=fixture();f.state.triggers=[trigger('runBackup'),trigger(handler)];
  f.state.fetch=()=>{f.properties.set('VOTEPROOF_INVENTORY_PAUSED','true');return reply();};
  const result=f.context.runStorageInventory();assert.equal(result.state,'paused');assert.equal(result.pages,1);
  assert.equal(f.state.calls.length,1);assert.equal(f.state.finalizeCalls.length,0);assert.equal(f.state.triggers.length,2);
  assert.equal(f.properties.get('CLAIM_REQUEST_ID'),'backup-must-keep');assert.equal(f.state.locked,false);
});
test('inventory follows every page until complete without sending a local cursor',()=>{
  const f=fixture();f.state.fetch=()=>reply(f.state.calls.length<4?
    {complete:false,scanned:f.state.calls.length*200}:{complete:true,bytes:1234,anomaly:null});
  const r=f.context.runStorageInventory();assert.equal(r.state,'complete');assert.equal(r.pages,4);
  assert.equal(f.state.aboutCalls,1);assert.equal(f.state.quotaCalls.length,1);
});

test('terminal scan uses a distinct finalization request with only server ID/version',()=>{
  const f=fixture();const result=f.context.runStorageInventory();
  assert.equal(result.state,'complete');assert.equal(f.state.calls.length,1);
  assert.equal(f.state.finalizeCalls.length,1);
  assert.deepEqual(f.state.finalizeCalls[0],{inventory_id:inventoryId,inventory_version:7});
  assert.equal(f.state.aboutCalls,1);
});

test('finalization failure releases lock; a later scheduled run can resume ready state',()=>{
  const f=fixture();f.state.finalizeFetch=()=>({status:503,ok:false,error:{code:'STORAGE_MAINTENANCE_UNAVAILABLE'}});
  assert.equal(f.context.runStorageInventory().state,'failed');assert.equal(f.state.locked,false);
  assert.equal(f.state.finalizeCalls.length,1); // No blind immediate retry.
  f.state.finalizeFetch=undefined;assert.equal(f.context.runStorageInventory().state,'complete');
  assert.equal(f.state.finalizeCalls.length,2);
});

test('mismatched finalization receipt fails closed',()=>{
  const f=fixture();f.state.finalizeFetch=()=>({ok:true,data:{...reply().data,
    inventory:{complete:true,phase:'finalize',inventory_id:randomUUID(),inventory_version:7,bytes:7,anomaly:null}}});
  assert.equal(f.context.runStorageInventory().code,'INVENTORY_RESPONSE_INVALID');assert.equal(f.state.locked,false);
});
test('reentrant same-owner execution skips before network and releases the lock',()=>{
  const f=fixture();let nested;
  f.state.fetch=()=>{nested=f.context.runStorageInventory();return reply();};
  assert.equal(f.context.runStorageInventory().state,'complete');
  assert.equal(nested.state,'overlap_skipped');assert.equal(f.state.calls.length,1);
  assert.equal(f.state.aboutCalls,1);
  assert.equal(f.state.locked,false);
});
test('partial scan failure stops; next invocation resumes through the Worker',()=>{
  const f=fixture();f.state.fetch=()=>{
    if(f.state.calls.length===2)throw Error('sensitive transport detail '+f.secret);
    return reply({complete:false,scanned:200});
  };
  const first=f.context.runStorageInventory();assert.equal(first.state,'failed');
  assert.equal(first.pages,1);assert.equal(first.code,'NETWORK');assert.equal(f.state.locked,false);
  f.state.fetch=()=>reply();assert.equal(f.context.runStorageInventory().state,'complete');
  assert.equal(JSON.stringify(f.state.logs).includes(f.secret),false);
});
test('page budget returns incomplete and safely continues on the next execution',()=>{
  const f=fixture();f.context.VP_STORAGE_INVENTORY_MAX_PAGES=2;
  f.state.fetch=()=>reply({complete:false,scanned:200});
  assert.equal(f.context.runStorageInventory().state,'incomplete');assert.equal(f.state.calls.length,2);
  f.state.fetch=()=>reply();assert.equal(f.context.runStorageInventory().state,'complete');
});
test('soft elapsed-time budget stops between requests without a false completion',()=>{
  const f=fixture();f.state.fetch=()=>{f.state.now+=60001;return reply({complete:false,scanned:200});};
  assert.equal(f.context.runStorageInventory().state,'incomplete');assert.equal(f.state.calls.length,1);
  assert.equal(f.state.locked,false);
});
test('latched anomaly is reported blocked, never complete or reset',()=>{
  const f=fixture();f.state.fetch=()=>reply({complete:true,bytes:100,anomaly:'UNACCOUNTED_GROWTH'});
  const r=f.context.runStorageInventory();assert.equal(r.state,'blocked');assert.equal(r.code,'STORAGE_ANOMALY');
});
for (const data of [
  {inventory:{complete:true,bytes:1,anomaly:null}},
  {...reply().data,inventory:{complete:'true'}},
  {...reply().data,inventory:{complete:true,bytes:-1,anomaly:null}},
  {...reply().data,alerts:{state:'sent',sent:1}},
]) test('malformed or legacy response fails closed: '+JSON.stringify(data),()=>{
  const f=fixture();f.state.fetch=()=>({ok:true,data});
  const r=f.context.runStorageInventory();assert.equal(r.state,'failed');
  assert.equal(r.code,'INVENTORY_RESPONSE_INVALID');assert.equal(f.state.calls.length,1);
});
test('old Worker HTTP rejection has no unsafe empty-body fallback or immediate retry',()=>{
  const f=fixture();f.state.fetch=()=>({status:503,ok:false,error:{code:'STORAGE_MAINTENANCE_UNAVAILABLE'}});
  assert.equal(f.context.runStorageInventory().state,'failed');assert.equal(f.state.calls.length,1);
  assert.equal(f.state.locked,false);
});
test('missing configuration never makes a request or exposes a credential',()=>{
  const f=fixture();f.properties.delete('VOTEPROOF_ORIGIN');
  assert.equal(f.context.runStorageInventory().code,'CONFIG_MISSING');assert.equal(f.state.calls.length,0);
  assert.equal(f.state.aboutCalls,0);assert.equal(f.state.quotaCalls.length,0);
});
for(const [name,about,expected,state] of [
  ['normal',{storageQuota:{limit:'15000000000',usage:'7000000000'}},{state:'known',total_bytes:15000000000,used_bytes:7000000000},'complete'],
  ['zero usage',{storageQuota:{limit:'15000000000',usage:'0'}},{state:'known',total_bytes:15000000000,used_bytes:0},'complete'],
  ['no limit',{storageQuota:{usage:'123'}},{state:'unlimited',total_bytes:null,used_bytes:123},'complete'],
  ['missing quota',{}, {state:'unknown',total_bytes:null,used_bytes:null},'partial'],
  ['missing usage',{storageQuota:{limit:'15000000000'}},{state:'unknown',total_bytes:null,used_bytes:null},'partial'],
  ['invalid usage',{storageQuota:{limit:'15',usage:''}},{state:'error',total_bytes:null,used_bytes:null},'partial'],
  ['unsafe integer',{storageQuota:{limit:'99999999999999999999',usage:'1'}},{state:'error',total_bytes:null,used_bytes:null},'partial'],
  ['invalid limit',{storageQuota:{limit:'0',usage:'1'}},{state:'error',total_bytes:null,used_bytes:null},'partial'],
  ['exceeds receiver contract',{storageQuota:{limit:'10',usage:'11'}},{state:'error',total_bytes:null,used_bytes:null},'partial'],
  ['Drive failure',new Error('private Google failure'),{state:'error',total_bytes:null,used_bytes:null},'partial'],
])test('quota metadata '+name+' is reported truthfully while R2 still completes',()=>{
  const f=fixture();f.state.about=about;
  const result=f.context.runStorageInventory();assert.equal(result.state,state);
  assert.equal(result.pages,1);assert.equal(result.quota.snapshot,'accepted');
  const snapshot=f.state.quotaCalls[0];assert.match(snapshot.id,/^[a-f0-9-]{36}$/);
  assert.equal(snapshot.observed_at,0);
  for(const [key,value] of Object.entries(expected))assert.equal(snapshot[key],value);
  assert.equal(f.state.calls.length,1);assert.equal(f.state.locked,false);
});
test('quota POST failure cannot prevent R2 inventory or be reported as accepted',()=>{
  const f=fixture();f.state.quotaPostFails=true;
  const r=f.context.runStorageInventory();assert.equal(r.state,'partial');assert.equal(r.pages,1);
  assert.equal(r.quota.snapshot,'failed');assert.equal(f.state.calls.length,1);
  assert.equal(JSON.stringify(f.state.logs).includes(f.secret),false);
});
test('quota metadata includes only the bounded snapshot fields, never Google identity or credentials',()=>{
  const f=fixture();f.state.about.user={emailAddress:'private-fixture@example.invalid',token:f.secret};
  f.context.runStorageInventory();
  assert.deepEqual(Object.keys(f.state.quotaCalls[0]).sort(),['id','observed_at','state','total_bytes','used_bytes']);
  assert.equal(JSON.stringify(f.state.quotaCalls).includes('emailAddress'),false);
  assert.equal(JSON.stringify(f.state.logs).includes(f.secret),false);
});
test('slow quota lookup does not exhaust the separate R2 pagination budget',()=>{
  const f=fixture();f.state.aboutDelayMs=60001;
  assert.equal(f.context.runStorageInventory().state,'complete');assert.equal(f.state.calls.length,1);
  assert.equal(f.state.quotaCalls[0].observed_at,60);
});
test('non-acknowledged quota response is partial, never silent success',()=>{
  const f=fixture();f.state.quotaNotAccepted=true;
  assert.equal(f.context.runStorageInventory().quota.snapshot,'failed');assert.equal(f.state.calls.length,1);
});
test('disabled Drive service is reported as error without blocking R2',()=>{
  const f=fixture();delete f.context.Drive;
  const r=f.context.runStorageInventory();assert.equal(r.state,'partial');
  assert.equal(f.state.quotaCalls[0].state,'error');assert.equal(f.state.calls.length,1);
});
test('installer is five-minute and idempotent; removal preserves backup and maintenance triggers',()=>{
  const f=fixture();f.state.triggers=[trigger('runBackup'),trigger('runStorageMaintenance'),trigger(handler),trigger(handler)];
  f.context.installStorageInventoryTrigger();f.context.installStorageInventoryTrigger();
  assert.deepEqual(f.state.triggers.map(x=>x.getHandlerFunction()),['runBackup','runStorageMaintenance',handler]);
  f.context.removeStorageInventoryTriggers();
  assert.deepEqual(f.state.triggers.map(x=>x.getHandlerFunction()),['runBackup','runStorageMaintenance']);
});
test('failed replacement creation preserves the previously installed trigger',()=>{
  const f=fixture();const old=trigger(handler);f.state.triggers=[old];f.state.createFails=true;
  assert.throws(()=>f.context.installStorageInventoryTrigger(),/fixture create failure/);
  assert.deepEqual(f.state.triggers,[old]);assert.equal(f.state.locked,false);
});
