import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';
import worker from '../src/index.js';
import { CASE_COMPLETION_CRON, completeDueCases } from '../src/lib/case-auto-completion.js';
import { installResetExtensionLocal } from '../scripts/lib/prelaunch-selective-reset.mjs';
import { localAdminRuntime } from '../scripts/lib/local-admin-runtime.mjs';
import { measuredD1 } from '../scripts/lib/measured-d1.mjs';
import { embeddedCaseRuntime, origin } from './helpers/embedded-case-runtime.mjs';

const now = new Date('2026-11-20T06:00:00.000Z');
const cutoff = '2026-11-13T06:00:00.000Z';
const approvals = new Map([
  ['boundary', [cutoff, cutoff]],
  ['legacy', [null, '2026-11-12T06:00:00.000Z']],
  ['fresh', ['2026-11-13T06:00:00.001Z', cutoff]],
  ['invalid', ['now', cutoff]]
]);

async function installCompletion(db) {
  const sql = await readFile(new URL('../migrations-case-completion/0001_automatic_completion.sql', import.meta.url), 'utf8');
  await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
}

async function fixture(t, names) {
  const f = await embeddedCaseRuntime();
  t.after(() => f.close());
  const put = f.bucket.put;
  f.bucket.put = async (...args) => {
    const object = await put(...args);
    if (object) object.version = crypto.randomUUID();
    return object;
  };
  f.sqlite.exec(await readFile(new URL('../migrations-storage-policy/0001_observe_capacity.sql', import.meta.url), 'utf8'));
  f.sqlite.exec("UPDATE storage_capacity SET upload_policy='observe'");
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(String(url), /\/turnstile\//);
    return Response.json({ success: true });
  });
  const admin = await f.identity('super_admin');
  await f.db.prepare("UPDATE submission_settings SET submissions_enabled=1").run();
  f.env.STORAGE_CAPACITY_ENFORCEMENT = 'disabled';
  await f.db.prepare(`INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,
    vote_end_date,points_per_proof,status,created_at,updated_at) VALUES('AUTOCOMPLETE','Synthetic','團體','2000-01-01',
    '2100-01-01','Asia/Taipei','2000-01-01','2099-12-31',3,'active',?,?)`).bind(cutoff, cutoff).run();
  const ids = {};
  for (const name of names) {
    const member = await f.identity();
    const { ref } = await f.upload('AUTOCOMPLETE', member);
    const response = await f.fetch('/api/cases/direct', 'POST', {
      campaign_id: 'AUTOCOMPLETE', vote_date: new Date().toISOString().slice(0, 10), upload_session: ref
    }, { ...member.headers, 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(response.status, 201, await response.clone().text());
    ids[name] = (await response.json()).data.case_id;
    if (name === 'pending') continue;
    const review = await f.fetch('/api/admin/cases/' + ids[name] + '/review', 'POST',
      { action: 'approve', expected_version: 0 }, admin.headers);
    assert.equal(review.status, 200, await review.text());
    f.sqlite.prepare('UPDATE cases SET status_updated_at=?, reviewed_at=? WHERE case_id=?')
      .run(...(approvals.get(name) ?? [cutoff, cutoff]), ids[name]);
  }
  await installCompletion(f.db);
  const getCase = name => ({ ...f.sqlite.prepare('SELECT * FROM cases WHERE case_id=?').get(ids[name]) });
  const audits = () => f.sqlite.prepare('SELECT * FROM case_auto_completion_audit ORDER BY case_id').all();
  return { ...f, getCase, audits, ids };
}

test('native local D1 installs completion separately on populated 0028 and preserves checked data', async t => {
  const h = await localAdminRuntime(), db = h.local.db;
  t.after(() => h.local.runtime.dispose());
  const admin = await h.identity({ role: 'super_admin' }), member = await h.identity();
  const item = await h.makeCase({ member });
  assert.equal((await h.review(admin, item.case_id, 'approve')).status, 200);
  await db.prepare('UPDATE cases SET reviewed_at=?,status_updated_at=? WHERE id=?').bind(cutoff,cutoff,item.id).run();
  const storedCase = () => db.prepare('SELECT * FROM cases WHERE id=?').bind(item.id).first();
  const points = async () => (await db.prepare('SELECT * FROM point_transactions ORDER BY transaction_id').all()).results;
  const schema = async () => (await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
  const beforeCase = await storedCase(), beforePoints = await points(), beforeSchema = await schema();
  await installCompletion(db);
  assert.deepEqual(await storedCase(), beforeCase);
  const afterSchema = await schema();
  const added = afterSchema.filter(row => !beforeSchema.some(prior => prior.name === row.name));
  assert.equal(added.length, 5);
  assert.deepEqual(afterSchema.filter(row => !added.includes(row)), beforeSchema);
  const native = measuredD1(db);
  assert.equal(await completeDueCases(native.db, now), 1);
  const after = await storedCase();
  const receipt = await db.prepare('SELECT * FROM case_auto_completion_audit WHERE id=?').bind(after.last_review_id).first();
  assert.equal(after.status, 'completed');
  assert.equal(receipt.approval_review_id, beforeCase.last_review_id);
  assert.equal(receipt.completed_version, beforeCase.version + 1);
  assert.equal(receipt.approved_at, beforeCase.status_updated_at);
  assert.deepEqual(await points(), beforePoints);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  t.diagnostic('one synthetic completion native D1 metadata: ' + JSON.stringify(native.totals()));
});

test('seven-day boundary and legacy timestamp preserve human approval and awarded points', async t => {
  const f = await fixture(t, [...approvals.keys(), 'pending']);
  const originals = Object.fromEntries([...approvals.keys(), 'pending'].map(name => [name, f.getCase(name)]));
  const ledger = () => f.sqlite.prepare('SELECT * FROM point_transactions ORDER BY transaction_id').all();
  const humanAudit = () => f.sqlite.prepare('SELECT * FROM admin_audit_logs ORDER BY id').all();
  const [priorPoints, priorAudit] = [ledger(), humanAudit()];
  f.env.PROOFS_BUCKET = new Proxy({}, { get() { assert.fail('Completion must not use R2'); } });
  assert.equal(await completeDueCases(f.db, now), 2);
  for (const name of ['boundary', 'legacy']) {
    const audit = f.audits().find(row => row.case_id === f.ids[name]);
    assert.equal(audit.approval_review_id, originals[name].last_review_id);
    assert.equal(audit.approved_at, originals[name].status_updated_at ?? originals[name].reviewed_at);
    assert.equal(audit.completed_at, now.toISOString());
    assert.deepEqual(f.getCase(name), {
      ...originals[name], status: 'completed', version: 2, last_review_id: audit.id,
      status_updated_at: now.toISOString(), updated_at: now.toISOString(), status_updated_by: null
    });
  }
  for (const name of ['fresh', 'invalid', 'pending']) assert.deepEqual(f.getCase(name), originals[name]);
  assert.deepEqual(ledger(), priorPoints);
  assert.deepEqual(humanAudit(), priorAudit);
  assert.equal(await completeDueCases(f.db, now), 0);
  assert.equal(f.audits().length, 2);
  assert.throws(() => f.sqlite.exec('DELETE FROM case_auto_completion_audit'), /immutable/);
});

test('concurrent manual completion wins the version check and receives no automatic audit', async t => {
  const f = await fixture(t, ['boundary']);
  const db = { ...f.db, batch: rows => {
    f.sqlite.prepare("UPDATE cases SET status='completed', version=2 WHERE case_id=?").run(f.ids.boundary);
    return f.db.batch(rows);
  }};
  assert.equal(await completeDueCases(db, now), 0);
  assert.equal(f.audits().length, 0);
});

test('audit write failure rolls back the automatic case transition', async t => {
  const f = await fixture(t, ['boundary']);
  const original = f.getCase('boundary');
  f.sqlite.exec('DROP TABLE case_auto_completion_audit');
  await assert.rejects(completeDueCases(f.db, now), /case_auto_completion_audit/);
  assert.deepEqual(f.getCase('boundary'), original);
});

test('catch-up completes at most 200 cases per transaction and leaves the points ledger untouched', async t => {
  const names = Array.from({ length: 201 }, (_, index) => 'backlog-' + index);
  const f = await fixture(t, names);
  const ledger = () => f.sqlite.prepare('SELECT * FROM point_transactions ORDER BY transaction_id').all();
  const before = ledger();
  const db = { ...f.db, batch: statements => {
    assert.equal(statements.length, 3);
    return f.db.batch(statements);
  }};
  assert.equal(await completeDueCases(db, now), 200);
  assert.equal(f.audits().length, 200);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM cases WHERE status='approved'").get().n, 1);
  assert.equal(await completeDueCases(db, now), 1);
  assert.equal(await completeDueCases(db, now), 0);
  assert.equal(f.audits().length, 201);
  assert.deepEqual(ledger(), before);
});

test('a skipped case update rolls back every completion receipt in the transaction', async t => {
  const f = await fixture(t, ['boundary','legacy']);
  const before = ['boundary','legacy'].map(f.getCase);
  f.sqlite.exec(`CREATE TRIGGER fixture_ignore_direct_completion BEFORE UPDATE OF status ON cases
    WHEN OLD.case_id='${f.ids.boundary}' AND NEW.status='completed'
    BEGIN SELECT RAISE(IGNORE); END;`);
  await assert.rejects(completeDueCases(f.db, now), /CHECK constraint failed/);
  assert.deepEqual(['boundary','legacy'].map(f.getCase), before);
  assert.deepEqual(f.audits(), []);
});

test('scheduled entry stays off by default and respects the existing reset mutation fence', async t => {
  const f = await fixture(t, ['legacy']);
  f.sqlite.prepare('UPDATE cases SET reviewed_at=? WHERE case_id=?')
    .run(new Date(Date.now() - 8 * 86400000).toISOString(), f.ids.legacy);
  const sql = await readFile(new URL('../migrations-reset-v1/0001_reset_fence.sql', import.meta.url), 'utf8');
  installResetExtensionLocal(f.sqlite, sql);
  f.sqlite.exec("UPDATE prelaunch_reset_control SET epoch=1,mode='maintenance'");
  f.env.PRELAUNCH_RESET_FENCE_ENABLED = 'true';
  const event = { cron: CASE_COMPLETION_CRON };
  await worker.scheduled(event, f.env);
  f.env.CASE_AUTO_COMPLETE_ENABLED = 'true';
  await assert.rejects(worker.scheduled(event, f.env), { code: 'PRELAUNCH_MAINTENANCE' });
  assert.equal(f.getCase('legacy').status, 'approved');
  f.sqlite.exec("UPDATE prelaunch_reset_control SET mode='open'");
  await worker.scheduled(event, f.env);
  assert.equal(f.getCase('legacy').status, 'completed');
  assert.equal(f.audits().length, 1);
  const publicResponse = await f.fetch('/api/case-auto-completion', 'POST', {}, { Origin: origin });
  assert.ok([403, 404, 405].includes(publicResponse.status));
});
