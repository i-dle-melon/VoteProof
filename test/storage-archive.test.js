import {activateLocalArchive} from './helpers/archive-fence-fixture.mjs';
import {storageRoute} from '../src/api/storage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { localAdminRuntime } from '../scripts/lib/local-admin-runtime.mjs';
import { cleanupArchive, verifyDriveArchive, ARCHIVE_RETENTION_DAYS } from '../src/lib/storage-archive.js';
import { coldContext, shaBytes, storageSignature } from '../src/lib/cold-storage.js';
import { STORAGE, nowSeconds } from '../src/lib/storage-capacity.js';
import { ensureCaseBackups } from '../src/lib/proof-backup-store.js';
import { privateProofResponse } from '../src/api/admin.js';

const secret = randomBytes(32).toString('hex');
const synthetic = (row) => ({
  file_id:row.drive_file_id,sha256:null,size:row.size,mime:row.content_type,
  name:row.case_id+'.png',folder_id:row.drive_folder_id,
  campaign_folder_id:row.campaign_folder_id,root_folder_id:row.root_folder_id,
  case_id:row.case_id,proof_id:row.file_id,
});
test('plan A Drive receipt is small, HMAC-bound and does not transport image bytes', async () => {
  const row={
    backup_status:'confirmed',file_id:'proof',object_key:'proofs/final/example',size:3,
    content_type:'image/png',etag:'etag',source_object_key:'proofs/final/example',
    source_size:3,source_mime:'image/png',source_etag:'etag',
    drive_file_id:'file',drive_folder_id:'day',root_folder_id:'root',
    campaign_folder_id:'campaign',case_id:'VP-example',
    campaign_key:'campaign:example',date_key:'date:example'
  };
  const sha=await shaBytes(new Uint8Array([1,2,3])),payload=synthetic(row);
  payload.sha256=sha;payload.campaign_key_hash=await shaBytes(new TextEncoder().encode(row.campaign_key));
  payload.date_key_hash=await shaBytes(new TextEncoder().encode(row.date_key));
  const fetcher=async (_url,init)=>{
    const req=JSON.parse(init.body);
    assert.equal(req.purpose,'archive_verify');
    assert.equal(req.expected_sha256,sha);
    assert.ok(JSON.stringify(req).length<1024);
    const result={nonce:req.nonce,timestamp:nowSeconds(),payload:JSON.stringify(payload)};
    result.signature=await storageSignature(secret,JSON.stringify(['VoteProof/archive-verified-result',result.nonce,result.timestamp,result.payload]));
    return Response.json(result);
  };
  const e={DRIVE_BACKUP_RELAY_SECRET:secret,DRIVE_COLD_RELAY_URL:'https://'+'script.google.com'+'/macros/s/test/exec'};
  const answer=await verifyDriveArchive(e,row,sha,{fetcher});
  assert.equal(answer.sha256,sha);
  await assert.rejects(verifyDriveArchive(e,{...row,size:4,source_size:4},sha,{fetcher}));
  await assert.rejects(verifyDriveArchive(e,row,'0'.repeat(64),{fetcher}));
  await assert.rejects(verifyDriveArchive(e,row,sha,{fetcher:async(_u,init)=>{
    const r=await fetcher(_u,init),json=await r.json();
    json.signature='x'.repeat(json.signature.length);return Response.json(json);
  }}));
});
test('only reviewed and 7-day-old, Drive-confirmed proofs archive; no browser cold read',async()=>{
  assert.equal(ARCHIVE_RETENTION_DAYS,7);
  const h=await localAdminRuntime({submissionsEnabled:false,directIntent:true});
  try {
    const db=h.local.db;
    const env=(live=false)=>({...h.local.authConfig,DB:db,PROOFS_BUCKET:h.local.bucket,
      GOOGLE_DRIVE_BACKUP_ENABLED:'true',DRIVE_BACKUP_RELAY_SECRET:secret,
      R2_EXCLUSIVE_WRITER_CONFIRMED:'true',
      ...(live?{STORAGE_CLEANUP_LIVE_ENABLED:'true'}:{})});
    await db.prepare("UPDATE storage_capacity SET used_bytes=0,reserved_bytes=0,blocked=0,trusted_until=?,observed_at=?,inventory_id=NULL,anomaly=NULL,cleanup_requested=0 WHERE id=1")
      .bind(nowSeconds()+600,nowSeconds()).run();
    await db.prepare("UPDATE submission_settings SET submissions_enabled=1 WHERE id=1").run();
    let c;
    try{c=await h.makeCase();}finally{
      await db.prepare("UPDATE submission_settings SET submissions_enabled=0 WHERE id=1").run();
    }
    const f=await db.prepare("SELECT * FROM case_files WHERE case_id=?").bind(c.id).first();
    const daysAgo=n=>new Date(Date.now()-n*86400000).toISOString();
    await db.prepare("UPDATE cases SET status='completed',reviewed_at=?,status_updated_at=? WHERE id=?")
      .bind(daysAgo(6),daysAgo(6),c.id).run();
    await ensureCaseBackups(env(),c.id);
    const b=await db.prepare("SELECT id FROM proof_backups WHERE file_id=?").bind(f.id).first();
    await db.batch([
      db.prepare("INSERT INTO drive_backup_folders VALUES(?,?,?,?,?,?)")
        .bind('root','campaign:'+f.id,'campaign_'+f.id,'root','fixture',nowSeconds()),
      db.prepare("INSERT INTO drive_backup_folders VALUES(?,?,?,?,?,?)")
        .bind('root','date:'+f.id,'day_'+f.id,'campaign_'+f.id,'fixture',nowSeconds()),
      db.prepare("UPDATE proof_backups SET status='confirmed',root_folder_id='root',drive_file_id=?,drive_folder_id=?,completed_at=?,lease_until=NULL WHERE id=?")
        .bind('file_'+f.id,'day_'+f.id,nowSeconds(),b.id),
    ]);
    await db.prepare("UPDATE storage_capacity SET used_bytes=?,cleanup_requested=1 WHERE id=1")
      .bind(STORAGE.cleanupStart).run();
    await activateLocalArchive(db);
    let reads=0;
    const read=async(_env,row,sha)=>{reads++;assert.match(sha,/^[a-f0-9]{64}$/);return{sha256:sha};};
    assert.equal((await cleanupArchive(env(true),{read})).state,'no_eligible_proofs');
    assert.ok(await h.local.bucket.head(f.object_key));
    assert.equal(reads,0);
    await db.prepare("UPDATE cases SET reviewed_at=?,status_updated_at=? WHERE id=?")
      .bind(daysAgo(8),daysAgo(8),c.id).run();
    const before=await cleanupArchive(env(),{read});
    assert.equal(before.mode,'dry-run');
    assert.equal(before.deleted,0);
    assert.ok(await h.local.bucket.head(f.object_key));
    assert.equal((await cleanupArchive(env(true),{read})).state,'verification_ready');
    const result=await cleanupArchive(env(true),{read});
    assert.equal(result.state,'cold');
    assert.equal(result.deleted,1);
    assert.equal(await h.local.bucket.head(f.object_key),null);
    assert.equal((await db.prepare("SELECT state FROM cold_proofs WHERE file_id=?").bind(f.id).first()).state,'cold');
    assert.equal((await db.prepare("SELECT status FROM proof_backups WHERE file_id=?").bind(f.id).first()).status,'confirmed');
    assert.equal((await db.prepare("SELECT submissions_enabled FROM submission_settings WHERE id=1").first()).submissions_enabled,0);
    await assert.rejects(db.prepare("UPDATE cases SET status='pending' WHERE id=?").bind(c.id).run());
    await db.prepare("UPDATE cold_proofs SET state='deleting',lease_token=?,lease_until=? WHERE file_id=?").bind('fixture-lease',nowSeconds()+300,f.id).run();
    await assert.rejects(db.prepare("UPDATE cases SET updated_at=? WHERE id=?").bind(new Date().toISOString(),c.id).run());
    await db.prepare("UPDATE cold_proofs SET state='cold',lease_token=NULL,lease_until=NULL WHERE file_id=?").bind(f.id).run();
    await assert.rejects(privateProofResponse(env(),f),e=>e.code==='PROOF_ARCHIVED_IN_DRIVE'&&e.status===410);
  } finally {await h.local.runtime.dispose();}
});

test('archive continuation is server-only authenticated and rejects client deletion parameters',async()=>{
  const path='/api/internal/drive-backup/storage/archive',url=new URL('https://fixture.invalid'+path);
  const route=storageRoute(path),env={DRIVE_BACKUP_RELAY_SECRET:secret,GOOGLE_DRIVE_BACKUP_ENABLED:'true',DB:{prepare:()=>assert.fail('Rejected requests must not reach DB')}};
  for(const [headers,status] of [[{},401],[{Authorization:'Bearer '+'0'.repeat(64)},401],[{Authorization:'Bearer '+secret,Origin:'https://fixture.invalid'},403]]){
    const r=await route.handler(env,url,new Request(url,{method:'POST',headers,body:'{}'}));assert.equal(r.status,status);
  }
  const bad=await route.handler(env,url,new Request(url,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({file_id:'forged',sha256:'0'.repeat(64)})}));
  assert.equal(bad.status,503); // empty-input contract rejects before any D1 lookup
});
