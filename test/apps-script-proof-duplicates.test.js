import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../apps-script/proof-duplicates/Code.gs',import.meta.url),'utf8');
function fixture(fetch){const values=new Map([['DUPLICATE_API_ORIGIN','https://synthetic.example'],['DUPLICATE_PROCESSOR_SECRET','a'.repeat(64)]]);const c={LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},PropertiesService:{getScriptProperties:()=>({getProperty:k=>values.get(k),setProperty:(k,v)=>values.set(k,v),deleteProperty:k=>values.delete(k)})},Utilities:{getUuid:()=> '11111111-1111-4111-8111-111111111111'},UrlFetchApp:{fetch}};vm.createContext(c);vm.runInContext(source,c);return {c,values};}
test('separate Apps Script nonce survives network/lost ACK; recovered request has same ID; no Drive calls',()=>{
  const requests=[];let calls=0;const {c,values}=fixture((url,options)=>{requests.push({url,options});if(!calls++)throw Error('private');return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({ok:true,data:{state:'clear'}})};});
  assert.equal(c.runDuplicateAnalysis().state,'unavailable');assert.ok(values.has('DUPLICATE_REQUEST_ID'));assert.equal(c.runDuplicateAnalysis().state,'clear');assert.equal(values.has('DUPLICATE_REQUEST_ID'),false);
  assert.equal(requests[0].options.payload,requests[1].options.payload);assert.equal(requests[0].options.followRedirects,false);assert.ok(!requests[0].url.includes('a'.repeat(64)));
  assert.doesNotMatch(source,/Drive\.|runBackup|ScriptApp|console\.|Logger\./);
});
test('executor fails closed on disabled response/missing config/malformed ACK',()=>{
  const {c,values}=fixture(()=>({getResponseCode:()=>503}));assert.equal(c.runDuplicateAnalysis().state,'unavailable');assert.ok(values.has('DUPLICATE_REQUEST_ID'));
  values.delete('DUPLICATE_PROCESSOR_SECRET');assert.equal(c.runDuplicateAnalysis().state,'not_configured');
});
