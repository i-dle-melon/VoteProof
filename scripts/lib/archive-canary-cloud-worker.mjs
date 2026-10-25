// Future isolated deploy entry; native CPU includes durable budget + mock adapter.
// No provisioning, public endpoints, cleanup endpoint, email or Drive access.
import worker from '../../src/index.js';
import {withMockTransport} from './archive-canary-transport.mjs';
import {storageSignature} from '../../src/lib/cold-storage.js';
import {measuredD1} from './measured-d1.mjs';
import {changeArchiveControl} from '../../src/lib/archive-fencing.js';
const path='/api/internal/drive-backup/storage/archive';
const deny=()=>new Response(null,{status:404});
const equal=async(a,b)=>{
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  const x=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(a)),y=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(b));
  return crypto.subtle.timingSafeEqual(x,y);
};
export default {async fetch(request,env,ctx){
  const url=new URL(request.url),expiry=Number(env.TEST_EXPIRES);
  if(env.TEST_ENVIRONMENT!=='isolated'||!Number.isFinite(expiry)||Date.now()>=expiry||
     expiry-Date.now()>86400000||url.origin!==env.TEST_ORIGIN||url.search||request.method!=='POST'||request.headers.has('Origin')||
     !/^https:\/\/voteproof-archive-canary-test-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.origin)||
     !/^[a-f0-9]{64}$/.test(env.TEST_ACCESS??'')||!await equal(request.headers.get('X-Isolated-Access'),env.TEST_ACCESS)||
     env.STORAGE_ALERT_ENABLED!=='false'||env.STORAGE_ARCHIVE_CANARY_ENVIRONMENT!=='isolated')return deny();
  if(![path,'/__canary_mock','/__canary_seed','/__canary_snapshot'].includes(url.pathname))return deny();
  // Pause is global to THIS TEST D1/Worker, not a Production/global shutdown.
  const role=url.pathname===path?'request':url.pathname==='/__canary_mock'?'relay':url.pathname==='/__canary_seed'?'seed':'snapshot';
  const budget=await env.DB.prepare("UPDATE canary_harness_budget SET used=used+1 WHERE role=? AND paused=0 AND used<ceiling RETURNING used").bind(role).first();
  if(!budget)return new Response(null,{status:429});
  if(role==='relay')return mockReceipt(request,env);
  if(role==='seed'||role==='snapshot')return fixtureOperation(request,env,role);
  const sample=request.headers.get('X-Isolated-Sample');
  if(!['native','operations'].includes(env.TEST_PROFILE)||!(env.TEST_PROFILE==='native'?/^arc-[135]m-[1-5]-[AB]$/:/^ops-[135]m-[1-5]-[AB]$/).test(sample??''))return deny();
  const body=await request.clone().text();if(body.length>256)return deny();
  let v;try{v=JSON.parse(body);}catch{return deny();}
  // Explicitly reject the obsolete empty-body benchmark and phase mismatch.
  if(!v||Array.isArray(v)||v.canary!==true||Object.keys(v).some(k=>!['canary','handoff'].includes(k))||
     (sample.endsWith('-A')?Object.hasOwn(v,'handoff'):!Object.hasOwn(v,'handoff')))return deny();
  if(env.TEST_PROFILE!=='operations')return withMockTransport(env,()=>worker.fetch(request,env,ctx));
  // Separate operation profile invocations; never mix these CPU samples with native mode.
  const db=measuredD1(env.DB),r2={head:0,get:0,put:0,delete:0,list:0};
  const bucket=new Proxy(env.PROOFS_BUCKET,{get(target,k){const fn=target[k];return typeof fn==='function'?(...args)=>{if(Object.hasOwn(r2,k))r2[k]++;return fn.apply(target,args);}:fn;}});
  const response=await withMockTransport(env,()=>worker.fetch(request,{...env,DB:db.db,PROOFS_BUCKET:bucket},ctx));
  const headers=new Headers(response.headers);headers.set('X-Canary-Operations',JSON.stringify({...db.totals(),r2,harness_budget_statements:1}));
  return new Response(response.body,{status:response.status,headers});
}};
async function fixtureOperation(request,env,role){
  const label=request.headers.get('X-Canary-Fixture');if(!/^(?:[135]m-[1-5]|ops-[135]m)$/.test(label??''))return deny();
  const f=await env.DB.prepare('SELECT * FROM isolated_fixtures WHERE label=?').bind(label).first();if(!f||!f.object_key.startsWith('proofs/synthetic/'))return deny();
  if(role==='snapshot'){
    const p=await env.DB.prepare('SELECT state,error_code FROM cold_proofs WHERE file_id=?').bind(f.file_id).first();
    const b=await env.DB.prepare('SELECT status FROM proof_backups WHERE file_id=?').bind(f.file_id).first('status');
    return Response.json({exists:!!await env.PROOFS_BUCKET.head(f.object_key),state:p?.state??null,error_code:p?.error_code??null,backup:b,
      terminal_audits:await env.DB.prepare("SELECT count(*) n FROM storage_audit WHERE target=? AND action='archive_r2_deleted'").bind(f.file_id).first('n')});
  }
  const control=await env.DB.prepare('SELECT epoch,mode FROM storage_archive_control WHERE id=1').first();
  if(control.epoch===1&&!/^[a-f0-9]{64}$/.test(env.TEST_WRITER_EVIDENCE_SHA256??''))return new Response(null,{status:503});
  if(Number(request.headers.get('Content-Length'))!==f.size||![1048576,3145728,5242880].includes(f.size)||
     await env.DB.prepare('SELECT file_id FROM cold_proofs WHERE file_id=?').bind(f.file_id).first())return deny();
  let obj=await env.PROOFS_BUCKET.head(f.object_key);
  if(!obj)obj=await env.PROOFS_BUCKET.put(f.object_key,request.body,{sha256:f.expected_sha,httpMetadata:{contentType:'image/png'},onlyIf:{etagDoesNotMatch:'*'}});
  if(!obj||obj.size!==f.size||!obj.checksums.sha256||Array.from(new Uint8Array(obj.checksums.sha256),b=>b.toString(16).padStart(2,'0')).join('')!==f.expected_sha)return deny();
  const drive=await env.DB.prepare('SELECT file_id,payload FROM isolated_drive WHERE json_extract(payload,\'$.proof_id\')=?').bind(f.file_id).first();
  if(!drive)return deny();const p=JSON.parse(drive.payload),now=Math.floor(Date.now()/1000);
  await env.DB.batch([
    env.DB.prepare('UPDATE case_files SET etag=? WHERE id=?').bind(obj.etag,f.file_id),
    env.DB.prepare("UPDATE proof_backups SET status='confirmed',source_etag=?,drive_file_id=?,drive_folder_id=?,root_folder_id=?,completed_at=?,lease_until=NULL WHERE file_id=?")
      .bind(obj.etag,drive.file_id,p.folder_id,p.root_folder_id,now,f.file_id),
    // Isolated simulation only; never an accepted way to initialize Production.
    env.DB.prepare('UPDATE storage_capacity SET used_bytes=9000000000,reserved_bytes=0,blocked=0,trusted_until=?,observed_at=?,anomaly=NULL,inventory_id=NULL,cleanup_requested=1 WHERE id=1').bind(now+600,now),
  ]);
  // Only the virgin ISOLATED fixture control can be initialized this way. An
  // operator pause/ambiguous result increments epoch; seed can NEVER undo it.
  if(control.epoch===1)await changeArchiveControl(env.DB,{action:'resume',expected_epoch:1,confirmed:true,
    writer_evidence:{sha256:env.TEST_WRITER_EVIDENCE_SHA256,verified_until:now+600,
      checks:{bindings:true,s3_credentials:true,multipart:true,presigned:true,inflight_puts:true,external_tools:true,other_workers:true}}});
  return Response.json({seeded:true});
}
async function mockReceipt(request,env){
  const text=await request.text();if(text.length>2048)return deny();
  let r;try{r=JSON.parse(text);}catch{return deny();}
  const now=Math.floor(Date.now()/1000);
  if(r.version!==1||r.purpose!=='archive_verify'||!Number.isInteger(r.timestamp)||Math.abs(now-r.timestamp)>120||
     !/^[a-f0-9-]{36}$/.test(r.nonce??''))return deny();
  const expected=await storageSignature(env.DRIVE_BACKUP_RELAY_SECRET,JSON.stringify(['VoteProof/archive-verify',r.version,r.purpose,r.nonce,r.timestamp,r.file_id,r.expected_sha256,r.expected_size]));
  if(!await equal(r.signature,expected))return deny();
  // Each synthetic nonce is single use; no mock can authorize a real Drive file.
  const record=await env.DB.prepare('SELECT payload FROM isolated_drive WHERE file_id=?').bind(r.file_id).first('payload');
  if(!record||!r.file_id.startsWith('synthetic_'))return deny();
  const p=JSON.parse(record);
  if(p.sha256!==r.expected_sha256||p.size!==r.expected_size)return deny();
  const nonce=await env.DB.prepare('INSERT INTO canary_harness_nonces(nonce) VALUES(?) ON CONFLICT DO NOTHING RETURNING nonce').bind(r.nonce).first();
  if(!nonce)return deny();
  const result={nonce:r.nonce,timestamp:now,payload:record};
  result.signature=await storageSignature(env.DRIVE_BACKUP_RELAY_SECRET,JSON.stringify(['VoteProof/archive-verified-result',r.nonce,now,record]));
  return Response.json(result);
}
