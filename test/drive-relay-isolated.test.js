import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
test('isolated synthetic proof and queued backup survive separate Node/Worker process restarts without reseeding',t=>{
  // Persistent workerd SQLite paths can exceed Windows path limits beneath a
  // long worktree. Keep the unchanged two-process fixture in its own temp cwd.
  const base=resolve(tmpdir()),cwd=mkdtempSync(join(base,'vp-drive-'));
  assert.equal(dirname(cwd),base);
  t.after(()=>{assert.equal(dirname(cwd),base);rmSync(cwd,{recursive:true,force:true});});
  const script=fileURLToPath(new URL('../scripts/drive-relay-isolated.mjs',import.meta.url));
  const name='fixture-'+randomUUID(),run=()=>JSON.parse(execFileSync(process.execPath,[script,'--check','--fixture='+name],{cwd,encoding:'utf8',windowsHide:true,timeout:60000}).trim());
  const first=run(),second=run();assert.deepEqual(second,first);assert.equal(first.cases,1);assert.equal(first.backups.length,1);
  assert.equal(first.backups[0].status,'pending');assert.equal(first.submissions_enabled,0);assert.equal(first.foreign_key_check,'PASS');assert.equal(first.quick_check,'ok');
});
