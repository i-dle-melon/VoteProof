// Synthetic fixture construction only. Never imported by Production.
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {syntheticProofBytes} from '../../test/fixtures/exact-proof-corpus.js';
export const digest=b=>createHash('sha256').update(b).digest('hex');
export const quote=v=>v===null?'NULL':typeof v==='number'?String(v):"'"+String(v).replaceAll("'","''")+"'";
export function image(size){
  const b=syntheticProofBytes(size,23),n=b.readUInt32BE(33);randomBytes(n).copy(b,41);
  let crc=0xffffffff;for(const byte of b.subarray(37,41+n)){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  b.writeUInt32BE((crc^0xffffffff)>>>0,41+n);return b;
}
export function fixtures(specs){
  return specs.map(([label,mib],i)=>({label,mib,size:mib*1048576,id:randomUUID(),file:randomUUID(),upload:randomUUID(),backup:randomUUID(),
    caseId:'VP-20261018-'+digest(randomUUID()).slice(0,16).split('').map(c=>'ABCDEFGHJKLMNPQR'[parseInt(c,16)]).join(''),key:'proofs/synthetic/'+randomUUID(),drive:'synthetic_'+randomUUID().replaceAll('-',''),
    day:'day_'+randomUUID().replaceAll('-',''),campaign:'synthetic_campaign',root:'synthetic_root',closed:new Date(Date.now()-(9*86400+i)*1000).toISOString(),created:'2026-01-01T00:00:00.000Z'}));
}
export const fixtureSchema=`CREATE TABLE isolated_budget(id TEXT PRIMARY KEY,used INTEGER NOT NULL DEFAULT 0,ceiling INTEGER NOT NULL);
 INSERT INTO isolated_budget(id,ceiling) VALUES('reader',2400),('relay',4800);
 CREATE TABLE isolated_fixtures(label TEXT PRIMARY KEY,file_id TEXT UNIQUE,case_id TEXT,object_key TEXT,expected_sha TEXT,size INTEGER,mode TEXT NOT NULL DEFAULT 'normal');
 CREATE TABLE isolated_drive(file_id TEXT PRIMARY KEY,payload TEXT NOT NULL);`;
// Gate triggers are paused ONLY by the offline setup controller before any
// Worker exists, and restored byte-for-byte before public endpoints are enabled.
export function fixtureSQL(f,sha){
  const q=quote,t=f.created,values=a=>a.map(q).join(',');
  return [
    `INSERT INTO completed_uploads(session_id,manifest_hash,completed_at) VALUES(${values([f.upload,'0'.repeat(64),t])})`,
    `INSERT INTO cases(id,case_id,created_at,updated_at,nickname,player_id,campaign_id,vote_type,vote_date,status,query_key_hash,upload_session_id,reviewed_at,status_updated_at) VALUES(${values([f.id,f.caseId,t,t,'Synthetic anonymous','anonymous','ISOLATED','Solo','2026-01-01','completed','0'.repeat(64),f.upload,f.closed,f.closed])})`,
    `INSERT INTO completed_upload_files(session_id,object_key,content_type,size,etag) VALUES(${values([f.upload,f.key,'image/png',f.size,'unseeded'])})`,
    `INSERT INTO case_files(id,case_id,object_key,content_type,size,etag,created_at,upload_object_key) VALUES(${values([f.file,f.id,f.key,'image/png',f.size,'unseeded',t,f.key])})`,
    `INSERT INTO proof_backups(id,file_id,provider,status,source_object_key,source_size,source_mime,source_etag,created_at) VALUES(${values([f.backup,f.file,'google_drive','pending',f.key,f.size,'image/png','unseeded',Math.floor(Date.now()/1000)])})`,
    `INSERT INTO drive_backup_folders VALUES(${values([f.root,'date:'+f.file,f.day,f.campaign,'Synthetic day',Math.floor(Date.now()/1000)])})`,
    `INSERT INTO isolated_fixtures(label,file_id,case_id,object_key,expected_sha,size) VALUES(${values([f.label,f.file,f.id,f.key,sha,f.size])})`,
    `INSERT INTO isolated_drive VALUES(${values([f.drive,JSON.stringify({file_id:f.drive,sha256:sha,size:f.size,mime:'image/png',name:f.caseId+'.png',folder_id:f.day,campaign_folder_id:f.campaign,root_folder_id:f.root,case_id:f.caseId,proof_id:f.file,campaign_key_hash:digest('campaign:synthetic'),date_key_hash:digest('date:'+f.file)})])})`,
  ].join(';')+';';
}
