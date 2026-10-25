// LOCAL operation profiling entry only. Never use as a deployment entry.
import worker from '../../src/index.js';
import {measuredD1} from './measured-d1.mjs';
export default {async fetch(request,env,context){
  const db=measuredD1(env.DB),r2={head:0,get:0,put:0,delete:0,list:0};
  const bucket=new Proxy(env.PROOFS_BUCKET,{get(target,key){
    const value=target[key];if(typeof value!=='function')return value;
    return(...args)=>{if(Object.hasOwn(r2,key))r2[key]++;return value.apply(target,args);};
  }});
  const response=await worker.fetch(request,{...env,DB:db.db,PROOFS_BUCKET:bucket},context);
  const headers=new Headers(response.headers);headers.set('X-Local-Archive-Metrics',JSON.stringify({...db.totals(),r2}));
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}};
