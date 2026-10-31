import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { localAdminRuntime } from '../scripts/lib/local-admin-runtime.mjs';
import { ensureCaseBackups, seconds, MAX_BACKUP_ATTEMPTS } from '../src/lib/proof-backup-store.js';
import { backupReadiness } from '../src/lib/drive-backup-relay.js';
import { countDatabase, driveConfigFixture } from '../scripts/lib/drive-backup-fixture.mjs';
import worker from '../src/index.js';

let h;
const secret = randomBytes(32).toString('hex'), root = 'isolated_root';
const config = () => ({ GOOGLE_DRIVE_BACKUP_ENABLED: 'true', DRIVE_BACKUP_RELAY_SECRET: secret });
const env = () => ({ ...h.local.authConfig, ...config(), DB: h.local.db, PROOFS_BUCKET: h.local.bucket });
before(async () => { h = await localAdminRuntime(); });
after(async () => { await h.local.runtime.dispose(); });
const lookup = id => h.local.db.prepare('SELECT * FROM proof_backups WHERE id=?').bind(id).first();
async function fresh(count = 1) {
  await h.local.db.batch(['DELETE FROM proof_backups', 'DELETE FROM drive_backup_folders', 'DELETE FROM backup_processor_lock'].map(sql => h.local.db.prepare(sql)));
  const rows = [];
  for (let i = 0; i < count; i++) {
    const c = await h.makeCase(); await ensureCaseBackups(env(), c.id);
    rows.push(await h.local.db.prepare('SELECT b.* FROM proof_backups b JOIN case_files f ON f.id=b.file_id WHERE f.case_id=?').bind(c.id).first());
  }
  return rows;
}
const claimBody = request_id => ({ request_id: request_id ?? randomUUID(), root_folder_id: root });
const receipt = job => ({ lease_token: job.lease_token, attempt: job.attempt });
async function api(action, body, { e = env(), headers = {}, id, method = action === 'content' ? 'GET' : 'POST', live = false } = {}) {
  const path = '/api/internal/drive-backup/' + (id ? id + '/' : '') + action;
  const auth = { Authorization: 'Bearer ' + secret, ...headers };
  for (const k of Object.keys(auth)) if (auth[k] === undefined) delete auth[k];
  const response = live ? await h.local.fetch(path, method, body, auth) : await worker.fetch(new Request('https://voteproof.example' + path, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), e);
  if (action === 'content' && response.status === 200) return { status: response.status, response };
  const data = await response.json(); return { status: response.status, data: data.data, code: data.error?.code };
}
const claim = (body = claimBody(), options) => api('claim', body, options);
async function identity(job, options) {
  const r = await api('identity', { ...receipt(job), drive_file_id: job.drive_file_id ?? 'file_' + randomUUID(), campaign_folder_id: 'campaign_' + randomUUID(), date_folder_id: 'date_' + randomUUID() }, { id: job.backup_id, ...options });
  assert.equal(r.status, 200); return r.data;
}
const completion = (job, ids) => ({ ...receipt(job), drive_file_id: ids.drive_file_id, drive_folder_id: ids.drive_folder_id,
  verification: { name: job.filename, size: job.size, mime: job.mime, parents: [ids.drive_folder_id], appProperties: {
    source: 'voteproof', storage_source: 'r2', voteproof_case_id: job.case_id, voteproof_proof_id: job.proof_id } } });
const content = (job, options) => api('content', undefined, { id: job.backup_id, headers: { 'X-VoteProof-Backup-Lease': job.lease_token, 'X-VoteProof-Backup-Attempt': String(job.attempt) }, ...options });
const expire = (id, attempts) => h.local.db.prepare("UPDATE proof_backups SET status='processing',lease_until=?,attempts=?,lease_token=? WHERE id=?").bind(seconds() - 1, attempts, randomUUID(), id).run();

