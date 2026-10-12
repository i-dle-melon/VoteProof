import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { backupText, backupLink } from '../public/js/admin-backup.js';
test('admin backup presentation uses allowlists, safe Drive links and no guessed error text',()=>{
  const {labels,errors}=backupText(id=>id);
  assert.deepEqual(Object.values(labels),['backup-pending','backup-processing','backup-confirmed','backup-failed']);
  assert.equal(backupLink('valid_drive-id'),'https://drive.google.com/file/d/valid_drive-id/view');
  for(const id of [null,'https://bad.invalid','" onclick="bad','../../bad','bad?secret=x'])assert.equal(backupLink(id),null);
  assert.equal(errors.OAUTH_REVOKED,'backup-error-OAUTH_REVOKED');
});
test('browser backup module never refreshes tokens, invokes Drive or persists credentials',async()=>{
  const source=await readFile('public/js/admin-backup.js','utf8');
  assert.doesNotMatch(source,/oauth2\.googleapis\.com|www\.googleapis\.com|GOOGLE_DRIVE_|fetch\(|localStorage|sessionStorage/);
});
