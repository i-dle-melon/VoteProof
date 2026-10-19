// Disposable synthetic-only harness. Never deploy with Production bindings.
import {storageRoute} from '../../src/api/storage.js';
import {authenticateRelay} from '../../src/lib/drive-backup-relay.js';
import {readReviewJson} from '../../src/api/admin-validation.js';
const prefix='voteproof-inventory-test-';
const syntheticKey=n=>(n%3===0?'proofs/staging/':n%3===1?'proofs/final/':'synthetic-other/')+
  '2026/10/19/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-'+String(n).padStart(12,'0')+'.png';
export default {async fetch(request,env){
  if(!env.TEST_NAME?.startsWith(prefix)||env.TEST_BUCKET!==env.TEST_NAME||
    env.TEST_DATABASE==='9e2b885d-66e2-4e4d-b768-4bded261296a'||Date.now()>Number(env.TEST_EXPIRES))
    return new Response('Expired isolated harness',{status:403});
  const url=new URL(request.url),path=url.pathname;
  const relay=request.headers.get('Authorization')==='Bearer '+env.DRIVE_BACKUP_RELAY_SECRET;
  const control=request.headers.get('X-Isolated-Access')===env.TEST_ACCESS;
  if(!relay&&!control)return new Response('Unauthorized',{status:401});
  const budget=await env.DB.prepare('UPDATE isolated_budget SET n=n+1 WHERE n<3000 RETURNING n').first();
  if(!budget)return new Response('Budget exhausted',{status:429});
  if(path==='/ready')return Response.json({isolated:true});
  if(path==='/seed'&&control&&request.method==='POST'){
    const {start,count}=await request.json();
    if(!Number.isInteger(start)||!Number.isInteger(count)||start<0||count<0||start+count>401)return new Response('Invalid',{status:400});
    // Valid tiny synthetic PNGs; inventory reads metadata only, never image bytes.
    const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
    for(let n=start;n<start+count;n++)await env.PROOFS_BUCKET.put(syntheticKey(n),bytes,{httpMetadata:{contentType:'image/png'}});
    return Response.json({seeded:count});
  }
  if(path==='/cleanup'&&control&&request.method==='POST'){
    const page=await env.PROOFS_BUCKET.list({limit:200});
    if(page.objects.length)await env.PROOFS_BUCKET.delete(page.objects.map(x=>x.key));
    return Response.json({deleted:page.objects.length,more:page.truncated});
  }
  if(path==='/api/internal/drive-backup/claim'&&relay)return Response.json({ok:true,data:{state:'idle'}});
  if(path.startsWith('/probe/')&&path!=='/probe/d1-scan'&&control){
    const kind=path.slice(7);let result={};
    if(kind==='auth-json'){await authenticateRelay(request,env);await readReviewJson(request);}
    else if(kind==='list-50'||kind==='list-200'){
      const page=await env.PROOFS_BUCKET.list({limit:kind==='list-50'?50:200});
      result={objects:page.objects.length};
    }else if(kind!=='control')return new Response('Unknown probe',{status:404});
    console.log(JSON.stringify({sample:request.headers.get('x-isolated-sample'),probe:kind}));
    return Response.json({ok:true,...result});
  }
  // Diagnostic only: same handler/SQL/auth, precomputed synthetic metadata instead
  // of the native R2 response. Complete the scan before returning to native R2.
  if(path==='/probe/d1-scan'&&control){
    const metadata={...env,PROOFS_BUCKET:{list:async({limit,cursor})=>{
      const offset=Number(cursor??0),end=Math.min(201,offset+limit);
      return{objects:Array.from({length:end-offset},(_,i)=>{
        const n=offset+i;return{key:syntheticKey(n),size:68};
      }),truncated:end<201,...(end<201?{cursor:String(end)}:{})};
    }}};
    const route='/api/internal/drive-backup/storage/tick';
    const result=await storageRoute(route).handler(metadata,new URL(route,url),request);
    console.log(JSON.stringify({sample:request.headers.get('x-isolated-sample'),probe:'d1-scan'}));
    return result;
  }
  if(path==='/api/internal/drive-backup/storage/tick'||path==='/api/internal/drive-backup/storage/quota'||path==='/api/internal/drive-backup/storage/inventory/finalize'){
    if(request.method!=='POST')return new Response('Method not allowed',{status:405});
    // Let the real handler parse/validate once. Duplicating request/response JSON
    // parsing here would measure extra harness work absent from the runtime.
    const result=await storageRoute(path).handler(env,url,request);
    console.log(JSON.stringify({isolated_inventory:true,sample:request.headers.get('x-isolated-sample'),path,status:result.status}));
    return result;
  }
  return new Response('Not found; archive unavailable',{status:404});
}};
