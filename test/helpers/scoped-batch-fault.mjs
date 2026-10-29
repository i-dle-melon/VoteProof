// Synthetic fault injection only. Native D1 statements are opaque, so retain
// their SQL in test-owned WeakMaps and unwrap before submitting to real D1.
export const isCaseCommit = sql => sql.some(s=>/^\s*INSERT INTO cases\b/i.test(s))&&sql.some(s=>/^\s*INSERT INTO case_files\b/i.test(s));
export function scopedBatchFault(source,matches,inject){
 const originals=new WeakMap(),texts=new WeakMap(),state={injected:0,passed:0};
 const wrap=(statement,sql)=>{
  const proxy=new Proxy(statement,{get(target,key){
   if(key==='bind')return(...values)=>wrap(target.bind(...values),sql);
   const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});originals.set(proxy,statement);texts.set(proxy,sql);return proxy;
 };
 const db={prepare:sql=>wrap(source.prepare(sql),sql),batch:async statements=>{
  const sql=statements.map(s=>texts.get(s));if(sql.some(s=>typeof s!=='string'))throw Error('Untracked test statement');
  const raw=statements.map(s=>originals.get(s)),commit=()=>source.batch(raw);
  if(matches(sql)){state.injected++;return inject(commit,sql);}
  state.passed++;return commit();
 }};return{db,state};
}
