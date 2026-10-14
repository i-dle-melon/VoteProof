// Fresh isolated LOCAL Wrangler database only. No remote option is accepted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
const persist = '.wrangler/drive-backup-schema-' + randomUUID();
const run = args => execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--local', '--persist-to', persist], { encoding:'utf8',windowsHide:true });
run(['d1','migrations','apply','voteproof-cases']);
const read = sql => JSON.parse(run(['d1','execute','voteproof-cases','--command',sql,'--json']))[0].results;
const expected = (await readdir('migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)).sort();
assert.equal(expected.length,13);assert.equal(expected.at(-1),'0013_async_proof_duplicates.sql');
assert.deepEqual(read('SELECT name FROM d1_migrations ORDER BY name').map(r=>r.name),expected);
for(const table of ['proof_backups','drive_backup_folders','backup_processor_lock','backup_admin_audit','cases','case_files','point_transactions']) assert.equal(read('SELECT count(*) AS n FROM '+table)[0].n,0);
assert.equal(read('SELECT submissions_enabled FROM submission_settings WHERE id=1')[0].submissions_enabled,0);
assert.deepEqual(read('PRAGMA foreign_key_check'),[]);assert.equal(read('PRAGMA quick_check')[0].quick_check,'ok');
assert.equal(read("SELECT count(*) AS n FROM sqlite_schema WHERE name='idx_proof_backups_relay_lease_token'")[0].n,1);
assert.equal(read('SELECT count(*) AS n FROM proof_exact_hashes')[0].n,0);
console.log(JSON.stringify({local_only:true,migrations:'0001–0013',backup_seed_rows:0,hash_seed_rows:0,submissions_enabled:false,foreign_key_check:'PASS',quick_check:'ok',result:'PASS'}));
