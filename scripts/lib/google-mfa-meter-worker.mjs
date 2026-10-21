// Disposable local workerd instrumentation only. Never deployed or published.
import worker from '../../src/index.js';
export default {async fetch(request,env,ctx){
 const counts={reads:0,writes:0,trips:0,policy_reads:0},unwrap=new WeakMap();
 const record=sql=>{const read=/^\s*(SELECT|PRAGMA)\b/i.test(sql);counts[read?'reads':'writes']++;if(read&&/google_login_mfa\b/i.test(sql))counts.policy_reads++;};
 const wrap=(statement,sql)=>{
  const proxy={bind(...args){return wrap(statement.bind(...args),sql);}};
  for(const method of ['first','all','run','raw'])proxy[method]=async(...args)=>{record(sql);counts.trips++;return statement[method](...args);};
  unwrap.set(proxy,{statement,sql});return proxy;
 };
 const db={prepare(sql){return wrap(env.DB.prepare(sql),sql);},async batch(statements){
  const entries=statements.map(s=>unwrap.get(s));for(const e of entries)record(e.sql);counts.trips++;return env.DB.batch(entries.map(e=>e.statement));
 }};
 const response=await worker.fetch(request,{...env,DB:db},ctx),headers=new Headers(response.headers);
 for(const[key,value]of Object.entries(counts))headers.set('X-Local-D1-'+key,String(value));
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}};
