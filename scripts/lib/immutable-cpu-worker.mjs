// Synthetic isolated benchmark entry point only; never referenced by wrangler.jsonc.
import app from '../../src/index.js';
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(!/^voteproof-immutable-[0-9a-f]{12}\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)||
   request.headers.get('X-Isolated-Access')!==env.TEST_ACCESS||env.R2_BUCKET_NAME!==url.hostname.split('.')[0]+'-data')return new Response(null,{status:404});
 if(url.pathname==='/__fixture/ready')return Response.json({version:env.PROFILE_VERSION});
 if(url.pathname==='/__fixture/cleanup'&&request.method==='POST'){
   let count=0;for(;;){const page=await env.PROOFS_BUCKET.list({limit:1000});if(!page.objects.length)break;await env.PROOFS_BUCKET.delete(page.objects.map(o=>o.key));count+=page.objects.length;}
   return Response.json({deleted:count});
 }
 let statements=0,trips=0;const r2={get:0,put:0,head:0,delete:0},raw=new WeakMap();
 const wrap=s=>{const p=new Proxy(s,{get(t,k){if(k==='bind')return(...a)=>wrap(t.bind(...a));if(['first','all','run'].includes(k))return(...a)=>{statements++;trips++;return t[k](...a);};return typeof t[k]==='function'?t[k].bind(t):t[k];}});raw.set(p,s);return p;};
 const db={prepare:s=>wrap(env.DB.prepare(s)),batch:list=>{statements+=list.length;trips++;return env.DB.batch(list.map(s=>raw.get(s)??s));}};
 const bucket={};for(const method of Object.keys(r2))bucket[method]=(...a)=>{r2[method]++;return env.PROOFS_BUCKET[method](...a);};
 const response=await app.fetch(request,{...env,DB:db,PROOFS_BUCKET:bucket}),headers=new Headers(response.headers);
 headers.set('X-Isolated-Metrics',JSON.stringify({statements,trips,r2}));headers.set('X-Isolated-Version',env.PROFILE_VERSION);
 return new Response(response.body,{status:response.status,headers});
}};
