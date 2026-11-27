import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { unstable_splitSqlQuery } from 'wrangler';
import { embeddedCaseRuntime } from './helpers/embedded-case-runtime.mjs';
import { localAdminRuntime } from '../scripts/lib/local-admin-runtime.mjs';

const adminPath = '/api/admin/activity-stamps';
const resultsPath = '/api/me/campaign-results';
const migrationFile = new URL('../migrations-activity-stamps/0001_activity_stamps.sql', import.meta.url);

function png(firstAlpha, secondAlpha) {
  function chunk(name, data) {
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    const payload = Buffer.concat([Buffer.from(name), data]);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(payload));
    return Buffer.concat([size, payload, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const data = deflateSync(Buffer.from([0, 0, 0, 0, firstAlpha, 255, 255, 255, secondAlpha]));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', data), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

test('activity stamp administration, private member progress and artwork work on populated D1 schema', async t => {
  const f = await embeddedCaseRuntime();
  t.after(() => f.close());
  t.mock.method(globalThis, 'fetch', url => {
    assert.match(String(url), /\/turnstile\//);
    return Response.json({ success: true });
  });
  const admin = await f.identity('admin'), reviewer = await f.identity('reviewer');
  const member = await f.identity(), other = await f.identity();
  const now = new Date().toISOString(), voteDate = now.slice(0, 10);
  const campaign = 'STAMP-TEST-CAMPAIGN';
  f.sqlite.prepare(`INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,
    vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at)
    VALUES(?,?,'團體','2000-01-01T00:00:00.000Z','2099-12-31T00:00:00.000Z','Asia/Taipei',
      '2000-01-01','2099-12-31',3,'active',?,?)`).run(campaign, '合成活動', now, now);
  f.sqlite.exec('UPDATE submission_settings SET submissions_enabled=1');

  const request = async (path, method, body, headers, status = 200) => {
    const result = await f.fetch(path, method, body, headers);
    assert.equal(result.status, status, await result.clone().text());
    return result;
  };
  const data = async (...args) => (await (await request(...args)).json()).data;
  await request(adminPath, 'GET', undefined, admin.headers, 503);
  f.sqlite.exec(await readFile(migrationFile, 'utf8'));
  await request(adminPath, 'GET', undefined, reviewer.headers, 403);
  await request(adminPath, 'GET', undefined, member.headers, 403);
  await request(resultsPath, 'GET', undefined, undefined, 401);
  const listing = await data(adminPath, 'GET', undefined, admin.headers);
  assert.deepEqual(listing.stamps, []);
  assert.ok(listing.campaigns.some(row => row.campaign_id === campaign));

  const custom_icon = png(0, 255);
  const rule = {
    campaign_id: campaign, name: '年度投稿集章', description: '跨兩個台灣日期投稿',
    opens_at: '2001-11-03T00:00:00.000Z', closes_at: '2001-11-05T00:00:00.000Z',
    min_proofs: 2, min_days: 2, status: 'draft', icon: 'custom', custom_icon,
    color: 'custom', custom_color: '#346789', sort_order: 10,
  };
  const { 'X-CSRF-Token': csrfHeader, ...withoutCsrf } = admin.headers;
  await request(adminPath, 'POST', rule, withoutCsrf, 403);
  await request(adminPath, 'POST', { ...rule, custom_icon: png(255, 255) }, admin.headers, 400);
  const { stamp } = await data(adminPath, 'POST', rule, admin.headers);
  assert.equal(stamp.version, 0);
  assert.equal(stamp.custom_icon, undefined);
  const asset = await request(stamp.custom_icon_url, 'GET', undefined, admin.headers);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await asset.arrayBuffer()).toString('base64'), custom_icon);
  const memberImage = version => '/api/me/activity-stamps/' + stamp.stamp_id + '/icon/' + version;
  await request(memberImage(0), 'GET', undefined, member.headers, 404);
  assert.deepEqual((await data(resultsPath, 'GET', undefined, member.headers)).campaigns, []);

  const stampPath = adminPath + '/' + stamp.stamp_id;
  const { custom_icon: newArtwork, ...savedFields } = rule;
  const update = { ...savedFields, status: 'published', expected_version: 0 };
  const { stamp: published } = await data(stampPath + '/update', 'POST', update, admin.headers);
  assert.equal(published.version, 1);
  await request(stampPath + '/update', 'POST', update, admin.headers, 409);
  await request(memberImage(1), 'GET', undefined, undefined, 401);

  async function addCase(owner, received, approved) {
    const { ref } = await f.upload(campaign, owner);
    const { case_id } = await data('/api/cases/direct', 'POST', {
      campaign_id: campaign, vote_date: voteDate, upload_session: ref,
    }, { ...owner.headers, 'Idempotency-Key': randomUUID() }, 201);
    if (approved) await request('/api/admin/cases/' + case_id + '/review', 'POST',
      { action: 'approve', expected_version: 0 }, admin.headers);
    f.sqlite.prepare('UPDATE cases SET created_at=? WHERE case_id=?').run(received, case_id);
  }
  await addCase(member, '2001-11-04T15:59:59.000Z', true);
  await addCase(member, '2001-11-04T16:00:00.000Z', true);
  await addCase(member, '2001-11-05T00:00:00.000Z', true);
  await addCase(member, '2001-11-04T16:15:00.000Z', false);
  const ledger = () => f.sqlite.prepare('SELECT * FROM point_transactions ORDER BY transaction_id').all();
  const before = ledger();

  const [earned] = (await data(resultsPath, 'GET', undefined, member.headers)).campaigns;
  assert.equal(earned.points, 9);
  assert.equal(earned.proof_count, 3);
  assert.deepEqual(earned.stamp, {
    earned: true, proof_count: 2, proof_days: 2, min_proofs: 2, min_days: 2,
    icon: 'custom', color: 'custom', description: rule.description, custom_color: '#346789',
    custom_icon_url: memberImage(1),
  });
  const [locked] = (await data(resultsPath, 'GET', undefined, other.headers)).campaigns;
  assert.equal(locked.stamp.earned, false);
  assert.equal(locked.stamp.proof_count, 0);
  assert.equal(locked.stamp.custom_icon_url, null);

  await request(stampPath + '/delete', 'POST', { expected_version: 0 }, admin.headers, 409);
  assert.deepEqual(await data(stampPath + '/delete', 'POST', { expected_version: 1 }, admin.headers), { removed: true });
  await request(memberImage(1), 'GET', undefined, member.headers, 404);
  assert.deepEqual((await data(resultsPath, 'GET', undefined, member.headers)).campaigns, []);
  assert.deepEqual(ledger(), before);
  assert.deepEqual(f.sqlite.prepare('SELECT action,version FROM activity_stamp_audit ORDER BY version').all()
    .map(row => [row.action, row.version]), [['create', 0], ['update', 1], ['delete', 2]]);
});

test('native local D1 installs the independent stamp schema and stores transparent artwork', async t => {
  const { local, identity } = await localAdminRuntime();
  t.after(() => local.runtime.dispose());
  const actor = await identity({ role: 'admin' });
  const campaignId = await local.campaign({ campaign_id: 'NATIVE-STAMP', category: '團體' });
  const before = await local.db.prepare('SELECT campaign_id,name FROM campaigns ORDER BY campaign_id').all();
  const sql = await readFile(migrationFile, 'utf8');
  await local.db.batch(unstable_splitSqlQuery(sql).map(statement => local.db.prepare(statement)));
  assert.deepEqual((await local.db.prepare('SELECT campaign_id,name FROM campaigns ORDER BY campaign_id').all()).results, before.results);
  const listing = await local.fetch(adminPath, 'GET', undefined, actor.headers);
  assert.equal(listing.status, 200, await listing.clone().text());
  const { campaigns } = (await listing.json()).data;
  assert.ok(campaigns.some(campaign => campaign.campaign_id === campaignId));
  const artwork = png(0, 255);
  const created = await local.fetch(adminPath, 'POST', {
    campaign_id: campaignId, name: 'Native fixture', description: '',
    opens_at: '2001-01-01T00:00:00.000Z', closes_at: '2001-02-01T00:00:00.000Z',
    min_proofs: 1, min_days: 1, status: 'draft', icon: 'custom', custom_icon: artwork, color: 'blue', sort_order: 0,
  }, actor.headers);
  assert.equal(created.status, 200, await created.clone().text());
  const { stamp } = (await created.json()).data;
  const image = await local.fetch(stamp.custom_icon_url, 'GET', undefined, actor.headers);
  assert.equal(image.status, 200);
  assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), artwork);
  assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results, []);
});

