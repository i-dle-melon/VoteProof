// Explicit isolated test entry. No Production config, login, email or Google API.
import {cleanupArchive,verifyDriveArchive} from '../../src/lib/storage-archive.js';
import {storageSignature} from '../../src/lib/cold-storage.js';
import {capacityPut,inventoryPage,reserveStorage,nowSeconds} from '../../src/lib/storage-capacity.js';
import {readReviewJson} from '../../src/api/admin-validation.js';
import {authenticateRelay} from '../../src/lib/drive-backup-relay.js';
const denied=()=>new Response(null,{status:404});
const json=v=>Response.json(v,{headers:{'Cache-Control':'no-store'}});
export default {async fetch(request,env){
  const url=new URL(request.url),expiry=Number(env.TEST_EXPIRES);
  if(!Number.isFinite(expiry)||Date.now()>expiry||url.origin!==env.TEST_ORIGIN||request.headers.has('Origin')||
    request.headers.get('X-Isolated-Access')!==env.TEST_ACCESS)return denied();
  if(url.pathname==='/ready')return json({version:env.TEST_VERSION});
  if(url.pathname==='/cleanup'&&env.TEST_ROLE==='reader'&&request.method==='POST'){
    let deleted=0;for(;;){const p=await env.PROOFS_BUCKET.list({limit:1000});if(!p.objects.length)break;
      await env.PROOFS_BUCKET.delete(p.objects.map(o=>o.key));deleted+=p.objects.length;}
    return json({deleted});
  }
  const budget=await env.DB.prepare('UPDATE isolated_budget SET used=used+1 WHERE id=? AND used<ceiling RETURNING used').bind(env.TEST_ROLE).first();
  if(!budget)return new Response(null,{status:429});
  try{
    if(env.TEST_ROLE==='relay')return await relay(request,env,url);
    if(url.pathname.startsWith('/snapshot/')&&request.method==='GET'){
      const row=await env.DB.prepare(`SELECT i.object_key,p.state,p.lease_until,b.status backup_status,
        (SELECT count(*) FROM storage_audit WHERE target=i.file_id AND action='archive_r2_deleted') audit
        FROM isolated_fixtures i JOIN proof_backups b ON b.file_id=i.file_id LEFT JOIN cold_proofs p ON p.file_id=i.file_id WHERE label=?`).bind(url.pathname.slice(10)).first();
      if(!row)return denied();return json({exists:!!await env.PROOFS_BUCKET.head(row.object_key),archive:row.state?{state:row.state,lease_until:row.lease_until}:null,backup:{status:row.backup_status},audit:row.audit});
    }
    if(url.pathname==='/bucket-summary'&&request.method==='GET'){
      let bytes=0,count=0,cursor;do{const page=await env.PROOFS_BUCKET.list({limit:1000,...(cursor?{cursor}:{})});for(const x of page.objects){bytes+=x.size;count++;}cursor=page.truncated?page.cursor:undefined;}while(cursor);
      return json({bytes,count});
    }
    if(url.pathname.startsWith('/seed/')&&request.method==='PUT')return await seed(request,env,url.pathname.slice(6));
    if(url.pathname==='/inventory'&&request.method==='POST')return json(await inventoryPage(env));
    if(url.pathname==='/capacity-put'&&request.method==='POST'){
      let puts=0;try{await capacityPut({...env,PROOFS_BUCKET:{put:(...a)=>{puts++;return env.PROOFS_BUCKET.put(...a);}}},'other/synthetic-upload',new Uint8Array([1]),{},1);return json({uploaded:true,puts});}
      catch(e){return json({error:e.code,puts});}
    }
    if(url.pathname!=='/archive'||request.method!=='POST')return denied();
    // Same server-only authentication used by Production maintenance.
    await authenticateRelay(request,env);
    const input=await readReviewJson(request);if(url.search||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)return new Response(null,{status:400});
    const mode=request.headers.get('X-Test-Mode')??'normal',sample=request.headers.get('X-Isolated-Sample')??'unmeasured';
    const instrumented=request.headers.get('X-Test-Profile')!=='pure';
    if(!instrumented&&mode!=='normal')return denied();
    const counters={statements:0,trips:0,r2:{head:0,get:0,put:0,delete:0,list:0},relay:0,harness_budget_statements:1},raw=new WeakMap(),sqls=new WeakMap();
    let lastRow,heads=0,lost=false;const assertions={};
    const wrap=(s,sql)=>{const p=new Proxy(s,{get(t,k){if(k==='bind')return(...a)=>wrap(t.bind(...a),sql);if(['first','all','run'].includes(k))return(...a)=>{counters.statements++;counters.trips++;const value=t[k](...a);return k==='first'&&sql.startsWith('SELECT f.id file_id')?value.then(row=>{lastRow=row;return row;}):value;};return typeof t[k]==='function'?t[k].bind(t):t[k];}});raw.set(p,s);sqls.set(p,sql);return p;};
    const db={prepare:s=>wrap(env.DB.prepare(s),s),batch:a=>{counters.statements+=a.length;counters.trips++;
      if(mode==='commit-failure'&&!lost&&a.some(s=>sqls.get(s)?.startsWith("UPDATE cold_proofs SET state='cold'"))){lost=true;throw Error('ISOLATED_D1_ACK_FAILURE');}
      const promise=env.DB.batch(a.map(s=>raw.get(s)??s));
      if(mode==='commit-ack-lost'&&!lost&&a.some(s=>sqls.get(s)?.startsWith("UPDATE cold_proofs SET state='cold'"))){lost=true;return promise.then(()=>{throw Error('ISOLATED_D1_COMMITTED_ACK_LOST');});}
      return promise;}};
    const bucket={};for(const name of Object.keys(counters.r2))bucket[name]=async(...args)=>{
      if(name==='head'){
        heads++;
        if(mode==='replace-version'&&heads===2){counters.r2.get++;const old=await env.PROOFS_BUCKET.get(args[0]);const sha=old.checksums.sha256;
          counters.r2.put++;await env.PROOFS_BUCKET.put(args[0],old.body,{sha256:sha,httpMetadata:{contentType:'image/png'}});assertions.replaced_version=true;}
      }
      if(name==='delete'){
        if(mode==='delete-failure'&&!lost){lost=true;throw Error('ISOLATED_PRE_DELETE_FAILURE');}
        if(mode==='review-race'){
          try{await db.prepare('UPDATE cases SET updated_at=? WHERE id=?').bind(new Date().toISOString(),lastRow.case_internal_id).run();assertions.review_blocked=false;}
          catch{assertions.review_blocked=true;}
        }
      }
      counters.r2[name]++;const value=await env.PROOFS_BUCKET[name](...args);
      if(name==='delete'&&mode==='delete-ack-lost')throw Error('ISOLATED_DELETE_ACK_LOST');
      return value;
    };
    const read=async(_env,row,sha)=>{
      lastRow=row;let original;
      const fetcher=async(_url,init)=>{
        counters.relay++;if(init.method==='POST')original=init.body;
        const upstream=new Request(env.MOCK_ORIGIN+'/verify?step='+(init.method==='POST'?'post':'get'),{method:'POST',redirect:'manual',signal:init.signal,
          headers:{'Content-Type':'application/json','X-Isolated-Access':env.RELAY_ACCESS,'X-Test-Mode':mode},body:original});
        return env.MOCK_RELAY?env.MOCK_RELAY.fetch(upstream):fetch(upstream);
      };
      const result=await verifyDriveArchive(env,row,sha,{fetcher});
      if(mode==='writer-race'){
        try{await reserveStorage({...env,DB:db},row.object_key,row.size);assertions.writer_blocked=false;}catch{assertions.writer_blocked=true;}
      }
      if(mode==='export-race'){
        try{await exportItem(db,row);assertions.export_blocked=false;}catch{assertions.export_blocked=true;}
      }
      return result;
    };
    const result=await cleanupArchive({...env,DB:instrumented?db:env.DB,PROOFS_BUCKET:instrumented?bucket:env.PROOFS_BUCKET},{read,previewOnly:mode==='dry-run'});
    // Count SDK operations in the separate instrumented phase. Never present
    // estimated counts as observed per-request counters in pure CPU samples.
    const metrics=instrumented?{...counters,instrumented:true}:{statements:null,trips:null,r2:null,relay:counters.relay,harness_budget_statements:1,instrumented:false};
    const record={sample,result,counters:metrics,assertions,file_id:lastRow?.file_id??result.file_id??null};console.log(JSON.stringify(record));
    if((mode==='response-lost'&&result.state==='cold')||(mode==='verify-response-lost'&&result.state==='verification_ready'))return new Response('ISOLATED_RESPONSE_LOST',{status:503});
    return json(record);
  }catch(e){return Response.json({error:e.code??e.message},{status:e.status??503});}
}};
async function seed(request,env,label){
  if(!/^[a-z0-9-]{1,70}$/.test(label))return denied();
  const row=await env.DB.prepare('SELECT * FROM isolated_fixtures WHERE label=?').bind(label).first();
  if(!row||Number(request.headers.get('Content-Length'))!==row.size)return denied();
  // An unmeasured fixture upload may lose its response after PUT/DB commit.
  // Recover only this never-archived fixture; never reseed a destructive pin.
  if(await env.DB.prepare('SELECT file_id FROM cold_proofs WHERE file_id=?').bind(row.file_id).first())return new Response(null,{status:409});
  let object=await env.PROOFS_BUCKET.head(row.object_key);
  if(!object)object=await env.PROOFS_BUCKET.put(row.object_key,request.body,{sha256:row.expected_sha,httpMetadata:{contentType:'image/png'},onlyIf:{etagDoesNotMatch:'*'}});
  if(!object)return new Response(null,{status:409});
  const checksum=object.checksums.sha256&&Array.from(new Uint8Array(object.checksums.sha256),x=>x.toString(16).padStart(2,'0')).join('');
  if(object.size!==row.size||object.httpMetadata?.contentType!=='image/png'||checksum!==row.expected_sha)return new Response(null,{status:409});
  const drive=await env.DB.prepare('SELECT file_id,payload FROM isolated_drive WHERE json_extract(payload,\'$.proof_id\')=?').bind(row.file_id).first();
  const p=JSON.parse(drive.payload);
  await env.DB.batch([
    env.DB.prepare('UPDATE case_files SET etag=? WHERE id=?').bind(object.etag,row.file_id),
    env.DB.prepare("UPDATE proof_backups SET status='confirmed',source_etag=?,drive_file_id=?,drive_folder_id=?,root_folder_id=?,completed_at=?,lease_until=NULL WHERE file_id=?")
      .bind(object.etag,drive.file_id,p.folder_id,p.root_folder_id,nowSeconds(),row.file_id),
    env.DB.prepare(`INSERT INTO proof_exact_hashes(file_id,sha256,verified_at,source_etag,source_size,case_created_at,case_internal_id)
      SELECT id,?,created_at,etag,size,created_at,case_id FROM case_files WHERE id=? ON CONFLICT(file_id) DO NOTHING`).bind(row.expected_sha,row.file_id),
    env.DB.prepare('UPDATE storage_capacity SET used_bytes=9000000000,reserved_bytes=0,blocked=0,trusted_until=?,observed_at=?,anomaly=NULL,inventory_id=NULL,cleanup_requested=1 WHERE id=1').bind(nowSeconds()+600,nowSeconds()),
  ]);
  return json({seeded:true,etag:object.etag,version:object.version,sha256:Array.from(new Uint8Array(object.checksums.sha256),x=>x.toString(16).padStart(2,'0')).join('')});
}
async function relay(request,env,url){
  if(url.pathname!=='/verify'||request.method!=='POST')return denied();
  const text=await request.text();if(text.length>2048)return denied();const r=JSON.parse(text),at=nowSeconds();
  if(r.version!==1||r.purpose!=='archive_verify'||!Number.isSafeInteger(r.timestamp)||Math.abs(at-r.timestamp)>120)return denied();
  const expected=await storageSignature(env.DRIVE_BACKUP_RELAY_SECRET,JSON.stringify(['VoteProof/archive-verify',r.version,r.purpose,r.nonce,r.timestamp,r.file_id,r.expected_sha256,r.expected_size]));
  if(r.signature!==expected)return denied();
  if(url.searchParams.get('step')==='post')return new Response(null,{status:302,headers:{Location:'https://script.googleusercontent.com/macros/echo?synthetic=archive'}});
  const file=await env.DB.prepare('SELECT payload FROM isolated_drive WHERE file_id=?').bind(r.file_id).first();if(!file)return denied();
  const p=JSON.parse(file.payload);if(p.sha256!==r.expected_sha256||p.size!==r.expected_size)return new Response(null,{status:503});
  const mode=request.headers.get('X-Test-Mode');if(mode==='sha-mismatch')p.sha256='0'.repeat(64);
  const result={nonce:mode==='nonce-mismatch'?'wrong':r.nonce,timestamp:mode==='expired'?at-121:at,payload:JSON.stringify(p)};
  result.signature=await storageSignature(env.DRIVE_BACKUP_RELAY_SECRET,JSON.stringify(['VoteProof/archive-verified-result',r.nonce,result.timestamp,result.payload]));
  if(mode==='signature-mismatch')result.signature='A'.repeat(43);
  return json(result);
}
export async function exportItem(db,row){
  const job=crypto.randomUUID(),at=new Date().toISOString();
  await db.prepare("INSERT INTO export_jobs(id,owner_member_id,created_at,expires_at,filters_json,from_utc,to_utc) VALUES(?,'SYNTHETIC-ADMIN',?,?,'{}','2020-01-01','2100-01-01')").bind(job,at,new Date(Date.now()+60000).toISOString()).run();
  return db.prepare(`INSERT INTO export_job_items SELECT ?,1,1,f.id,c.case_id,c.created_at,c.campaign_id,'Synthetic',c.vote_type,c.source,c.status,c.review_stage,f.content_type,f.size,f.etag,NULL FROM case_files f JOIN cases c ON c.id=f.case_id WHERE f.id=?`).bind(job,row.file_id).run();
}
