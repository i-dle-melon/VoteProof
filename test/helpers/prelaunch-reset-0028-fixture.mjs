import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';import {randomUUID,randomBytes} from 'node:crypto';
import {encryptTotp} from '../../src/lib/auth-crypto.js';import {encryptEmail,emailHash} from '../../src/lib/auth-identity.js';import {Secret} from 'otpauth';
import {LocalResetObjects} from '../../scripts/lib/prelaunch-reset-objects.mjs';
import {digest} from '../../scripts/lib/prelaunch-reset-snapshot.mjs';
import {capture64 as capture,isolationPlan} from '../../scripts/lib/prelaunch-reset-0028.mjs';
import {sessionHash} from '../../src/lib/auth-session.js';

import p from 'node:path';import {tmpdir} from 'node:os';
export async function fixture(){
 const token=randomBytes(32).toString('base64url');const handles=[];const root=fs.mkdtempSync(p.join(p.resolve(tmpdir()),'vp-reset-0028-')),db=new DatabaseSync(p.join(root,'source.sqlite'));
 db.exec('PRAGMA foreign_keys=ON');
 for(const name of fs.readdirSync('migrations').filter(n=>/^\d+_.+\.sql$/.test(n)).sort()){db.exec('BEGIN');try{db.exec(fs.readFileSync('migrations/'+name,'utf8'));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 const insert=(table,row)=>{const keys=Object.keys(row);db.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]));};
 const stamp='2026-10-26T00:00:00.000Z',bytes=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVZkAAAAASUVORK5CYII=','base64')),sha=digest(bytes),member='M-local',admin='M-operator';
 for(const [i,id]of [member,admin].entries())insert('members',{id:randomUUID(),member_id:id,login_name:'local'+i,nickname:'Synthetic '+i,player_id:'FAN-'+i,status:'active',created_at:stamp,updated_at:stamp,last_login_at:stamp});
 insert('admin_memberships',{id:randomUUID(),member_id:admin,role:'super_admin',status:'active',created_at:stamp,updated_at:stamp});
 insert('auth_sessions',{token_hash:await sessionHash(token),member_id:admin,created_at:1,expires_at:4102444800,elevated_until:4102444800});
 insert('trusted_devices',{id:randomUUID(),token_hash:'b'.repeat(64),member_id:member,created_at:1,expires_at:4102444800,last_used_at:1});
 const authEnv={AUTH_SECRET:randomBytes(32).toString('hex'),AUTH_TOTP_ENCRYPTION_KEY:randomBytes(32).toString('hex')},totp=new Secret({size:20}).base32;
 insert('member_credentials',{member_id:member,...await encryptTotp(totp,member,authEnv),last_used_time_step:1,version:1,recovery_generation:1,updated_at:1});
 insert('recovery_codes',{member_id:member,generation:1,code_hash:'c'.repeat(64),created_at:1});
 const subject=randomUUID(),email='synthetic@example.invalid';
 insert('auth_identities',{provider:'supabase',provider_subject:subject,member_id:member,email_lookup_hash:await emailHash(authEnv,email),...await encryptEmail(authEnv,email,subject),created_at:1,password_enabled:1,google_identity_id:randomUUID()});
 insert('campaigns',{campaign_id:'LOCAL-RESET',name:'Synthetic',category:'團體',solo_target:null,start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',campaign_timezone:'Asia/Taipei',vote_start_date:'2000-01-01',vote_end_date:'2099-12-31',points_per_proof:10,daily_limit:null,status:'active',created_at:stamp,updated_at:stamp});
 db.exec('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1');
 for(const [i,owner]of [member,null].entries()){
  const session='session-'+i,key='proofs/staging/'+i+'.png',file='file-'+i,c='case-'+i;
  insert('completed_uploads',{session_id:session,manifest_hash:'a'.repeat(64),completed_at:stamp,expires_at:'2100-01-01T00:00:00.000Z'});
  insert('completed_upload_files',{session_id:session,object_key:key,content_type:'image/png',size:bytes.length,etag:'synthetic'});
  insert('cases',{id:c,case_id:'LOCAL-'+i,created_at:stamp,updated_at:stamp,nickname:'Synthetic',player_id:owner?'FAN-0':'匿名投稿',member_id:owner,campaign_id:'LOCAL-RESET',vote_type:'團體',vote_date:'2026-10-26',query_key_hash:'b'.repeat(64),upload_session_id:session,status:'pending',source:owner?'member':'guest'});
  insert('case_files',{id:file,case_id:c,object_key:'proofs/cases/'+i+'.png',content_type:'image/png',size:bytes.length,etag:'synthetic',created_at:stamp,upload_object_key:key});
  insert('proof_backups',{id:'backup-'+i,file_id:file,provider:'google_drive',source_object_key:'proofs/cases/'+i+'.png',source_size:bytes.length,source_mime:'image/png',source_etag:'synthetic',created_at:1,drive_file_id:'drive-'+i,drive_folder_id:'local-day',root_folder_id:'local-root',status:'confirmed',completed_at:1});
 }
 insert('point_transactions',{transaction_id:'txn-local',created_at:stamp,member_id:member,category:'manual_adjustment',points:125,reason:'Synthetic prelaunch test',created_by:admin,idempotency_hash:'e'.repeat(64),request_hash:'f'.repeat(64)});
 for(const [action,type,id]of [['bootstrap_membership','admin_membership','local-role'],['complete','case','case-0']])insert('admin_audit_logs',{id:'audit-'+id,created_at:stamp,admin_member_id:admin,admin_role:'super_admin',action,target_type:type,target_id:id,target_version:1,before_json:'{}',after_json:'{}'});
 insert('leaderboards',{leaderboard_id:'LOCAL-BOARD',name:'Synthetic board',type:'campaign',campaign_id:'LOCAL-RESET',top_n:20,is_public:1,status:'active',created_at:stamp,updated_at:stamp,created_by:admin,updated_by:admin});
 insert('leaderboard_runs',{run_id:'LOCAL-RUN',leaderboard_id:'LOCAL-BOARD',generated_at:stamp,definition_version:0,source_count:1,source_last_transaction_id:'txn-local',row_count:0,status:'building',definition_json:'{}',integrity_errors:0});
 insert('leaderboard_results',{run_id:'LOCAL-RUN',leaderboard_id:'LOCAL-BOARD',rank:1,member_id:member,nickname:'Synthetic',points:125,proof_count:0,reached_at:stamp});
 db.exec("UPDATE leaderboard_runs SET status='success',row_count=1 WHERE run_id='LOCAL-RUN'; UPDATE leaderboards SET current_run_id='LOCAL-RUN' WHERE leaderboard_id='LOCAL-BOARD';");
 insert('campaign_example_assets',{asset_id:'local-asset',campaign_id:'LOCAL-RESET',object_key:'campaign-assets/LOCAL-RESET/example/local.png',content_type:'image/png',size:bytes.length,etag:'synthetic',created_at:stamp,created_by:admin});
 db.exec('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1');
 // Wrangler registry is auxiliary to the 64 app tables; synthetic here.
 db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT NOT NULL)');
 for(const name of fs.readdirSync('migrations').filter(n=>/^\d+_.+\.sql$/.test(n)).sort())insert('d1_migrations',{name,applied_at:stamp});
 const stores={r2:new LocalResetObjects(p.join(root,'r2.sqlite'),'r2'),drive:new LocalResetObjects(p.join(root,'drive.sqlite'),'drive')},vault=new LocalResetObjects(p.join(root,'recovery.sqlite'),'recovery'),next=new LocalResetObjects(p.join(root,'clean-r2.sqlite'),'r2');
 for(let i=0;i<2;i++){stores.r2.put('proofs/cases/'+i+'.png',bytes);stores.r2.put('proofs/staging/'+i+'.png',bytes);stores.drive.put('drive-'+i,bytes,'image/png',{source:'voteproof',storage_source:'r2',root_folder_id:'local-root',voteproof_case_id:'LOCAL-'+i,voteproof_proof_id:'file-'+i});}
 stores.r2.put('proofs/staging/orphan.png',bytes);stores.r2.put('campaign-assets/LOCAL-RESET/example/local.png',bytes);stores.r2.put('unrelated/site.png',bytes);stores.drive.put('unrelated-drive',bytes,'image/png',{source:'another-app',root_folder_id:'local-root'});
 const context={environment:'local-synthetic',phase:'unbound-shadow-only',targetExposed:false,identityFreezeModel:true,sourceBucket:'local-source-r2',targetBucket:'local-clean-r2',sourceDriveRoot:'local-root',targetDriveRoot:'local-clean-drive',siteAssetKeys:['unrelated/site.png'],oldDeleteStatus:'UNKNOWN',dispatch9:'HOLD'};
 const snapshot=capture(db),runId=randomUUID(),plan=isolationPlan(snapshot,context,{...stores,next});
 return{track:h=>{handles.push(h);return h;},root,db,insert,bytes,context,snapshot,plan,stores,next,vault,authEnv,totp,email,token,runId,targetPath:p.join(root,'target.sqlite'),journalPath:p.join(root,'copy-journal.json'),
  close(){for(const h of handles.reverse())h.close();db.close();for(const s of Object.values(stores))s.close();next.close();vault.close();if(p.dirname(root)!==p.resolve(tmpdir())||!p.basename(root).startsWith('vp-reset-0028-'))throw Error('BAD_FIXTURE_ROOT');fs.rmSync(root,{recursive:true,force:true});}};
}
