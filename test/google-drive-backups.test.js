import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { localAdminRuntime } from '../scripts/lib/local-admin-runtime.mjs';
import { ensureCaseBackups, backfillBackups, claimBackup, seconds, backoff } from '../src/lib/proof-backup-store.js';
import { processBackups, backupRoute } from '../src/lib/proof-backup-processor.js';
import { DriveClient, BackupError, DRIVE_SCOPE, FOLDER_MIME } from '../src/lib/google-drive.js';
import worker from '../src/index.js';
let h;
before(async () => { h = await localAdminRuntime(); });
after(async () => { await h.local.runtime.dispose(); });
const config = () => ({ DRIVE_BACKUP_TRANSPORT:'worker_oauth_legacy', GOOGLE_DRIVE_BACKUP_ENABLED: 'true', GOOGLE_DRIVE_CLIENT_ID: randomBytes(12).toString('hex'),
  GOOGLE_DRIVE_CLIENT_SECRET: randomBytes(24).toString('hex'), GOOGLE_DRIVE_REFRESH_TOKEN: randomBytes(32).toString('hex'), GOOGLE_DRIVE_ROOT_FOLDER_ID: 'local_root' });
const environment = () => ({ ...config(), get DB() { return h.local.db; }, get PROOFS_BUCKET() { return h.local.bucket; } });
const jobFor = c => h.local.db.prepare('SELECT b.* FROM proof_backups b JOIN case_files f ON f.id=b.file_id WHERE f.case_id=?').bind(c.id).first();
async function fresh() {
  if (h.local.authConfig.GOOGLE_DRIVE_BACKUP_ENABLED) await h.local.setAuthConfig({ GOOGLE_DRIVE_BACKUP_ENABLED: undefined });
  await h.local.db.batch(['DELETE FROM proof_backups','DELETE FROM drive_backup_folders','DELETE FROM backup_processor_lock'].map(sql => h.local.db.prepare(sql)));
  const c = await h.makeCase(); const env = environment(); await ensureCaseBackups(env, c.id); return { c, env };
}
function googleMock({ fail, loseAck = false, badSize = false, badLocation = false, missingRoot = false } = {}) {
  let serial = 0, creates = 0, uploads = 0, refreshes = 0;
  const files = new Map(missingRoot ? [] : [['local_root', { id: 'local_root', mimeType: FOLDER_MIME, trashed: false }]]), sessions = new Map();
  const auth = randomBytes(32).toString('hex');
  const fetcher = async (url, options = {}) => {
    const u = new URL(url); assert.equal(u.origin === 'https://www.googleapis.com' || u.origin === 'https://oauth2.googleapis.com', true);
    assert.equal(options.redirect, 'manual');
    if (u.hostname === 'oauth2.googleapis.com') {
      refreshes++;
      if (fail?.where === 'auth') return Response.json({ error: fail.reason, error_description: auth }, { status: fail.status });
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      return Response.json({ access_token: auth, expires_in: 3600, scope: DRIVE_SCOPE });
    }
    if (u.pathname.endsWith('/generateIds')) return Response.json({ ids: ['local_file_' + (++serial)] });
    if (options.method === 'PUT') {
      uploads++;
      if (fail?.where === 'upload') {
        if (fail.status === 0) throw new Error(auth);
        return Response.json({ error: { message: auth, errors: [{ reason: fail.reason }] } }, { status: fail.status });
      }
      const metadata = sessions.get(u.searchParams.get('upload_id'));
      const bytes = await new Response(options.body).arrayBuffer();
      assert.equal(Number(options.headers['Content-Length']), bytes.byteLength);
      files.set(metadata.id, { ...metadata, size: String(bytes.byteLength + (badSize ? 1 : 0)), trashed: false });
      if (loseAck) throw new Error(auth);
      return Response.json({ id: metadata.id });
    }
    if (options.method === 'POST') {
      const metadata = JSON.parse(options.body);
      if (u.pathname.startsWith('/upload/')) {
        sessions.set(metadata.id, metadata);
        return new Response(null, { headers: { Location: badLocation ? 'https://example.invalid/upload' : 'https://www.googleapis.com/upload/drive/v3/files?upload_id=' + metadata.id } });
      }
      assert.equal(u.pathname, '/drive/v3/files'); assert.equal(metadata.mimeType, FOLDER_MIME); creates++;
      if (files.has(metadata.id)) return new Response(null, { status: 409 });
      files.set(metadata.id, { ...metadata, trashed: false }); return Response.json({ id: metadata.id });
    }
    assert.equal(options.method ?? 'GET', 'GET');
    const row = files.get(u.pathname.split('/').at(-1));
    return row ? Response.json(row) : new Response(null, { status: 404 });
  };
  return { fetcher, files, get creates() { return creates; }, get uploads() { return uploads; }, get refreshes() { return refreshes; } };
}
test('successful submission schedules exactly once; replay and queue insertion do not change cases', async () => {
  const { c, env } = await fresh();
  await h.local.setAuthConfig(config());
  try {
    const submitted = await h.makeCase();
    assert.ok(await jobFor(submitted));
    await ensureCaseBackups(env, c.id); await ensureCaseBackups(env, c.id);
    assert.equal((await h.local.db.prepare('SELECT count(*) AS n FROM proof_backups WHERE file_id=?').bind((await jobFor(c)).file_id).first()).n, 1);
    const replay = await h.local.fetch('/api/cases', 'POST', c.body, c.headers); assert.equal(replay.status, 201);
    assert.equal((await replay.json()).data.case_id, c.case_id);
  } finally { await h.local.setAuthConfig({ GOOGLE_DRIVE_BACKUP_ENABLED: undefined }); }
});
test('streamed resumable upload confirmed only after independent metadata; no source deletion', async () => {
  const { c, env } = await fresh(), mock = googleMock();
  const report = await processBackups(env, { fetcher: mock.fetcher }); assert.equal(report.confirmed, 1);
  const job = await jobFor(c); assert.equal(job.status, 'confirmed'); assert.equal(job.attempts, 1); assert.ok(job.completed_at);
  assert.equal((await env.PROOFS_BUCKET.head(job.source_object_key)).size, job.source_size);
  const meta = mock.files.get(job.drive_file_id); assert.equal(meta.name, c.case_id + '.png'); assert.equal(mock.refreshes, 1);
  assert.equal(mock.creates, 2); assert.equal(mock.uploads, 1);
  const saved = JSON.stringify(job); assert.equal(/access_token|refresh_token|client_secret|upload_id/.test(saved), false);
});
for (const [label, status, reason, code, retryable] of [
  ['429',429,null,'RATE_LIMIT',true], ['rate-limited 403',403,'userRateLimitExceeded','RATE_LIMIT',true],
  ['500',500,null,'GOOGLE_UNAVAILABLE',true], ['503',503,null,'GOOGLE_UNAVAILABLE',true],
  ['network',0,null,'NETWORK',true], ['partial',308,null,'UPLOAD_INCOMPLETE',true],
  ['Drive full',403,'storageQuotaExceeded','DRIVE_FULL',false], ['denied',403,'insufficientPermissions','DRIVE_ACCESS_DENIED',false],
]) test(label + ' failure never confirms, uses sanitized category and bounded retry', async () => {
  const { c, env } = await fresh(), mock = googleMock({ fail: { where: 'upload', status, reason } });
  await processBackups(env, { fetcher: mock.fetcher }); const job = await jobFor(c);
  assert.equal(job.status, 'failed'); assert.equal(job.last_error_code, code);
  if (retryable) assert.ok(job.next_attempt_at >= seconds() + 55 && job.next_attempt_at <= seconds() + 90); else assert.equal(job.next_attempt_at, null);
  assert.ok(await env.PROOFS_BUCKET.head(job.source_object_key));
  await processBackups(env, { fetcher: mock.fetcher }); assert.equal(mock.uploads, 1);
});
for (const reason of ['invalid_grant','invalid_client']) test('OAuth ' + reason + ' blocks provider without persisting upstream details', async () => {
  const { c, env } = await fresh(), mock = googleMock({ fail: { where: 'auth', status: 400, reason } });
  await processBackups(env, { fetcher: mock.fetcher }); const job = await jobFor(c);
  assert.equal(job.last_error_code, reason === 'invalid_grant' ? 'OAUTH_REVOKED' : 'OAUTH_CONFIG'); assert.equal(job.next_attempt_at, null);
  await processBackups(env, { fetcher: mock.fetcher }); assert.equal(mock.refreshes, 1);
});
test('no due jobs / disabled feature / absent migration do not access Google', async () => {
  const { env } = await fresh();
  const forbidden = () => assert.fail('unexpected outbound request');
  assert.equal((await processBackups({ ...env, GOOGLE_DRIVE_BACKUP_ENABLED: undefined }, { fetcher: forbidden })).state, 'disabled');
  await env.DB.prepare('DELETE FROM proof_backups').run();
  assert.equal((await processBackups(env, { fetcher: forbidden })).state, 'idle');
  const absent = { ...env, DB: { prepare() { throw new Error('unavailable'); } } };
  assert.equal((await processBackups(absent, { fetcher: forbidden })).state, 'unavailable');
  const pending = []; await worker.scheduled({}, { GOOGLE_DRIVE_BACKUP_ENABLED: undefined }, { waitUntil(p) { pending.push(p); } });
  assert.equal(pending.length, 0);
  await worker.scheduled({}, { DRIVE_BACKUP_TRANSPORT:'worker_oauth_legacy' }, { waitUntil(p) { pending.push(p); } });
  assert.equal((await pending[0]).state, 'disabled');
});
test('lost upload acknowledgement reconciles the same reserved ID without another upload', async () => {
  const { c, env } = await fresh(), mock = googleMock({ loseAck: true });
  await processBackups(env, { fetcher: mock.fetcher }); const first = await jobFor(c); assert.equal(first.status, 'failed');
  await env.DB.prepare('UPDATE proof_backups SET next_attempt_at=0 WHERE id=?').bind(first.id).run();
  assert.equal((await processBackups(env, { fetcher: mock.fetcher })).confirmed, 1);
  assert.equal((await jobFor(c)).drive_file_id, first.drive_file_id); assert.equal(mock.uploads, 1); assert.equal(mock.creates, 2);
});
test('byte mismatch and unsafe upload URI never confirm or forward credentials', async () => {
  for (const options of [{ badSize: true }, { badLocation: true }]) {
    const { c, env } = await fresh(), mock = googleMock(options); await processBackups(env, { fetcher: mock.fetcher });
    const job = await jobFor(c); assert.equal(job.status, 'failed'); assert.equal(job.last_error_code, 'VERIFY_FAILED');
  }
});
test('missing R2 source / inaccessible root are safely reported, never deleted', async () => {
  let { c, env } = await fresh(), mock = googleMock(); const old = await jobFor(c);
  // Fixture removal is solely in disposable local R2; processor contains no delete.
  await env.PROOFS_BUCKET.delete(old.source_object_key); await processBackups(env, { fetcher: mock.fetcher });
  assert.equal((await jobFor(c)).last_error_code, 'SOURCE_MISSING'); assert.equal(mock.uploads, 0);
  ({ c, env } = await fresh()); mock = googleMock({ missingRoot: true }); await processBackups(env, { fetcher: mock.fetcher });
  assert.equal((await jobFor(c)).last_error_code, 'ROOT_INACCESSIBLE'); assert.equal(mock.creates, 0);
});
test('two processors and simultaneous claims cannot upload the same proof twice', async () => {
  const { c, env } = await fresh(), mock = googleMock();
  await Promise.all([processBackups(env, { fetcher: mock.fetcher }), processBackups(env, { fetcher: mock.fetcher })]);
  assert.equal(mock.uploads, 1); assert.equal((await jobFor(c)).status, 'confirmed');
  await fresh(); const claims = await Promise.all([claimBackup(env.DB), claimBackup(env.DB)]); assert.equal(claims.filter(Boolean).length, 1);
});
test('expired lease recovers same logical backup; eight attempts terminate', async () => {
  const { c, env } = await fresh(), claimed = await claimBackup(env.DB), mock = googleMock();
  await env.DB.prepare('UPDATE proof_backups SET lease_until=0,drive_file_id=? WHERE id=?').bind('reserved_restart', claimed.id).run();
  await processBackups(env, { fetcher: mock.fetcher }); assert.equal((await jobFor(c)).drive_file_id, 'reserved_restart');
  await fresh(); const last = await claimBackup(env.DB);
  await env.DB.prepare('UPDATE proof_backups SET lease_until=0,attempts=8 WHERE id=?').bind(last.id).run();
  await processBackups(env, { fetcher: mock.fetcher }); const exhausted = await env.DB.prepare('SELECT * FROM proof_backups WHERE id=?').bind(last.id).first();
  assert.equal(exhausted.status, 'failed'); assert.equal(exhausted.next_attempt_at, null);
  assert.ok(backoff(30, 0) <= 86400);
});
test('folder identity survives campaign rename and local date routes correctly without member PII', async () => {
  const { c, env } = await fresh(), mock = googleMock(); await processBackups(env, { fetcher: mock.fetcher });
  await env.DB.prepare("UPDATE campaigns SET name='Renamed campaign' WHERE campaign_id='LOCAL-TEST'").run();
  const second = await h.makeCase(); await ensureCaseBackups(env, second.id); await processBackups(env, { fetcher: mock.fetcher });
  assert.equal(mock.creates, 2); assert.equal((await jobFor(c)).drive_folder_id, (await jobFor(second)).drive_folder_id);
  const route = backupRoute({ case_id: c.case_id, source_size: 3, source_mime: 'image/jpeg', source_object_key: 'private.jpg',
    campaign_id: 'C-local', campaign_name: 'Local / campaign', campaign_timezone: 'Asia/Taipei', case_created_at: '2026-10-12T16:30:00Z', nickname: 'never-name', email: 'private@example.invalid' });
  assert.equal(route.day, '2026-10-13'); assert.equal(route.name, c.case_id + '.jpg');
  assert.equal(JSON.stringify(route).includes('private@example.invalid') || JSON.stringify(route).includes('never-name'), false);
});
test('bounded processor never exceeds one job', async () => {
  const { env } = await fresh(), mock = googleMock();
  for (let i = 0; i < 5; i++) { const c = await h.makeCase(); await ensureCaseBackups(env, c.id); }
  const report = await processBackups(env, { fetcher: mock.fetcher, maxJobs: 100 }); assert.ok(report.processed > 0 && report.processed === 1); assert.equal(mock.uploads, report.processed);
  assert.equal((await env.DB.prepare("SELECT count(*) AS n FROM proof_backups WHERE status='pending'").first()).n, 6-report.processed);
});
test('bounded backfill dry run is read-only; rerun skips all existing/confirmed jobs and reports missing objects', async () => {
  const { c, env } = await fresh(); await env.DB.prepare('DELETE FROM proof_backups').run();
  const dry = await backfillBackups(env, { dryRun: true }); assert.equal(dry.enqueued, 0); assert.ok(dry.scanned <= 25);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM proof_backups').first()).n, 0);
  assert.equal(dry.ready.length + dry.missing.length + dry.changed.length, dry.scanned);
  let page = dry; while (page) { const out = await backfillBackups(env, { dryRun: false, after: page.previous ?? '' }); page = out.next_cursor ? { previous: out.next_cursor } : null; }
  const count = (await env.DB.prepare('SELECT count(*) AS n FROM proof_backups').first()).n;
  await backfillBackups(env, { dryRun: false }); assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM proof_backups').first()).n, count);
  assert.ok(await jobFor(c));
});
test('admin retry/backfill require server role, MFA, CSRF and atomic immutable audit', async () => {
  const { c, env } = await fresh(), admin = await h.identity({ role: 'admin' }), reviewer = await h.identity({ role: 'reviewer' }), member = await h.identity();
  await h.local.setAuthConfig(config());
  const lowMfa = await h.identity({ role: 'admin', elevated: false });
  const job = await jobFor(c); await env.DB.prepare("UPDATE proof_backups SET status='failed',next_attempt_at=NULL,last_error_code='OAUTH_REVOKED' WHERE id=?").bind(job.id).run();
  const route = '/api/admin/backups/' + job.id + '/retry', body = { expected_version: 0 };
  for (const [identity, code] of [[member,403],[reviewer,403],[lowMfa,403]]) assert.equal((await h.local.fetch(route,'POST',body,identity.headers)).status, code);
  assert.equal((await h.local.fetch(route,'POST',body)).status, 401);
  assert.equal((await h.local.fetch(route,'POST',body,{ ...admin.headers,'X-CSRF-Token':'invalid' })).status,403);
  assert.equal((await h.local.fetch(route,'POST',body,admin.headers)).status,200);
  assert.equal((await h.local.fetch(route,'POST',body,admin.headers)).status,409);
  assert.equal((await jobFor(c)).status,'pending');
  const audit = await env.DB.prepare("SELECT * FROM backup_admin_audit WHERE target_id=? AND action='retry'").bind(job.id).first(); assert.equal(audit.affected_count,1);
  await assert.rejects(env.DB.prepare('DELETE FROM backup_admin_audit WHERE id=?').bind(audit.id).run());
  const summary = await h.local.fetch('/api/admin/backups','GET',undefined,admin.headers); assert.equal(summary.status,200);
  const safe = JSON.stringify((await summary.json()).data); assert.equal(/source_object_key|access_token|refresh_token|client_secret/.test(safe),false);
  const existing = (await env.DB.prepare('SELECT count(*) AS n FROM backup_admin_audit').first()).n;
  const dry = await h.local.fetch('/api/admin/backups/backfill','POST',{dry_run:true},admin.headers); assert.equal(dry.status,200);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM backup_admin_audit').first()).n,existing);
  const write = await h.local.fetch('/api/admin/backups/backfill','POST',{dry_run:false},admin.headers); assert.equal(write.status,200);
  const added = await h.makeCase(); const proof = await env.DB.prepare('SELECT id FROM case_files WHERE case_id=?').bind(added.id).first();
  await h.local.fetch('/api/admin/backups/backfill','POST',{dry_run:false},admin.headers);
  const queued = await env.DB.prepare('SELECT id FROM proof_backups WHERE file_id=?').bind(proof.id).first(); assert.ok(queued);
  assert.equal((await h.local.fetch('/api/admin/backups/'+queued.id+'/retry','POST',body,admin.headers)).status,409);
});

