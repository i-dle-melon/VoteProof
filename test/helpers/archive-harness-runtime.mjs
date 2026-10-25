// Derived test fixture; the 10 reviewed files remain unchanged.
// NEW harness entry, native local D1/R2, service-bound signed synthetic receipt.
// VM metadata below constructs identical fixtures only; it is NOT called by the harness.
import {buildHarness,harnessSchema} from '../../scripts/prepare-archive-canary-harness.mjs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes,createHash,createHmac,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {activateLocalArchive} from './archive-fence-fixture.mjs';
import {fixtures,fixtureSQL,fixtureSchema,image,digest} from '../../scripts/lib/archive-isolated-fixtures.mjs';
const origin='https://voteproof-archive-canary-test-local.example.workers.dev';
// Inert fixture path, not a deployed Apps Script address. All calls are
// intercepted by outboundService below; there is no external Google access.
const relayUrl=new URL('/macros/s/isolated_canary/exec','https://script.google.com').href;
const bundles=new Map();
export async function archiveHarnessRuntime({profile=false,activate=true,writerEvidenceHash=null}={}){
  if(!bundles.has(profile))bundles.set(profile,await buildHarness());
  const bundle=bundles.get(profile),secret=randomBytes(32).toString('hex'),files=new Map(),media=new Map(),state={relay:0,media:0,metadata:0,permissions:0,unexpected:0,mode:'normal'},props=new Map([['VOTEPROOF_ORIGIN',origin],['DRIVE_BACKUP_RELAY_SECRET',secret],['ROOT_FOLDER_ID','synthetic_root']]);
  const context=vm.createContext({
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)})},
    Utilities:{Charset:{UTF_8:'utf8'},DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_a,b)=>[...createHash('sha256').update(typeof b==='string'?b:Buffer.from(b)).digest()],computeHmacSha256Signature:(t,k)=>[...createHmac('sha256',k).update(t).digest()],base64EncodeWebSafe:b=>Buffer.from(b).toString('base64url')},
    Drive:{Files:{get:id=>{state.metadata++;if(!files.has(id))throw Error('404');return structuredClone(files.get(id));}},Permissions:{list:()=>{state.permissions++;return{permissions:state.mode==='shared'?[{type:'anyone',role:'reader'}]:[{type:'user',role:'owner'}]};}}},
    ScriptApp:{getOAuthToken:()=> 'local-only-oauth-placeholder'},
    UrlFetchApp:{fetch:url=>{if(!/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[a-zA-Z0-9_-]+\?alt=media$/.test(url))throw Error('unexpected Google fixture operation');state.media++;const id=decodeURIComponent(url.split('/').at(-1).split('?')[0]);return{getResponseCode:()=>state.mode==='media-fail'?503:200,getBlob:()=>({getBytes:()=>state.mode==='sha-mismatch'?new Uint8Array(media.get(id).length):media.get(id)})};}},
    ContentService:{MimeType:{JSON:'application/json'},createTextOutput:value=>({value,setMimeType(){return this;}})},
  });
  vm.runInContext(await readFile(new URL('../../apps-script/drive-backup/Code.gs',import.meta.url),'utf8'),context);
  const bindings={GOOGLE_DRIVE_BACKUP_ENABLED:'true',DRIVE_BACKUP_RELAY_SECRET:secret,DRIVE_COLD_RELAY_URL:relayUrl,
    R2_EXCLUSIVE_WRITER_CONFIRMED:'true',STORAGE_CLEANUP_LIVE_ENABLED:'true',STORAGE_ALERT_ENABLED:'false',STORAGE_ARCHIVE_CANARY_ENABLED:'true',STORAGE_ARCHIVE_CANARY_ENVIRONMENT:'isolated',STORAGE_ARCHIVE_CANARY_ORIGIN:origin,TEST_ENVIRONMENT:'isolated',TEST_EXPIRES:String(Date.now()+3600000),TEST_ORIGIN:origin,TEST_ACCESS:secret,TEST_PROFILE:profile?'operations':'native',...(writerEvidenceHash?{TEST_WRITER_EVIDENCE_SHA256:writerEvidenceHash}:{})};
  const runtime=new Miniflare(convertV4MiniflareOptions({name:'archive-harness-local',serviceBindings:{MOCK_RELAY:'archive-harness-local'},modules:true,script:bundle,compatibilityFlags:['nodejs_compat'],compatibilityDate:'2026-10-07',d1Databases:['DB'],r2Buckets:['PROOFS_BUCKET'],bindings,
    outboundService:()=>{state.unexpected++;throw Error('All real outbound requests forbidden');}}));
  const db=await runtime.getD1Database('DB'),bucket=await runtime.getR2Bucket('PROOFS_BUCKET');
  try{
    for(const name of (await readdir(new URL('../../migrations/',import.meta.url))).filter(n=>/^\d+_.+\.sql$/.test(n)).sort())await db.batch(unstable_splitSqlQuery(await readFile(new URL('../../migrations/'+name,import.meta.url),'utf8')).map(s=>db.prepare(s)));
    await db.batch(unstable_splitSqlQuery(harnessSchema).map(s=>db.prepare(s)));
    await db.batch(unstable_splitSqlQuery(fixtureSchema).map(s=>db.prepare(s)));
    const stamp=new Date().toISOString();
    await db.prepare("INSERT INTO campaigns(campaign_id,name,category,solo_target,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,daily_limit,status,created_at,updated_at) VALUES('ISOLATED','Synthetic','Solo','synthetic','2000-01-01','2100-01-01','UTC','2000-01-01','2099-12-31',0,NULL,'active',?,?)").bind(stamp,stamp).run();
    await db.prepare("INSERT INTO drive_backup_folders VALUES('synthetic_root','campaign:synthetic','synthetic_campaign','synthetic_root','Synthetic',?)").bind(Math.floor(Date.now()/1000)).run();
    const folder='application/vnd.google-apps.folder';
    files.set('synthetic_root',{id:'synthetic_root',mimeType:folder,trashed:false});
    files.set('synthetic_campaign',{id:'synthetic_campaign',mimeType:folder,trashed:false,parents:['synthetic_root'],appProperties:{source:'voteproof',folder_key:digest(Buffer.from('campaign:synthetic'))}});
    async function seed(label,mib=1){
      const f=fixtures([[label,mib]])[0],bytes=image(mib*1048576),sha=digest(bytes);
      const triggers=(await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN('submissions_cases_insert','submissions_uploads_insert','submissions_upload_files_insert')").all()).results;
      // Offline synthetic setup only. Restore the exact gates before any HTTP.
      try{for(const t of triggers)await db.prepare('DROP TRIGGER '+t.name).run();await db.batch(unstable_splitSqlQuery(fixtureSQL(f,sha)).map(s=>db.prepare(s)));}
      finally{for(const t of triggers)await db.prepare(t.sql).run();}
      const object=await bucket.put(f.key,bytes,{sha256:sha,httpMetadata:{contentType:'image/png'}});
      await db.batch([
        db.prepare('UPDATE case_files SET etag=? WHERE id=?').bind(object.etag,f.file),
        db.prepare("UPDATE proof_backups SET status='confirmed',source_etag=?,drive_file_id=?,drive_folder_id=?,root_folder_id=?,completed_at=?,lease_until=NULL WHERE file_id=?").bind(object.etag,f.drive,f.day,f.root,Math.floor(Date.now()/1000),f.file),
        db.prepare('UPDATE storage_capacity SET used_bytes=9000000000,reserved_bytes=0,blocked=0,trusted_until=?,observed_at=?,anomaly=NULL,inventory_id=NULL,cleanup_requested=1 WHERE id=1').bind(Math.floor(Date.now()/1000)+600,Math.floor(Date.now()/1000)),
      ]);
      const payload=JSON.parse(await db.prepare('SELECT payload FROM isolated_drive WHERE file_id=?').bind(f.drive).first('payload'));
      files.set(f.day,{id:f.day,mimeType:folder,trashed:false,parents:[f.campaign],appProperties:{source:'voteproof',folder_key:payload.date_key_hash}});
      files.set(f.drive,{id:f.drive,name:f.caseId+'.png',mimeType:'image/png',size:String(f.size),parents:[f.day],trashed:false,appProperties:{source:'voteproof',storage_source:'r2',voteproof_case_id:f.caseId,voteproof_proof_id:f.file}});
      media.set(f.drive,bytes);if(activate)await activateLocalArchive(db);return f;
    }
    const post=async(body={canary:true},extra={})=>{
      const response=await runtime.dispatchFetch(origin+'/api/internal/drive-backup/storage/archive',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+secret,'X-Isolated-Access':secret,'X-Isolated-Sample':(profile?'ops':'arc')+'-1m-1-'+(body?.handoff?'B':'A'),...extra},body:JSON.stringify(body)});
      const text=await response.text();return{status:response.status,body:text?JSON.parse(text):null,metrics:JSON.parse(response.headers.get('X-Canary-Operations')??'null')};
    };
    return{runtime,db,bucket,seed,post,state,files,media,bindings,secret,origin,close:()=>runtime.dispose()};
  }catch(e){await runtime.dispose();throw e;}
}
