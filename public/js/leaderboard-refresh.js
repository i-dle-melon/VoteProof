// Public ranking reads only. These are RAM caches, never auth/session storage.
export class RankingClient {
  constructor(fetcher,now=Date.now){this.fetcher=fetcher;this.now=now;this.cache=new Map();this.pending=new Map();}
  async get(id=null){
    const key=id===null?'catalog':'board:'+id,cached=this.cache.get(key);
    if(cached?.expires>this.now())return cached.data;
    if(this.pending.has(key))return this.pending.get(key);
    const task=(async()=>{
      // Old Workers ignore view; the consumer also accepts their full response.
      const data=await this.fetcher('/api/leaderboards'+(id===null?'?view=catalog':'?id='+encodeURIComponent(id)+'&view=live'));
      // Do not extend an already-aged Worker cache entry by another full TTL.
      const computed=Date.parse(data.refreshed_at),expires=Math.min(this.now()+120000,Number.isFinite(computed)?computed+120000:Infinity);
      this.cache.set(key,{data,expires});
      for(const [name,value]of this.cache)if(value.expires<=this.now())this.cache.delete(name);
      return data;
    })();this.pending.set(key,task);
    try{return await task;}finally{this.pending.delete(key);}
  }
}
export class LeaderboardRefresher {
  constructor(load,{now=Date.now,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),interval=600000}={}){
    Object.assign(this,{load,now,setTimer,clearTimer,interval,active:false,visible:true,lastSuccess:null,lastAttempt:null,promise:null,timer:null});
  }
  pause(){this.clearTimer(this.timer);this.timer=null;}
  schedule(){
    this.pause();if(!this.active||!this.visible)return;
    const due=(this.lastAttempt??this.now())+this.interval;
    this.timer=this.setTimer(()=>void this.refresh(),Math.max(0,due-this.now()));
  }
  enter(active){this.active=active;this.resume();}
  visibility(visible){this.visible=visible;this.resume();}
  resume(){
    this.pause();if(!this.active||!this.visible)return;
    if((this.lastSuccess===null||this.now()-this.lastSuccess>=this.interval)&&
       (this.lastAttempt===null||this.now()-this.lastAttempt>=5000))void this.refresh();
    else this.schedule();
  }
  refresh(action=this.load){
    if(this.promise)return this.promise;
    this.pause();this.lastAttempt=this.now();
    this.promise=Promise.resolve().then(action).then(ok=>{if(ok!==false)this.lastSuccess=this.now();return ok;},()=>false)
      .finally(()=>{this.promise=null;this.schedule();});
    return this.promise;
  }
}