test('relay defaults are exact, credential-free and legacy requires explicit opt-in', async () => {
  assert.equal(backupReadiness(config()).transport, 'apps_script_pull'); assert.equal(backupReadiness(config()).ready, true);
  for (const flag of [undefined, true, 'TRUE', 'true ', 'false']) assert.equal(backupReadiness({ ...config(), GOOGLE_DRIVE_BACKUP_ENABLED: flag }).ready, false);
  for (const value of [undefined, '', 'x', secret.toUpperCase()]) assert.equal(backupReadiness({ ...config(), DRIVE_BACKUP_RELAY_SECRET: value }).ready, false);
  const legacy = driveConfigFixture(); assert.equal(backupReadiness(legacy).transport, 'deprecated_worker_oauth');
  delete legacy.DRIVE_BACKUP_TRANSPORT; assert.equal(backupReadiness(legacy).ready, false);
  const waits = []; await worker.scheduled({}, { ...config(), ...legacy }, { waitUntil(p) { waits.push(p); } }); assert.equal(waits.length, 0);
  assert.deepEqual(Object.keys(backupReadiness(config())), ['enabled','configured','ready','state','transport']);
});

test('relay authentication rejects missing/malformed/wrong bearer and all browser Origin requests before D1', async () => {
  const meter = countDatabase(h.local.db), e = { ...env(), DB: meter.db };
  for (const Authorization of [undefined, '', 'bearer ' + secret, 'Bearer x', 'Bearer ' + randomBytes(32).toString('hex')]) {
    assert.equal((await claim(claimBody(), { e, headers: { Authorization } })).status, 401);
  }
  for (const Origin of ['https://voteproof.example', 'https://evil.example', 'null', '']) {
    assert.equal((await claim(claimBody(), { e, headers: { Origin } })).code, 'RELAY_SERVER_ONLY');
  }
  assert.equal(meter.queries, 0);
  assert.equal((await claim(claimBody(), { e: { ...e, GOOGLE_DRIVE_BACKUP_ENABLED: 'false' } })).code, 'DRIVE_BACKUP_DISABLED');
  assert.equal((await claim(claimBody(), { e: { ...e, DRIVE_BACKUP_RELAY_SECRET: undefined } })).status, 503);
});

test('local relay forwards lowercase HTTP JSON headers once and preserves explicit invalid content types', async () => {
  await fresh(0); await h.local.setAuthConfig(config());
  try {
    const body = claimBody();
    const accepted = await claim(body, { live: true, headers: { 'content-type': 'application/json; charset=utf-8' } });
    assert.equal(accepted.status, 200); assert.equal(accepted.data.state, 'idle');
    const rejected = await claim(body, { live: true, headers: { 'content-type': 'text/plain' } });
    assert.equal(rejected.status, 400); assert.equal(rejected.code, 'INVALID_RELAY_REQUEST');
  } finally { await h.local.setAuthConfig({ GOOGLE_DRIVE_BACKUP_ENABLED: undefined, DRIVE_BACKUP_RELAY_SECRET: undefined }); }
});

test('claim idle, exactly one per request, active lease excluded, request replay, retry due/backoff and root filtering', async () => {
  await fresh(0); assert.equal((await claim()).data.state, 'idle');
  const rows = await fresh(2), body = claimBody(), first = await claim(body); assert.equal(first.status, 200);
  assert.equal(first.data.state, 'claimed'); const job = first.data.job;
  assert.equal((await lookup(job.backup_id)).attempts, 1); assert.equal(job.lease_until >= seconds() + 599, true);
  assert.equal((await h.local.db.prepare("SELECT count(*) AS n FROM proof_backups WHERE status='processing'").first()).n, 1);
  assert.deepEqual((await claim(body)).data.job, job);
  assert.equal((await claim({ ...body, root_folder_id: 'other_root' })).code, 'RELAY_ROOT_CONFLICT');
  await h.local.db.prepare("UPDATE proof_backups SET status='failed',next_attempt_at=?,root_folder_id='other_root' WHERE id=?").bind(seconds() - 1, rows.find(r => r.id !== job.backup_id).id).run();
  assert.equal((await claim()).data.state, 'idle');
  await h.local.db.prepare('UPDATE proof_backups SET root_folder_id=NULL,next_attempt_at=? WHERE id!=?').bind(seconds() + 60, job.backup_id).run();
  assert.equal((await claim()).data.state, 'idle');
  await h.local.db.prepare('UPDATE proof_backups SET next_attempt_at=? WHERE id!=?').bind(seconds() - 1, job.backup_id).run();
  assert.equal((await claim()).data.job.backup_id, rows.find(r => r.id !== job.backup_id).id);
});

