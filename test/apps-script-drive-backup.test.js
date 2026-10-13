import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
const source = readFileSync(new URL('../apps-script/drive-backup/Code.gs', import.meta.url), 'utf8');
const FOLDER = 'application/vnd.google-apps.folder';
function fixture() {
  const secret=randomBytes(32).toString('hex'), root='isolated_root', files=new Map([[root,{id:root,name:'Private root',mimeType:FOLDER,trashed:false}]]);
  const properties=new Map([['VOTEPROOF_ORIGIN','https://isolated.example'],['DRIVE_BACKUP_RELAY_SECRET',secret],['ROOT_FOLDER_ID',root],['ENVIRONMENT','isolated']]);
  const state={locked:false,skip:false,serial:0,uploads:0,folders:0,calls:[],logs:[],fail:null,ids:null,claimed:false,confirmed:false,attempt:0,nonce:null,triggers:[],claimCount:0};
  const job={backup_id:randomUUID(),case_id:'VP-20261013-TESTTESTTESTTEST',proof_id:randomUUID(),filename:'VP-20261013-TESTTESTTESTTEST.png',mime:'image/png',size:3,
    root_folder_id:root,campaign_key:'campaign:LOCAL',date_key:'date:LOCAL:2026-10-13',campaign_name:'Original [LOCAL]',date:'2026-10-13',drive_file_id:null};
  const response=(data,code=200)=>({getResponseCode:()=>code,getContentText:()=>JSON.stringify(code===200?{ok:true,data}:{ok:false,error:{code:data}})});
  function fetch(url,options) {
    assert.equal(new URL(url).origin,'https://isolated.example');assert.equal(options.headers.Authorization==='Bearer '+secret,true);
    assert.equal(options.followRedirects,false);assert.equal(options.validateHttpsCertificates,true);
    const action=url.split('/').at(-1),body=options.payload?JSON.parse(options.payload):null;state.calls.push(action);
    if(action==='claim') {
      state.claimCount++;if(state.confirmed)return response({state:body.request_id===state.nonce?'already_confirmed':'idle'});
      if(!state.claimed){state.attempt++;state.nonce=body.request_id;state.claimed=true;}
      return response({state:'claimed',job:{...job,attempt:state.attempt,lease_token:state.nonce,drive_file_id:state.ids?.drive_file_id??null}});
    }
    if(action==='identity') {
      state.ids??={drive_file_id:body.drive_file_id,campaign_folder_id:body.campaign_folder_id,date_folder_id:body.date_folder_id,drive_folder_id:body.date_folder_id};
      if(state.fail==='identity_ack'){state.fail=null;throw Error('lost identity ACK');}return response(state.ids);
    }
    if(action==='content')return {getResponseCode:()=>200,getAllHeaders:()=>({'Content-Type':'image/png'}),getBlob:()=>({getBytes:()=>[1,2,3],setContentType(){},setName(){}})};
    if(action==='complete') {
      state.confirmed=true;
      if(state.fail==='complete_ack'){state.fail=null;throw Error('lost complete ACK');}return response({state:'confirmed'});
    }
    if(action==='failed'){if(state.confirmed)return response('RELAY_LEASE_CONFLICT',409);state.claimed=false;return response({state:'failed'});}
    throw Error('unexpected API');
  }
  function restart() {
    const context=vm.createContext({console:{log:s=>state.logs.push(s)},PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k)??null,setProperty:(k,v)=>properties.set(k,v),deleteProperty:k=>properties.delete(k)})},
      LockService:{getScriptLock:()=>({tryLock:()=>{if(state.locked||state.skip)return false;state.locked=true;return true;},releaseLock:()=>{state.locked=false;}})},
      Utilities:{getUuid:randomUUID,DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_a,key)=>[...createHash('sha256').update(key).digest()]},
      UrlFetchApp:{fetch},Drive:{Files:{get:id=>{if(!files.has(id))throw Error('404 File not found');return structuredClone(files.get(id));},
        generateIds:({count})=>({ids:Array.from({length:count},()=> 'generated_'+ ++state.serial)}),
        create:(meta,blob)=>{if(files.has(meta.id))throw Error('409');files.set(meta.id,{...meta,trashed:false,...(blob?{size:'3'}:{})});if(blob)state.uploads++;else state.folders++;
          if(blob&&state.fail==='upload_ack'){state.fail=null;throw Error('lost Drive ACK');}return {id:meta.id};}},Permissions:{list:()=>({permissions:[{type:'user',role:'owner'}]})}},
      ScriptApp:{getProjectTriggers:()=>state.triggers,deleteTrigger:t=>{state.triggers=state.triggers.filter(x=>x!==t);},newTrigger:handler=>({timeBased(){return this;},everyMinutes(n){assert.equal(n,5);return this;},create(){state.triggers.push({getHandlerFunction:()=>handler});}})}
    });vm.runInContext(source,context);return context;
  }
  return {state,job,files,properties,restart,context:restart()};
}
test('manifest has exactly three minimal scopes, V8 and no web-app deployment',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../apps-script/drive-backup/appsscript.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.oauthScopes,['https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/script.external_request','https://www.googleapis.com/auth/script.scriptapp']);
  assert.equal(manifest.runtimeVersion,'V8');assert.equal(manifest.webapp,undefined);
});
test('five-minute installer removes only same-handler duplicate triggers; disable leaves unrelated triggers',()=>{
  const f=fixture();f.state.triggers=[{getHandlerFunction:()=> 'runBackup'},{getHandlerFunction:()=> 'runBackup'},{getHandlerFunction:()=> 'other'}];
  f.context.installTrigger();f.context.installTrigger();assert.equal(f.state.triggers.filter(t=>t.getHandlerFunction()==='runBackup').length,1);
  f.context.removeTriggers();assert.deepEqual(f.state.triggers.map(t=>t.getHandlerFunction()),['other']);assert.equal(f.state.locked,false);
});
test('overlap exits without network; D1 receipt is required before every Drive mutation',()=>{
  const f=fixture();f.state.skip=true;assert.equal(f.context.runBackup().state,'overlap_skipped');assert.equal(f.state.calls.length,0);
  f.state.skip=false;assert.equal(f.context.runBackup().state,'confirmed');assert.deepEqual(f.state.calls,['claim','identity','content','complete']);assert.equal(f.state.claimCount,1);assert.equal(f.state.locked,false);
});
test('new and existing folders verify stable identity; campaign name changes do not rename or duplicate folders',()=>{
  const f=fixture();assert.equal(f.context.runBackup().state,'confirmed');assert.equal(f.state.folders,2);assert.equal(f.state.uploads,1);
  const id=f.state.ids.campaign_folder_id,original=f.files.get(id).name;
  assert.equal(f.context.vpFolder_(id,'New visible campaign name','isolated_root',f.job.campaign_key),id);
  assert.equal(f.files.get(id).name,original);assert.equal(f.state.folders,2);
  f.files.get(id).appProperties.folder_key='wrong';assert.throws(()=>f.context.vpFolder_(id,original,'isolated_root',f.job.campaign_key),/VERIFY_FAILED/);
});
for(const loss of ['identity_ack','upload_ack','complete_ack'])test('actual Apps Script source lost '+loss+' and fresh VM restart never duplicate file/folders',()=>{
  const f=fixture();f.state.fail=loss;f.context.runBackup();f.job.campaign_name='Renamed [LOCAL]';
  const restarted=f.restart();restarted.runBackup();restarted.runBackup();
  assert.equal(f.state.confirmed,true);assert.equal(f.state.uploads,1);assert.equal(f.state.folders,2);
  assert.equal([...f.files.values()].filter(x=>x.mimeType==='image/png').length,1);
  assert.equal(f.state.locked,false);assert.equal(f.state.logs.some(s=>/Bearer|lease_token|refresh_token|drive_file_id/.test(s)),false);
});
test('confirmed restart/replay skips content and upload; fake Drive metadata cannot confirm',()=>{
  const f=fixture();assert.equal(f.context.runBackup().state,'confirmed');const count=f.state.calls.filter(x=>x==='content').length;
  f.restart().runBackup();assert.equal(f.state.uploads,1);assert.equal(f.state.calls.filter(x=>x==='content').length,count);
  const bad=fixture(),proposed={drive_file_id:'bad_file',drive_folder_id:'bad_folder'};
  assert.throws(()=>bad.context.vpVerify_({id:'bad_file',mimeType:'image/jpeg',size:3},bad.job,proposed),/VERIFY_FAILED/);
});

test('source-change and invalid-source failures stay sanitized and permanent rather than network retries',()=>{
  const f=fixture();assert.equal(f.context.vpFailure_(Error('INVALID_SOURCE')),'INVALID_SOURCE');
  assert.equal(f.context.vpFailure_(Error('SOURCE_CHANGED')),'SOURCE_CHANGED');
  f.context.UrlFetchApp.fetch=()=>({getResponseCode:()=>409,getContentText:()=>JSON.stringify({error:{code:'RELAY_SOURCE_CHANGED'}})});
  assert.throws(()=>f.context.vpRequest_(f.context.vpConfig_(),'/api/internal/drive-backup/test/content','get'),/SOURCE_CHANGED/);
});
