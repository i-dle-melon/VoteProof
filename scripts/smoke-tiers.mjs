import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localAdminRuntime } from './lib/local-admin-runtime.mjs';
import { configureLocalTiers } from './lib/local-tier-fixture.mjs';
const h = await localAdminRuntime(), {local} = h;
try {
  const admin = await h.identity({role:'admin'}), member = await h.identity(), reviewer = await h.identity({role:'reviewer'});
  const points = async () => (await (await local.fetch('/api/me/points','GET',undefined,member.headers)).json()).data;
  assert.equal((await points()).tier_configuration_ready,false); await configureLocalTiers(local,admin);
  assert.equal((await points()).tier_configuration_ready,true);
  const campaign = 'TIER-SMOKE-'+randomUUID(); await local.campaign({campaign_id:campaign,points_per_proof:100,daily_limit:1});
  const proof = await h.makeCase({member,metadata:{campaign_id:campaign}});
  assert.equal((await h.review(reviewer,proof.case_id,'approve')).status,200); assert.equal((await points()).tier.tier_id,'bronze');
  assert.equal((await h.review(admin,proof.case_id,'complete',1)).status,200); assert.equal((await points()).total_points,100);
  assert.equal((await h.review(admin,proof.case_id,'revoke',2,{reason:'Local smoke'})).status,200); assert.equal((await points()).tier.tier_id,'normal');
  const adjustment = await local.fetch('/api/admin/points/adjustments','POST',{member_id:member.memberId,points:500,reason:'Local smoke'},
    {...admin.headers,'Idempotency-Key':randomUUID()}); assert.equal(adjustment.status,201); assert.equal((await points()).tier.tier_id,'silver');
  assert.deepEqual((await local.db.prepare('PRAGMA foreign_key_check').all()).results,[]); assert.equal(local.emails.length,0);
  console.log('B5D smoke PASS: pending config fallback, explicit local thresholds, ledger promotion/revoke demotion, completion, manual adjustment, progress; no Production resources');
} finally { await local.runtime.dispose(); }
