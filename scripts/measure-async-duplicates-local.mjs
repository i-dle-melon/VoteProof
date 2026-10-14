// Local workerd only. No cloud API, deployment, credentials on disk or live data.
// V8 sampled active JS time is NOT Cloudflare invocation CPU or a readiness proof.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {build} from 'esbuild';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID,createHash,createHmac} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {syntheticProofBytes} from '../test/fixtures/exact-proof-corpus.js';
const baseline='487bb56ce9f757d4a106eca76f0352f0cc889946',dir=resolve('.wrangler/async-duplicate-v1/measure-'+randomUUID());
await mkdir(dir,{recursive:true});
const git=args=>execFileSync('git',args,{encoding:'utf8',windowsHide:true});
for(const file of git(['ls-tree','-r','--name-only',baseline,'src']).trim().split('\n')){
  const dest=resolve(dir,'baseline',file);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,git(['show',baseline+':'+file]));
}
const wrapper=entry=>`import worker from ${JSON.stringify(entry.replaceAll('\\','/'))};
export default {async fetch(request,env){let statements=0,trips=0,lookups=0;const raw=new WeakMap();
 const wrap=s=>{const p=new Proxy(s,{get(t,k){if(k==='bind')return (...args)=>wrap(t.bind(...args));if(['first','all','run'].includes(k))return (...args)=>{statements++;trips++;return t[k](...args);};return typeof t[k]==='function'?t[k].bind(t):t[k];}});raw.set(p,s);return p;};
 const db={prepare(sql){if(sql.startsWith('WITH original'))lookups++;return wrap(env.DB.prepare(sql));},batch(list){statements+=list.length;trips++;return env.DB.batch(list.map(s=>raw.get(s)??s));}};
 const result=await worker.fetch(request,{...env,DB:db}),headers=new Headers(result.headers);headers.set('X-Local-D1-Statements',String(statements));headers.set('X-Local-D1-Trips',String(trips));headers.set('X-Local-Classification',String(lookups));return new Response(result.body,{status:result.status,headers});}};`;
