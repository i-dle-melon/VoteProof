import assert from 'node:assert/strict';
import { localLeaderboardRuntime } from './lib/local-leaderboard-runtime.mjs';
const h = await localLeaderboardRuntime();
try {
  const member = await h.identity(), campaignId = await h.campaign();
  const proof = await h.award(member,campaignId);
  await h.adjust(member,3);
  const board = await h.create();
  const rebuild = await h.rebuild(board); assert.equal(rebuild.status,200,JSON.stringify(await rebuild.clone().json()));
  const first = await h.snapshot(board); assert.equal(first.rankings.find(r => r.member_id === member.memberId).points,13);
  assert.equal((await h.review(h.admin,proof.case_id,'complete',1)).status,200);
  assert.equal((await h.review(h.admin,proof.case_id,'revoke',2,{reason:'Local reversal'})).status,200);
  const races = await Promise.all([h.rebuild(board,h.admin,1),h.rebuild(board,h.admin,1)]);
  assert.deepEqual(races.map(r => r.status).sort(),[200,409]);
  const last = await h.snapshot(board); const row = last.rankings.find(r => r.member_id === member.memberId);
  assert.equal(row.points,3); assert.equal(row.proof_count,0);
  assert.deepEqual((await h.local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  assert.equal(h.local.unexpectedUpstreams.length,0);
  console.log('B5C smoke PASS: ledger source, immutable snapshots, exact reversal, manual adjustment, atomic publish, concurrent CAS and public contract');
} finally { await h.local.runtime.dispose(); }