test('concurrent same-request/different-request claim races never lease one proof twice', async () => {
  await fresh(); const body = claimBody();
  const same = await Promise.all([claim(body), claim(body)]); assert.equal(same.every(r => r.status === 200), true);
  assert.equal(same[0].data.job.backup_id, same[1].data.job.backup_id); assert.equal((await lookup(same[0].data.job.backup_id)).attempts, 1);
  await fresh(); const race = await Promise.all([claim(), claim()]); assert.equal(race.filter(r => r.data.state === 'claimed').length, 1);
});

test('expired attempts 1 and max-1 reclaim with stable identity; max is terminal and repeated sweeps are idempotent', async () => {
  for (const attempt of [1, MAX_BACKUP_ATTEMPTS - 1]) {
    const [row] = await fresh(), job = (await claim()).data.job, ids = await identity(job);
    await expire(row.id, attempt);
    const r = await Promise.all([claim(), claim()]); const claimed = r.filter(x => x.data.state === 'claimed'); assert.equal(claimed.length, 1);
    assert.equal(claimed[0].data.job.attempt, attempt + 1); assert.equal(claimed[0].data.job.drive_file_id, ids.drive_file_id);
    assert.equal(claimed[0].data.job.drive_folder_id, ids.drive_folder_id);
  }
  const rows = await fresh(2); for (const row of rows) await expire(row.id, MAX_BACKUP_ATTEMPTS);
  await Promise.all([claim(), claim()]);
  for (const row of rows) {
    const b = await lookup(row.id); assert.equal(b.status, 'failed'); assert.equal(b.attempts, MAX_BACKUP_ATTEMPTS);
    assert.equal(b.lease_token, null); assert.equal(b.lease_until, null); assert.equal(b.next_attempt_at, null); assert.equal(b.last_error_code, 'INTERNAL');
  }
  const snapshot = await Promise.all(rows.map(r => lookup(r.id))); await claim(); await claim(); assert.deepEqual(await Promise.all(rows.map(r => lookup(r.id))), snapshot);
  const admin = await h.identity({ role: 'admin' });
  await h.local.setAuthConfig(config());
  const summary = await h.local.fetch('/api/admin/backups', 'GET', undefined, admin.headers); assert.equal((await summary.json()).data.counts.failed, 2);
  await h.local.setAuthConfig({ GOOGLE_DRIVE_BACKUP_ENABLED: undefined, DRIVE_BACKUP_RELAY_SECRET: undefined });
});

test('folder mapping survives campaign rename, different proposals/retries, and missing mappings without duplicates', async () => {
  await fresh(2); const job = (await claim()).data.job, ids = await identity(job);
  const before = (await h.local.db.prepare('SELECT * FROM drive_backup_folders ORDER BY folder_key').all()).results;
  await h.local.db.prepare("UPDATE campaigns SET name='Renamed campaign' WHERE campaign_id='LOCAL-TEST'").run();
  const replay = (await claim(claimBody(job.lease_token))).data.job; assert.notEqual(replay.campaign_name, job.campaign_name);
  assert.deepEqual(await identity(replay), ids);
  const second = (await claim()).data.job, ids2 = await identity(second);
  assert.equal(ids2.campaign_folder_id, ids.campaign_folder_id); assert.equal(ids2.date_folder_id, ids.date_folder_id);
  assert.deepEqual((await h.local.db.prepare('SELECT * FROM drive_backup_folders ORDER BY folder_key').all()).results, before);
  assert.equal((await h.local.db.prepare('SELECT count(*) AS n FROM drive_backup_folders').first()).n, 2);
});

test('private content requires live receipt, streams matching R2 bytes with MIME/length and exposes no source URL/key', async () => {
  await fresh(); const job = (await claim()).data.job;
  assert.equal(/object_key|https?:|secret/.test(JSON.stringify(job)), false);
  const r = await content(job); assert.equal(r.status, 200);
  assert.equal(r.response.headers.get('Content-Type'), 'image/png'); assert.equal(r.response.headers.get('Content-Length'), '3');
  assert.equal(r.response.headers.get('Cache-Control'), 'no-store'); assert.equal(r.response.headers.get('Access-Control-Allow-Origin'), null);
  assert.deepEqual([...new Uint8Array(await r.response.arrayBuffer())], [1,2,3]);
  assert.equal((await content({ ...job, backup_id: randomUUID() })).status, 404);
  assert.equal((await content({ ...job, lease_token: randomUUID() })).code, 'RELAY_LEASE_CONFLICT');
  assert.equal((await api('claim', { ...claimBody(), object_key: 'arbitrary.png' })).status, 400);
  const path = '/api/internal/drive-backup/' + job.backup_id + '/content?key=arbitrary.png';
  assert.equal((await worker.fetch(new Request('https://voteproof.example' + path, { headers: { Authorization: 'Bearer ' + secret } }), env())).status, 400);
  const stored=await lookup(job.backup_id);
  await h.local.bucket.put(stored.source_object_key,new Uint8Array([3,2,1]),{httpMetadata:{contentType:'image/png'}});
  assert.equal((await content(job)).code,'RELAY_SOURCE_CHANGED');assert.ok(await h.local.bucket.head(stored.source_object_key));
  await expire(job.backup_id, 1); assert.equal((await content(job)).status, 409);
});

