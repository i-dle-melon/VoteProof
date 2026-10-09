// Explicit test thresholds only. No Production bootstrap/import/seed.
import { TIER_IDENTITIES } from '../../src/lib/member-tier.js';
export const LOCAL_TIER_THRESHOLDS = Object.freeze([0,100,500,1000,2000,5000,10000,20000]);
export const localTierRows = () => TIER_IDENTITIES.map((identity,i)=>({...identity,min_points:LOCAL_TIER_THRESHOLDS[i],status:'active'}));
export async function configureLocalTiers(local,admin) {
  const rows = (await (await local.fetch('/api/admin/member-tiers','GET',undefined,admin.headers)).json()).data.tiers;
  for (let i=1;i<rows.length;i++) {
    const response = await local.fetch('/api/admin/member-tiers/'+rows[i].tier_id+'/update','POST',
      {min_points:LOCAL_TIER_THRESHOLDS[i],status:'active',expected_version:rows[i].version,reason:'Disposable local fixture'},admin.headers);
    if (response.status !== 200) throw new Error('Local tier fixture failed');
  }
}