test('exact reviewed backfill selection queues only those proofs; audit failure rolls retry back', async () => {
  const { c, env } = await fresh(), admin = await h.identity({role:'admin'}), selected = await jobFor(c);
  await env.DB.prepare('DELETE FROM proof_backups').run();
  const other = await h.makeCase();
  await h.local.setAuthConfig(config());
  const request = {dry_run:false,file_ids:[selected.file_id]};
  const response = await h.local.fetch('/api/admin/backups/backfill','POST',request,admin.headers);
  assert.equal(response.status,200); assert.equal((await response.json()).data.enqueued,1);
  assert.ok(await jobFor(c)); assert.equal(await jobFor(other),null);
  for (const file_ids of [[],[selected.file_id,selected.file_id],['invalid']]) {
    assert.equal((await h.local.fetch('/api/admin/backups/backfill','POST',{dry_run:false,file_ids},admin.headers)).status,400);
  }
  const job=await jobFor(c);
  await env.DB.prepare("UPDATE proof_backups SET status='failed',last_error_code='OAUTH_REVOKED',next_attempt_at=NULL WHERE id=?").bind(job.id).run();
  await env.DB.prepare("CREATE TRIGGER local_backup_audit_failure BEFORE INSERT ON backup_admin_audit BEGIN SELECT RAISE(ABORT,'local fixture'); END").run();
  try {
    assert.equal((await h.local.fetch('/api/admin/backups/'+job.id+'/retry','POST',{expected_version:job.version},admin.headers)).status,503);
    assert.deepEqual(await jobFor(c),{...job,status:'failed',last_error_code:'OAUTH_REVOKED',next_attempt_at:null});
  } finally { await env.DB.prepare('DROP TRIGGER local_backup_audit_failure').run(); }
});

