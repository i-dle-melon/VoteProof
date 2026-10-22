// Public, identity-independent scores only. Cache API is per data center;
// a hit still invokes this Worker. No D1 write or globally coordinated lock.
export const RANKING_CACHE_SECONDS=120;
const pending=new WeakMap();
export function rankingCacheKey(url,b){
  const key=new URL('/__public-ranking-cache/v1',url.origin);
  key.searchParams.set('definition',JSON.stringify([b.leaderboard_id,b.version,b.type,b.campaign_id,b.vote_type,b.start_date,b.end_date,b.top_n,b.name,Boolean(b.is_current_comeback)]));
  return key.href;
}
export async function cachedPublicRanking(db,url,definition,compute,{cache=globalThis.caches?.default,now=Date.now}={}){
  const key=rankingCacheKey(url,definition);
  try{
    const hit=await cache?.match(key);
    if(hit){const data=await hit.json(),age=now()-Date.parse(data.refreshed_at);
      if(Number.isFinite(age)&&age>=0&&age<RANKING_CACHE_SECONDS*1000)return {...data,cache_status:'HIT'};
    }
  }catch{/* A cache failure never bypasses database validation. */}
  let inflight=pending.get(db);if(!inflight){inflight=new Map();pending.set(db,inflight);}
  if(inflight.has(key))return inflight.get(key);
  const task=(async()=>{
    const board=await compute(),data={board,refreshed_at:new Date(now()).toISOString()};
    let stored=false;
    try{if(cache){await cache.put(key,new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age='+RANKING_CACHE_SECONDS}}));stored=true;}}
    catch{/* Serve validated data, without claiming cache availability. */}
    return {...data,cache_status:stored?'MISS':'BYPASS'};
  })();
  inflight.set(key,task);
  try{return await task;}finally{inflight.delete(key);}
}
