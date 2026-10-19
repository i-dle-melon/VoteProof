import test from 'node:test';
import assert from 'node:assert/strict';
import {jsonFrames,sampleOf,traceAccounting,reconcileInventoryTraces} from '../scripts/lib/inventory-tail.mjs';
test('CLI frames survive arbitrary chunks, nested logs and escaped braces',()=>{
  const values=Array.from({length:120},(_,n)=>({cpuTime:n%17,event:{request:{headers:{'X-Isolated-Sample':'inv-'+n}}},logs:[{message:['{"sample":"inv-'+n+'","s":"escaped \\\" } {"}']}]}));
  const text='Wrangler banner\n'+values.map(v=>JSON.stringify(v,null,2)).join('\n');
  for(const chunk of [1,7,1024,text.length]){
    const seen=[];const parser=jsonFrames(v=>seen.push(v),()=>assert.fail('parse failure'));
    for(let n=0;n<text.length;n+=chunk)parser(text.slice(n,n+chunk));assert.deepEqual(seen,values);
  }
});

test('dual collectors retain CLI-only CPU violation and preserve truly missing samples',()=>{
  const requests=['inv-a','inv-b','inv-c'].map(sample=>({sample}));
  const r=reconcileInventoryTraces(requests,[{sample:'inv-a',cpu_ms:5}],
    [{sample:'inv-a',cpu_ms:5},{sample:'inv-b',cpu_ms:13}]);
  assert.deepEqual(r.rows.map(x=>[x.sample,x.cpu_ms,x.collectors]),
    [['inv-a',5,['direct','cli']],['inv-b',13,['cli']]]);
  assert.deepEqual(r.missing_ids,['inv-c']);assert.deepEqual(r.conflicts,[]);
});

test('collector disagreement is explicit and never hides the larger CPU measurement',()=>{
  const r=reconcileInventoryTraces([{sample:'inv-a'},{sample:'inv-b'}],
    [{sample:'inv-a',cpu_ms:4},{sample:'inv-b',cpu_ms:null}],
    [{sample:'inv-a',cpu_ms:12}]);
  assert.equal(r.rows[0].cpu_ms,12);assert.deepEqual(r.conflicts,['inv-a']);
  assert.deepEqual(r.missing_ids,['inv-b']);
});
test('sample matching is case insensitive and falls back to a sanitized log ID',()=>{
  assert.equal(sampleOf({event:{request:{headers:{'X-Isolated-Sample':'inv-header'}}}}).sample,'inv-header');
  assert.equal(sampleOf({logs:[{message:['{"sample":"inv-log"}']}]}).sample,'inv-log');
  const t=traceAccounting();t.accept({event:{request:{headers:{'x-isolated-sample':'inv-unknown'}}}});
  assert.equal(t.events[0].cpu_ms,null);assert.equal(t.diagnostics.missing_cpu,1);
  assert.equal(JSON.stringify(t.events).includes('authorization'),false);
});