test('complete validates all metadata before confirm; duplicate/lost-ACK replay is read-only; confirmed content denied', async () => {
  await fresh(); const job = (await claim()).data.job, ids = await identity(job), valid = completion(job, ids);
  const patches = [v => v.verification.size++, v => { v.verification.mime = 'image/jpeg'; }, v => { v.drive_folder_id = 'wrong_folder'; },
    v => { v.verification.parents = ['wrong_folder']; }, v => { v.drive_file_id = 'wrong_file'; }, v => { v.verification.name = 'wrong.png'; },
    v => { v.verification.appProperties.source = 'other'; }, v => { v.verification.appProperties.voteproof_proof_id = randomUUID(); }];
  for (const patch of patches) { const v = structuredClone(valid); patch(v); assert.equal((await api('complete', v, { id: job.backup_id })).code, 'RELAY_VERIFICATION_FAILED'); assert.equal((await lookup(job.backup_id)).status, 'processing'); }
  assert.equal((await api('complete', valid, { id: randomUUID() })).status, 404);
  assert.equal((await api('complete', { ...valid, lease_token: randomUUID() }, { id: job.backup_id })).status, 409);
  assert.equal((await api('complete', valid, { id: job.backup_id })).data.state, 'confirmed');
  const before = await lookup(job.backup_id);
  assert.equal((await api('complete', valid, { id: job.backup_id })).data.state, 'already_confirmed');
  assert.equal((await claim(claimBody(job.lease_token))).data.state, 'already_confirmed');
  assert.deepEqual(await lookup(job.backup_id), before); assert.equal((await content(job)).code, 'RELAY_LEASE_EXPIRED');
  await fresh(); const expired = (await claim()).data.job, pinned = await identity(expired);
  await h.local.db.prepare('UPDATE proof_backups SET lease_until=? WHERE id=?').bind(seconds() - 1, expired.backup_id).run();
  assert.equal((await api('complete', completion(expired, pinned), { id: expired.backup_id })).code, 'RELAY_LEASE_EXPIRED');
});

test('failed callback sanitizes errors, backoffs, clears active lease, respects max attempts, and preserves R2/cases/points', async () => {
  for (const [code, max, retry] of [['NETWORK',false,true],['RATE_LIMIT',false,true],['VERIFY_FAILED',false,false],['DRIVE_FULL',false,false],['NETWORK',true,false]]) {
    await fresh(); const job = (await claim()).data.job;
    if (max) { await h.local.db.prepare('UPDATE proof_backups SET attempts=? WHERE id=?').bind(MAX_BACKUP_ATTEMPTS, job.backup_id).run(); job.attempt = MAX_BACKUP_ATTEMPTS; }
    const snapshot=async()=>Object.fromEntries(await Promise.all(['cases','case_files','point_transactions'].map(async table=>[table,(await h.local.db.prepare('SELECT * FROM '+table).all()).results.map(r=>JSON.stringify(r)).sort()])));
    const before = await snapshot();
    const body = { ...receipt(job), error_code: code };
    assert.equal((await api('failed', { ...body, error_code: 'upstream token or arbitrary detail' }, { id: job.backup_id })).status, 400);
    assert.equal((await api('failed', body, { id: job.backup_id })).status, 200);
    const row = await lookup(job.backup_id); assert.equal(row.status, 'failed'); assert.equal(row.lease_until, null);
    // Keep only the receipt token for idempotent ACK replay; no active lease.
    assert.equal(row.lease_token, job.lease_token); assert.equal(row.last_error_code, code); assert.equal(row.next_attempt_at !== null, retry);
    if (retry) assert.equal(row.next_attempt_at >= seconds() + 59, true);
    assert.equal((await api('failed', body, { id: job.backup_id })).data.state, 'already_failed');
    assert.equal((await api('failed', { ...body, error_code: 'INTERNAL' }, { id: job.backup_id })).code, 'RELAY_FAILURE_CONFLICT');
    assert.deepEqual(await snapshot(), before);
    assert.ok(await h.local.bucket.head(row.source_object_key));
  }
});