test('changed R2 proof is never uploaded and redirects never forward credentials', async () => {
  const {c,env}=await fresh(),job=await jobFor(c),mock=googleMock();
  await env.PROOFS_BUCKET.put(job.source_object_key,new Uint8Array([3,2,1]),{httpMetadata:{contentType:'image/png'}});
  await processBackups(env,{fetcher:mock.fetcher});
  assert.equal((await jobFor(c)).last_error_code,'SOURCE_CHANGED'); assert.equal(mock.refreshes,0);
  let calls=0;
  const drive=new DriveClient(config(),async (_url,init)=>{
    calls++;assert.equal(init.redirect,'manual');return new Response(null,{status:307,headers:{Location:'https://example.invalid/redirect'}});
  });
  await assert.rejects(drive.access(),{code:'OAUTH_CONFIG'});assert.equal(calls,1);
});
test('local FK/quick_check, gate and ledger unchanged by backup processing', async () => {
  const { env } = await fresh(), before = await env.DB.prepare('SELECT count(*) AS n FROM point_transactions').first();
  const mock = googleMock(); await processBackups(env, { fetcher: mock.fetcher });
  assert.deepEqual((await env.DB.prepare('PRAGMA foreign_key_check').all()).results,[]);
  assert.equal((await env.DB.prepare('PRAGMA quick_check').first()).quick_check,'ok');
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM point_transactions').first()).n,before.n);
  // Only isolated fixture gate changed; processor never touches submission settings.
  await env.DB.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
  assert.equal((await processBackups(env,{fetcher:mock.fetcher})).processed,0);
  assert.equal((await env.DB.prepare('SELECT submissions_enabled FROM submission_settings WHERE id=1').first()).submissions_enabled,0);
});
