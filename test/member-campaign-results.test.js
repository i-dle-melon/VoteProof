import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { embeddedCaseRuntime } from './helpers/embedded-case-runtime.mjs';

test('campaign results are private, read from the existing ledger, and respect closed and visible campaign scope', async t => {
  const f = await embeddedCaseRuntime();
  t.after(() => f.close());
  t.mock.method(globalThis, 'fetch', url => {
    assert.match(String(url), /\/turnstile\//);
    return Response.json({ success: true });
  });
  const admin = await f.identity('super_admin');
  const member = await f.identity();
  const other = await f.identity();
  const timestamp = new Date().toISOString();
  const voteDate = timestamp.slice(0, 10);
  const seedCampaign = (id, end, isPublic) => {
    f.sqlite.prepare(`INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,
      points_per_proof,status,created_at,updated_at)
      VALUES(?,?,'團體','2000-01-01',?,'Asia/Taipei','2000-01-01','2099-12-31',3,'active',?,?)`)
      .run(id, id, end, timestamp, timestamp);
    f.sqlite.prepare(`INSERT INTO leaderboards(leaderboard_id,name,type,campaign_id,top_n,is_public,status,created_at,updated_at,created_by,updated_by)
      VALUES(?,?,'campaign',?,100,?,'active',?,?,?,?)`)
      .run('board-' + id, id, id, isPublic, timestamp, timestamp, admin.memberId, admin.memberId);
  };
  seedCampaign('STAMP-PUBLIC', '2100-01-01', 1);
  seedCampaign('STAMP-OPEN', '2100-01-01', 1);
  seedCampaign('STAMP-PRIVATE', '2001-01-01', 0);
  seedCampaign('STAMP-EMPTY', '2001-01-01', 1);
  f.sqlite.exec('UPDATE submission_settings SET submissions_enabled=1');

  async function approvedCase(owner) {
    const { ref } = await f.upload('STAMP-PUBLIC', owner);
    const response = await f.fetch('/api/cases/direct', 'POST', {
      campaign_id: 'STAMP-PUBLIC', vote_date: voteDate, upload_session: ref,
    }, { ...owner.headers, 'Idempotency-Key': randomUUID() });
    assert.equal(response.status, 201, await response.clone().text());
    const { case_id } = (await response.json()).data;
    const review = await f.fetch('/api/admin/cases/' + case_id + '/review', 'POST', {
      action: 'approve', expected_version: 0,
    }, admin.headers);
    assert.equal(review.status, 200, await review.clone().text());
    return case_id;
  }

  const reversed = await approvedCase(member);
  await approvedCase(member);
  await approvedCase(other);
  const revoke = await f.fetch('/api/admin/cases/' + reversed + '/review', 'POST', {
    action: 'revoke', expected_version: 1, reason: 'Synthetic reversal',
  }, admin.headers);
  assert.equal(revoke.status, 200, await revoke.clone().text());
  f.sqlite.exec("UPDATE campaigns SET status='closed' WHERE campaign_id='STAMP-PUBLIC'");

  const path = '/api/me/campaign-results';
  assert.equal((await f.fetch(path)).status, 401);
  assert.equal((await f.fetch(path + '?member_id=' + other.memberId, 'GET', undefined, member.headers)).status, 400);
  const response = await f.fetch(path, 'GET', undefined, member.headers);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const rows = (await response.json()).data.campaigns;
  assert.deepEqual(rows.map(({ campaign_id, points, proof_count }) => [campaign_id, points, proof_count]), [
    ['STAMP-PUBLIC', 3, 1], ['STAMP-EMPTY', 0, 0],
  ]);
  assert.equal(rows[0].leaderboard_id, 'board-STAMP-PUBLIC');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['campaign_id','name','category','end_at','leaderboard_id','points','proof_count'].sort());
});
