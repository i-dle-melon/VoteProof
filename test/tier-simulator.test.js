import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateTiers,proposal} from '../scripts/lib/tier-simulator.mjs';

for(const kind of ['participation','balanced','prestige'])test('Complete eight-tier preview '+kind,()=>{
 const p=proposal(kind,10),r=simulateTiers(p);assert.equal(r.tiers.length,8);assert.equal(r.application,'PREVIEW_ONLY');
 assert.deepEqual(r.tiers.map(t=>t.approvals_required),p.tiers.map(t=>t.min_points/10));
 assert.ok(r.examples.every(x=>x.tier_progress>=0&&x.tier_progress<=100));assert.equal(r.monotonicity,'PASS');
});
test('Accessibility uses explicit cohorts, not the three-member Production sample',()=>{
 const p=proposal('balanced');p.cohorts=[{population_percent:50,approvals_per_user:0},{population_percent:50,approvals_per_user:240}];
 const r=simulateTiers(p);assert.equal(r.tiers[0].estimated_population_percent_at_or_above,100);assert.equal(r.tiers[7].estimated_population_percent_at_or_above,50);
 assert.equal(r.examples[1].next_tier,null);assert.equal(r.examples[1].tier_progress,100);
});
test('Non-divisible thresholds round approvals upwards and preview never mutates input',()=>{
 const p=proposal('balanced');p.tiers[1].min_points=51;const original=JSON.stringify(p),r=simulateTiers(p);assert.equal(r.tiers[1].approvals_required,6);assert.equal(JSON.stringify(p),original);
});
test('Disabled tier participates in monotonic validation but is skipped in progress',()=>{
 const p=proposal('balanced');p.tiers[1].status='disabled';p.cohorts=[{population_percent:100,approvals_per_user:5}];
 const r=simulateTiers(p);assert.equal(r.examples[0].tier.tier_id,'normal');assert.equal(r.examples[0].next_tier.tier_id,'silver');
});
for(const [name,mutate] of [
 ['negative',p=>p.tiers[1].min_points=-1],['fraction',p=>p.tiers[1].min_points=1.2],['numeric string',p=>p.tiers[1].min_points='50'],
 ['equal threshold',p=>p.tiers[2].min_points=50],['reverse',p=>p.tiers[1].min_points=1000],['normal baseline',p=>p.tiers[0].min_points=1],
 ['missing artwork identity',p=>p.tiers[2].icon_key='other'],['missing tier',p=>p.tiers.pop()],['disabled unconfigured',p=>{p.tiers[2].status='disabled';p.tiers[2].min_points=null;}],
 ['zero score',p=>p.points_per_approval=0],['bad duration',p=>p.campaign_days=0],['weight total',p=>p.cohorts[0].population_percent=1],
 ['unsafe approvals',p=>p.cohorts[0].approvals_per_user=Number.MAX_SAFE_INTEGER],['invalid activity',p=>p.cohorts[0].active_day_fraction=2],
])test('Simulator rejects '+name,()=>{const p=proposal('balanced');mutate(p);assert.throws(()=>simulateTiers(p),/INVALID_TIER_SIMULATION/);});