test('complete application D1 query counts including batch guards, no-job, expiry, max sweep and replay', async t => {
  const meter = countDatabase(h.local.db), e = { ...env(), DB: meter.db }, measured = {};
  const measure = async (label, operation, expected) => { meter.reset(); const result = await operation(); measured[label] = meter.queries; assert.equal(meter.queries, expected, label); return result; };
  // Empty polling is now exactly one read; no terminalization or claim UPDATE
  // runs. Nonempty/replay paths reuse that read and keep the original budget.
  await fresh(0); await measure('no_job_claim', () => claim(claimBody(), { e }), 1);
  await fresh(); const body = claimBody(); const job = (await measure('successful_claim', () => claim(body, { e }), 4)).data.job;
  await measure('active_claim_replay', () => claim(body, { e }), 3);
  await measure('content_authorization', () => content(job, { e }), 1);
  const ids = await measure('identity', () => identity(job, { e }), 6);
  const done = completion(job, ids);
  await measure('complete', () => api('complete', done, { id: job.backup_id, e }), 2);
  await measure('duplicate_complete', () => api('complete', done, { id: job.backup_id, e }), 1);
  await measure('confirmed_claim_replay', () => claim(body, { e }), 2);
  for (const [label, code, count] of [['retryable_failed','NETWORK',4],['permanent_failed','DRIVE_FULL',5]]) {
    await fresh(); const j = (await claim()).data.job, v = { ...receipt(j), error_code: code };
    await measure(label, () => api('failed', v, { id: j.backup_id, e }), count);
    await measure(label + '_replay', () => api('failed', v, { id: j.backup_id, e }), 1);
  }
  let [b] = await fresh(); await expire(b.id, 1); await measure('lease_expiry_reclaim', () => claim(claimBody(), { e }), 4);
  [b] = await fresh(); await expire(b.id, MAX_BACKUP_ATTEMPTS); await measure('max_attempt_terminalization', () => claim(claimBody(), { e }), 4);
  assert.equal(Math.max(...Object.values(measured)), 6); t.diagnostic(JSON.stringify({ local_only: true, application_d1_queries: measured, budget: 'max 6 statements/request' }));
});

test('real local workerd relay integration, restart and ACK replay use only private local D1/R2, no Google credentials', async () => {
  await fresh(); await h.local.setAuthConfig(config());
  try {
    const body = claimBody(), job = (await claim(body, { live: true })).data.job, ids = await identity(job, { live: true });
    const r = await content(job, { live: true }); assert.equal((await r.response.arrayBuffer()).byteLength, 3);
    await h.local.setAuthConfig({ RELAY_FIXTURE_RESTART: randomUUID() });
    const restart = (await claim(body, { live: true })).data.job; assert.equal(restart.drive_file_id, ids.drive_file_id);
    assert.deepEqual(await identity(restart, { live: true }), ids);
    const v = completion(restart, ids);
    assert.equal((await api('complete', v, { id: job.backup_id, live: true })).data.state, 'confirmed');
    await h.local.setAuthConfig({ RELAY_FIXTURE_RESTART: randomUUID() });
    assert.equal((await api('complete', v, { id: job.backup_id, live: true })).data.state, 'already_confirmed');
    assert.equal((await claim(body, { live: true })).data.state, 'already_confirmed');
    const admin = await h.identity({ role: 'admin' });
    assert.equal((await h.local.fetch('/api/admin/backups/' + job.backup_id + '/process', 'POST', {}, admin.headers)).status, 410);
    assert.deepEqual(h.local.unexpectedUpstreams, []);
    assert.deepEqual((await h.local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
    assert.equal((await h.local.db.prepare('PRAGMA quick_check').first()).quick_check, 'ok');
  } finally { await h.local.setAuthConfig({ GOOGLE_DRIVE_BACKUP_ENABLED: undefined, DRIVE_BACKUP_RELAY_SECRET: undefined }); }
});
