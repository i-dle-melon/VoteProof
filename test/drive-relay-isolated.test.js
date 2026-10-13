import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
test('isolated synthetic proof and queued backup survive separate Node/Worker process restarts without reseeding',()=>{
  const name='fixture-'+randomUUID(),run=()=>JSON.parse(execFileSync(process.execPath,['scripts/drive-relay-isolated.mjs','--check','--fixture='+name],{encoding:'utf8',windowsHide:true,timeout:60000}).trim());
  const first=run(),second=run();assert.deepEqual(second,first);assert.equal(first.cases,1);assert.equal(first.backups.length,1);
  assert.equal(first.backups[0].status,'pending');assert.equal(first.submissions_enabled,0);assert.equal(first.foreign_key_check,'PASS');assert.equal(first.quick_check,'ok');
});