test('the existing MAMA badge is editable without a backfill and its first save is atomic', async t => {
  const f = await embeddedCaseRuntime();
  t.after(() => f.close());
  f.sqlite.exec(await readFile(migrationFile, 'utf8'));
  const actor = await f.identity('admin');
  const campaign = '2026_MAMA_Fans_Choice_2nd';
  const opens = '2001-01-01T00:00:00.000Z', closes = '2001-02-01T00:00:59.000Z';
  f.sqlite.prepare(`INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,
    vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at)
    VALUES(?,'MAMA original','團體',?,?,'Asia/Taipei','2001-01-01','2001-02-01',3,'closed',?,?)`)
    .run(campaign, opens, closes, opens, opens);
  f.sqlite.prepare(`INSERT INTO leaderboards(leaderboard_id,name,type,campaign_id,top_n,is_public,status,created_at,updated_at,created_by,updated_by)
    VALUES('board-mama','MAMA','campaign',?,100,1,'active',?,?,?,?)`).run(campaign, opens, opens, actor.memberId, actor.memberId);
  const get = async path => {
    const response = await f.fetch(path, 'GET', undefined, actor.headers);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).data;
  };
  const [legacy] = (await get(adminPath)).stamps;
  assert.equal(legacy.campaign_id, campaign);
  assert.equal(legacy.name, 'MAMA 第二輪');
  assert.equal(legacy.inherited, true);
  assert.equal(legacy.campaign_locked, true);
  assert.equal(legacy.icon, 'mama');
  assert.equal(legacy.color, 'blue');
  assert.equal(legacy.opens_at, opens);
  assert.equal(legacy.closes_at, closes);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM activity_stamps').get().count, 0);
  assert.equal((await get(resultsPath)).campaigns[0].stamp, undefined);

  const rule = {
    campaign_id: campaign, name: legacy.name, description: '', opens_at: opens, closes_at: closes,
    min_proofs: 1, min_days: 1, status: 'draft', icon: 'mama', color: 'blue', sort_order: 0,
  };
  const writes = await Promise.all([0, 1].map(() => f.fetch(adminPath + '/mama-default', 'POST', rule, actor.headers)));
  assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]);
  const [saved] = (await get(adminPath)).stamps;
  assert.equal(saved.stamp_id, legacy.stamp_id);
  assert.equal(saved.inherited, undefined);
  assert.equal(saved.status, 'draft');
  assert.equal((await get(resultsPath)).campaigns[0].stamp, undefined);
  const edit = await f.fetch(adminPath + '/' + saved.stamp_id + '/update', 'POST',
    { ...rule, status: 'published', expected_version: saved.version }, actor.headers);
  assert.equal(edit.status, 200, await edit.clone().text());
  const results = (await get(resultsPath)).campaigns;
  assert.equal(results.length, 1);
  assert.equal(results[0].stamp.icon, 'mama');
});