async function inspector(mf,name){
  const url=await mf.getInspectorURL(),ws=new WebSocket(new URL('/core:user:'+name,url));
  await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});
  let id=0;const pending=new Map();ws.addEventListener('message',e=>{const r=JSON.parse(e.data),p=pending.get(r.id);if(p){clearTimeout(p.timeout);pending.delete(r.id);r.error?p.reject(Error('LOCAL_PROFILE_FAILED')):p.resolve(r.result);}});
  const command=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timeout=setTimeout(()=>reject(Error('LOCAL_PROFILE_TIMEOUT')),10000);pending.set(n,{resolve,reject,timeout});ws.send(JSON.stringify({id:n,method,params}));});
  await command('Profiler.enable');await command('Profiler.setSamplingInterval',{interval:100});return {command,close:()=>ws.close()};
}
function active(profile){const nodes=new Map(profile.nodes.map(n=>[n.id,n.callFrame.functionName]));let us=0,count=0;
  for(let i=0;i<(profile.samples??[]).length;i++)if(!['(idle)','(program)','(root)'].includes(nodes.get(profile.samples[i]))){us+=profile.timeDeltas[i];count++;}
  return {local_sampled_active_js_ms:count?us/1000:null,active_samples:count,profile_samples:profile.samples?.length??0};
}
const samples=[];
for(const phase of ['before','after'])for(const bytesLength of [13082,5242880])for(let round=0;round<2;round++){
  const name='async-local-'+phase+'-'+bytesLength+'-'+round,entry=phase==='before'?resolve(dir,'baseline/src/index.js'):resolve('src/index.js');
  const bundle=(await build({stdin:{contents:wrapper(entry),resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'})).outputFiles[0].text;
  const auth=randomBytes(32).toString('hex'),processor=randomBytes(32).toString('hex'),member='M-'+randomUUID(),token=randomBytes(32).toString('base64url'),origin='https://synthetic.example';
  const mf=new Miniflare(convertV4MiniflareOptions({name,modules:true,script:bundle,compatibilityDate:'2026-10-07',inspectorPort:0,d1Databases:['DB'],r2Buckets:['PROOFS_BUCKET'],
    bindings:{AUTH_SECRET:auth,AUTH_ORIGIN:origin,CASE_QUERY_KEY_SECRET:randomBytes(32).toString('hex'),UPLOAD_GRANT_SECRET:randomBytes(32).toString('hex'),
      R2_ACCOUNT_ID:randomBytes(16).toString('hex'),R2_BUCKET_NAME:'synthetic',GOOGLE_DRIVE_BACKUP_ENABLED:'true',DRIVE_BACKUP_RELAY_SECRET:randomBytes(32).toString('hex'),
      DRIVE_BACKUP_TRANSPORT:'apps_script_pull',TURNSTILE_SECRET_KEY:'synthetic',DUPLICATE_PROCESSOR_ENABLED:'true',DUPLICATE_PROCESSOR_SECRET:processor},outboundService:()=>Response.json({success:true})}));
  let cd;try{
    const db=await mf.getD1Database('DB');for(const file of (await readdir('migrations')).filter(x=>/^\d+_.+\.sql$/.test(x)).sort()){
      if(phase==='before'&&file.startsWith('0013'))continue;
      await db.batch(unstable_splitSqlQuery(await readFile(resolve('migrations',file),'utf8')).map(sql=>db.prepare(sql)));
    }
    await db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();
    const stamp=new Date().toISOString(),seconds=Math.floor(Date.now()/1000),hash=createHash('sha256').update('VoteProof/member-session/v1:'+token).digest('hex');
    await db.prepare(`INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at)
      VALUES('LOCAL','Synthetic','local','2000-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z','UTC','2000-01-01','2099-12-31',0,NULL,'active',?,?)`).bind(stamp,stamp).run();
    await db.prepare(`INSERT INTO members(id,member_id,login_name,nickname,player_id,status,created_at,updated_at,last_login_at) VALUES(?,?,?,'Synthetic','synthetic','active',?,?,?)`).bind(randomUUID(),member,randomUUID().replaceAll('-',''),stamp,stamp,stamp).run();
    await db.prepare('INSERT INTO auth_sessions(token_hash,member_id,created_at,expires_at) VALUES(?,?,?,?)').bind(hash,member,seconds-60,seconds+3600).run();
    const csrf=createHmac('sha256',Buffer.from(auth,'hex')).update(JSON.stringify(['VoteProof/auth/v1','csrf',hash])).digest('hex');
    cd=await inspector(mf,name);
    const call=async(path,body,headers={},measure)=>{
      if(measure)await cd.command('Profiler.start');const started=performance.now();
      const r=await mf.dispatchFetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}),value=await r.json(),wall=performance.now()-started;
      if(!r.ok)throw Error('LOCAL_MEASUREMENT_REQUEST_FAILED_'+r.status+'_'+value.error?.code);
      if(measure){const {profile}=await cd.command('Profiler.stop');const sample={phase,bytes:bytesLength,round,kind:measure,...active(profile),wall_ms:wall,
        d1_statements:Number(r.headers.get('X-Local-D1-Statements')),d1_round_trips:Number(r.headers.get('X-Local-D1-Trips')),classification_lookups:Number(r.headers.get('X-Local-Classification'))};samples.push(sample);}
      return value.data;
    };
    const bytes=syntheticProofBytes(bytesLength,1000+round),sha=createHash('sha256').update(bytes).digest('hex');
    for(let i=0;i<5;i++){
      const prepared=await call('/api/uploads/prepare',{turnstile_token:'synthetic',files:[{name:'synthetic.png',type:'image/png',size:bytes.length,algorithm:'sha256',sha256:sha}]},{Origin:origin});
      const u=prepared.uploads[0],put=await mf.dispatchFetch(u.upload_url,{method:'PUT',headers:{Origin:origin,...u.headers,'Content-Length':String(bytes.length)},body:bytes});if(put.status!==200)throw Error('LOCAL_PUT_FAILED');
      const ref={session_id:prepared.session_id,keys:[u.key]};
      await call('/api/uploads/complete',ref,{Origin:origin},'complete_'+(i===0?'first':i===1?'second':'warm'));
      await call('/api/cases',{nickname:'Synthetic',player_id:'synthetic',campaign_id:'LOCAL',vote_type:'Solo',vote_date:new Date().toISOString().slice(0,10),upload_session:ref},
        {Origin:origin,Cookie:'__Host-vp-session='+token,'X-CSRF-Token':csrf,'Idempotency-Key':randomUUID()},'create_'+(i===0?'first':i===1?'second':'warm'));
      if(phase==='after'){
        const receipt={request_id:randomUUID()},headers={Authorization:'Bearer '+processor};
        await call('/api/internal/proof-duplicates/process',receipt,headers,i===0?'async_no_match_first':'async_duplicate_warm');
        if(i===4)await call('/api/internal/proof-duplicates/process',receipt,headers,'async_completed_replay');
      }
    }
    console.log(JSON.stringify({phase,bytes:bytesLength,round,result:'PASS'}));
  }finally{cd?.close();await mf.dispose();}
}
await writeFile(resolve(dir,'samples.json'),JSON.stringify({environment:'LOCAL_WORKERD_ONLY',baseline,method:'V8 sampled active JS self-time, excluding idle/program/root; not Cloudflare CPU',samples},null,2));
const summary=[];for(const phase of ['before','after'])for(const size of [13082,5242880])for(const kind of [...new Set(samples.filter(x=>x.phase===phase&&x.bytes===size).map(x=>x.kind))]){
  const rows=samples.filter(x=>x.phase===phase&&x.bytes===size&&x.kind===kind),values=rows.map(x=>x.local_sampled_active_js_ms).filter(x=>x!==null).sort((a,b)=>a-b),n=values.length;
  summary.push({phase,bytes:size,kind,requests:rows.length,cpu_sample_n:n,missing:rows.length-n,min:n?values[0]:null,median:n?(values[Math.floor((n-1)/2)]+values[Math.ceil((n-1)/2)])/2:null,p95:n?values[Math.ceil(.95*n)-1]:null,max:n?values.at(-1):null,d1_statements:[...new Set(rows.map(x=>x.d1_statements))],d1_round_trips:[...new Set(rows.map(x=>x.d1_round_trips))],classification_lookups:[...new Set(rows.map(x=>x.classification_lookups))]});
}
await writeFile(resolve('.wrangler/async-duplicate-v1/local-measurements.json'),JSON.stringify({environment:'LOCAL_WORKERD_ONLY',baseline,raw_directory:dir,cloudflare_invocation_cpu:null,readiness:'NOT_PROVEN_BY_LOCAL_PROFILING',summary},null,2));
console.log(JSON.stringify({measurement:'PASS',requests:samples.length,summary:'.wrangler/async-duplicate-v1/local-measurements.json'}));
