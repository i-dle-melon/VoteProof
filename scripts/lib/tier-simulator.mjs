import { TIER_IDENTITIES, tierConfigurationReady, resolveMemberTier } from '../../src/lib/member-tier.js';

// Decision tooling only. No database, credentials or network access.
export function simulateTiers(input) {
  const fail = () => { throw new Error('INVALID_TIER_SIMULATION'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const { points_per_approval: score, campaign_days: days, tiers, cohorts } = input;
  if (!Number.isSafeInteger(score) || score < 1 || score > 1000000000 || !Number.isSafeInteger(days) || days < 1 || days > 3660 ||
      !tierConfigurationReady(tiers) || !Array.isArray(cohorts) || !cohorts.length || cohorts.length > 100) fail();
  if (Math.abs(cohorts.reduce((s,c)=>s+(typeof c?.population_percent==='number'?c.population_percent:NaN),0)-100)>0.00001) fail();
  const examples = cohorts.map((c,i)=>{
    if (!c || !Number.isFinite(c.population_percent) || c.population_percent<=0 || c.population_percent>100) fail();
    let approvals = c.approvals_per_user;
    if (approvals === undefined) {
      if (!Number.isFinite(c.approvals_per_active_day) || c.approvals_per_active_day<0 || c.approvals_per_active_day>10000 ||
          !Number.isFinite(c.active_day_fraction) || c.active_day_fraction<0 || c.active_day_fraction>1) fail();
      approvals = Math.floor(days*c.approvals_per_active_day*c.active_day_fraction);
    }
    if (!Number.isSafeInteger(approvals) || approvals<0 || !Number.isSafeInteger(approvals*score)) fail();
    return { cohort:i+1,population_percent:c.population_percent,approvals_per_user:approvals,points:approvals*score,...resolveMemberTier(approvals*score,tiers) };
  });
  return { application:'PREVIEW_ONLY',assumptions:{points_per_approval:score,campaign_days:days},monotonicity:'PASS',
    tiers:tiers.map(t=>({tier_id:t.tier_id,name:t.name,min_points:t.min_points,status:t.status,
      approvals_required:Math.ceil(t.min_points/score),threshold_reachable_points:Math.ceil(t.min_points/score)*score,
      estimated_population_percent_at_or_above:examples.filter(e=>e.points>=t.min_points).reduce((s,e)=>s+e.population_percent,0)})),
    examples,limits:['Exact score assumptions, not an observed population forecast','Only active tiers appear in current/next progress','No threshold is written to a service'] };
}

export function proposal(kind, score=10) {
  const approvals = {participation:[0,3,8,15,25,40,60,90],balanced:[0,5,15,30,60,100,160,240],prestige:[0,10,30,60,120,200,350,500]}[kind];
  if (!approvals || !Number.isSafeInteger(score) || score<1 || score>2000000) throw new Error('INVALID_TIER_PROPOSAL');
  return { proposal:kind,application:'WAITING_FOR_OPERATOR_DECISION',points_per_approval:score,campaign_days:30,
    tiers:TIER_IDENTITIES.map((t,i)=>({...t,min_points:approvals[i]*score,status:'active'})),
    cohorts:[{population_percent:50,approvals_per_active_day:1,active_day_fraction:0.5},
      {population_percent:35,approvals_per_active_day:3,active_day_fraction:0.8},
      {population_percent:15,approvals_per_active_day:10,active_day_fraction:1}] };
}
