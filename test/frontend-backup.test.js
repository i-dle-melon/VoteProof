import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { backupText, backupLink } from '../public/js/admin-backup.js';
import { adminMessage } from '../public/js/admin-api.js';
import { adminPath } from '../public/js/member-api.js';
import { randomUUID } from 'node:crypto';
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

test('manual backup path is explicit and readiness errors are safe user copy',()=>{
  const id=randomUUID();assert.equal(adminPath('/api/admin/backups/'+id+'/process'),true);
  for(const path of ['/api/admin/backups/process','/api/admin/backups/bulk/process','https://www.googleapis.com/drive/v3/files','/api/admin/backups/'+id+'/process/other'])assert.equal(adminPath(path),false);
  assert.equal(adminMessage({code:'DRIVE_BACKUP_DISABLED'}),'Google Drive 備份尚未啟用。');
  assert.equal(adminMessage({code:'DRIVE_BACKUP_NOT_CONFIGURED'}),'Google Drive 備份尚未設定完成。');
  assert.doesNotMatch(adminMessage({code:'upstream private text'}),/upstream/);
});

test('missing backup list transport accepts only bounded page numbers on the read-only list route',()=>{
  for(const path of ['/api/admin/backups/missing','/api/admin/backups/missing?page=1','/api/admin/backups/missing?page=35'])assert.equal(adminPath(path),true);
  for(const query of ['page=0','page=-1','page=01','page=1.5','page=9007199254740991','page=1&page=2','page=1&token=forged','limit=100','page='])assert.equal(adminPath('/api/admin/backups/missing?'+query),false);
});
