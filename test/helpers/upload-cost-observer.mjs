// Local workerd metadata is not Cloudflare billing or native Worker CPU.
export function observeUploadCost(env){
 const count={statements:0,trips:0,rows_read:0,rows_written:0,rows_metadata_complete:true,
  r2:{head:0,get:0,put:0,delete:0},crypto:{digest:0,importKey:0,sign:0,encrypt:0,decrypt:0,randomUUID:0,getRandomValues:0},batches:[]};
 const raw=new WeakMap(),texts=new WeakMap();
 const kind=sql=>/^\s*UPDATE proof_upload_intents SET write_token=\?/i.test(sql)?'pin_cas':/^\s*INSERT INTO storage_reservations\b/i.test(sql)?'reservation':/^\s*SELECT EXISTS\(SELECT 1 FROM storage_capacity/i.test(sql)?'capacity_receipt':/^\s*INSERT INTO prelaunch_reset_permit\b/i.test(sql)?'fence_permit':/^\s*DELETE FROM prelaunch_reset_permit\b/i.test(sql)?'fence_exit':'other';
 const metadata=r=>{
  if(!Number.isSafeInteger(r?.meta?.rows_read)||!Number.isSafeInteger(r?.meta?.rows_written)){count.rows_metadata_complete=false;count.rows_read=count.rows_written=null;}
  else if(count.rows_metadata_complete){count.rows_read+=r.meta.rows_read;count.rows_written+=r.meta.rows_written;}
 };
 const wrap=(statement,sql)=>{
  const proxy=new Proxy(statement,{get(target,key){
   if(key==='bind')return(...args)=>wrap(target.bind(...args),sql);
   if(['first','all','run'].includes(key))return async(...args)=>{
    count.statements++;count.trips++;
    // Native first() hides meta. all() executes the same bound SQL once and
    // its first result is projected with the original first(column) contract.
    const result=await target[key==='first'?'all':key](...(key==='first'?[]:args));metadata(result);
    if(key==='first'){const row=result.results?.[0]??null;return args[0]?row?.[args[0]]??null:row;}
    return result;
   };
   const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});raw.set(proxy,statement);texts.set(proxy,sql);return proxy;
 };
 const DB={prepare:sql=>wrap(env.DB.prepare(sql),sql),batch:async list=>{
  count.statements+=list.length;count.trips++;count.batches.push({statements:list.length,kinds:list.map(s=>kind(texts.get(s)??''))});
  const results=await env.DB.batch(list.map(s=>raw.get(s)??s));for(const r of results)metadata(r);return results;
 }};
 const PROOFS_BUCKET=Object.fromEntries(Object.keys(count.r2).map(key=>[key,async(...args)=>{
  count.r2[key]++;
  // Test-only Node<->workerd bridge, never used by the real Runtime.
  if(key==='put'&&args[1]instanceof ReadableStream)args[1]=new Uint8Array(await new Response(args[1]).arrayBuffer());
  return env.PROOFS_BUCKET[key](...args);
 }]));
 return{env:{...env,DB,PROOFS_BUCKET},count,async run(fn){
  const restore=[];
  for(const name of Object.keys(count.crypto)){const owner=['randomUUID','getRandomValues'].includes(name)?crypto:crypto.subtle,original=owner[name];owner[name]=function(...args){count.crypto[name]++;return original.apply(this,args);};restore.push(()=>owner[name]=original);}
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{if(String(url)!=='https://challenges.cloudflare.com/turnstile/v0/siteverify')throw Error('Unexpected test upstream');return Response.json({success:true});};
  try{const r=await fn(this.env);if(![200,201].includes(r.status))throw Error('Local measured handler failed HTTP '+r.status);return(await r.json()).data;}
  finally{globalThis.fetch=originalFetch;for(const r of restore)r();}
 }};
}
