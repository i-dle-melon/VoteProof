import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import{randomUUID}from'node:crypto';
import{embeddedCaseRuntime,origin}from'./helpers/embedded-case-runtime.mjs';
import{installResetExtensionLocal}from'../scripts/lib/prelaunch-selective-reset.mjs';
import{memberSession,csrfToken}from'../src/lib/auth-session.js';
import{storageSignature,shaBytes,coldContext}from'../src/lib/cold-storage.js';
import{fencedRequest}from'../src/lib/prelaunch-reset-fence.js';
const ago=n=>new Date(Date.now()-86400000*n).toISOString();
test('single cleanup keeps one Operation, all guards and durable receipt; replay never repeats DELETE',async t=>{
 const f=await fixture(t),c=f.cases[0],before=f.sqlite.prepare('SELECT COUNT(*) n FROM prelaunch_reset_operations').get().n;
 const r=await f.call(c,'clean');assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).data.state,'deleted');
 assert.equal(f.deleteCalls(),1);assert.equal(f.gets(),0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM prelaunch_reset_operations').get().n-before,1);
 assert.equal((await f.call(c,'clean')).status,200);assert.equal(f.deleteCalls(),1);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='manual_cleanup_deleted'").get().n,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM auth_atomic_guards').get().n,0);
});
test('single cleanup refuses source changes and global unresolved R2 before DELETE',async t=>{
 const f=await fixture(t),c=f.cases[0];c.input.backup_version++;
 assert.equal((await f.call(c,'clean')).status,409);assert.equal(f.deleteCalls(),0);c.input.backup_version--;
 f.sqlite.prepare("INSERT INTO prelaunch_reset_operations VALUES(?,1,'unknown',1,1,?,NULL)").run(randomUUID(),new Date().toISOString());
 assert.equal((await f.call(c,'clean')).status,400);assert.equal(f.deleteCalls(),0);
});
test('single cleanup ACK loss after DELETE retains unknown and never auto re-dispatches',async t=>{
 const f=await fixture(t),c=f.cases[0],raw=f.bucket.delete;
 f.bucket.delete=async(...a)=>{await raw(...a);throw Error('lost synthetic ACK');};
 const r=await f.call(c,'clean');assert.equal((await r.json()).data.state,'unknown');assert.equal(f.deleteCalls(),1);
 assert.equal((await f.call(c,'clean')).status,409);assert.equal(f.deleteCalls(),1);
 assert.equal(f.sqlite.prepare("SELECT state FROM cold_proofs WHERE file_id=?").get(c.file.id).state,'deleting');
});
async function fixture(t,{manualSchema=true,count=1,closed=true}={}){
 const f=await embeddedCaseRuntime();t.after(()=>f.close());const admin=await f.identity('super_admin'),other=await f.identity('admin'),member=await f.identity();
 // This older embedded bucket lacks provider versions; model that required
 // native field in this fixture, rather than relaxing the Runtime guard.
 const nativePut=f.bucket.put;f.bucket.put=async(...args)=>{const o=await nativePut(...args);if(o)o.version=randomUUID();return o;};
 f.sqlite.exec(fs.readFileSync('migrations-storage-policy/0001_observe_capacity.sql','utf8'));f.sqlite.exec("UPDATE storage_capacity SET upload_policy='observe'");
 f.sqlite.prepare("UPDATE submission_settings SET submissions_enabled=1").run();
 const now=new Date().toISOString();f.sqlite.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at) VALUES('MANUAL','Synthetic','團體','2000-01-01','2100-01-01','Asia/Taipei','2000-01-01','2099-12-31',3,'active',?,?)").run(now,now);
 installResetExtensionLocal(f.sqlite,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));f.sqlite.exec("UPDATE prelaunch_reset_control SET epoch=1,mode='open'");
 Object.assign(f.env,{PRELAUNCH_RESET_FENCE_ENABLED:'true',STORAGE_CAPACITY_ENFORCEMENT:'disabled',R2_MANUAL_CLEANUP_ENABLED:'true',R2_EXCLUSIVE_WRITER_CONFIRMED:'true',DRIVE_BACKUP_RELAY_SECRET:'a'.repeat(64),DRIVE_COLD_RELAY_URL:'https://script.google.com'+'/macros/s/localtest/exec'});
 for(const a of[admin,other,member]){const session=await memberSession(new Request(origin,{headers:a.headers}),f.env);a.headers['X-CSRF-Token']=await csrfToken(session,{...f.env,PRELAUNCH_RESET_CONTEXT:{epoch:1}});}
 const write=(sql,...args)=>fencedRequest(f.env,new Request(origin+'/api/local-fixture',{method:'POST'}),async env=>{await env.DB.prepare(sql).bind(...args).run();return Response.json({ok:true});});
 let driveCalls=0,deleteCalls=0,gets=0,driveFailure=false,wrongSha=false,wrongBinding=false;
 globalThis.fetch=async(url,init)=>{
  if(String(url).includes('/turnstile/'))return Response.json({success:true});
  assert.equal(String(url),f.env.DRIVE_COLD_RELAY_URL);driveCalls++;if(driveFailure)return new Response('',{status:503});
  const r=JSON.parse(init.body),b=await f.db.prepare('SELECT source_object_key FROM proof_backups WHERE drive_file_id=?').bind(r.file_id).first(),row=await coldContext(f.db,b.source_object_key);
  const payload={file_id:r.file_id,sha256:wrongSha?'0'.repeat(64):r.expected_sha256,size:row.size,mime:row.content_type,name:row.case_id+'.png',folder_id:row.drive_folder_id,campaign_folder_id:row.campaign_folder_id,root_folder_id:row.root_folder_id,case_id:wrongBinding?'other':row.case_id,proof_id:row.file_id,campaign_key_hash:await shaBytes(new TextEncoder().encode(row.campaign_key)),date_key_hash:await shaBytes(new TextEncoder().encode(row.date_key))};
  const result={nonce:r.nonce,timestamp:Math.floor(Date.now()/1000),payload:JSON.stringify(payload)};result.signature=await storageSignature(f.env.DRIVE_BACKUP_RELAY_SECRET,JSON.stringify(['VoteProof/archive-verified-result',result.nonce,result.timestamp,result.payload]));return Response.json(result);
 };
 const cases=[];
 for(let n=0;n<count;n++){
  const u=await f.upload('MANUAL',member),r=await f.fetch('/api/cases/direct','POST',{campaign_id:'MANUAL',vote_date:now.slice(0,10),upload_session:u.ref},{...member.headers,'Idempotency-Key':randomUUID()});assert.equal(r.status,201,await r.clone().text());const data=(await r.json()).data;
  const row=await f.db.prepare('SELECT * FROM cases WHERE case_id=?').bind(data.case_id).first(),file=await f.db.prepare('SELECT * FROM case_files WHERE case_id=?').bind(row.id).first();
  if(closed){for(const[action,v]of[['approve',0],['complete',1]]){const rr=await f.fetch('/api/admin/cases/'+data.case_id+'/review','POST',{action,expected_version:v},admin.headers);assert.equal(rr.status,200,await rr.clone().text());}
  await write('UPDATE cases SET reviewed_at=?,status_updated_at=? WHERE id=?',ago(8),ago(8),row.id);}
  await write('INSERT INTO drive_backup_folders VALUES(?,?,?,?,?,?)','root','campaign:'+file.id,'campaign_'+file.id,'root','test',1);
  await write('INSERT INTO drive_backup_folders VALUES(?,?,?,?,?,?)','root','date:'+file.id,'day_'+file.id,'campaign_'+file.id,'test',1);
  await write("UPDATE proof_backups SET status='confirmed',root_folder_id='root',drive_file_id=?,drive_folder_id=?,lease_until=NULL,completed_at=1 WHERE file_id=?",'drive_'+file.id,'day_'+file.id,file.id);
  cases.push({data,row,file,input:{file_id:file.id,case_version:closed?2:0,backup_version:0,attempt_id:randomUUID()}});
 }
 if(manualSchema)f.sqlite.exec(fs.readFileSync('migrations-manual-cleanup/0001_manual_guards.sql','utf8'));
 const rawDelete=f.bucket.delete,rawGet=f.bucket.get;f.bucket.delete=async(...args)=>{deleteCalls++;return rawDelete(...args);};f.bucket.get=async(...args)=>{gets++;return rawGet(...args);};
 const call=(item,action,actor=admin)=>f.fetch('/api/admin/storage/manual/'+item.file.id+'/'+action,action==='status'?'GET':'POST',action==='status'?undefined:item.input,actor.headers);
 return{...f,write,admin,other,member,cases,call,driveCalls:()=>driveCalls,deleteCalls:()=>deleteCalls,gets:()=>gets,setDrive:o=>{driveFailure=!!o.failure;wrongSha=!!o.sha;wrongBinding=!!o.binding;}};
}
test('manual cleanup verifies signed Drive identity/checksum; preserves Case, points, member and SHA; never cold-reads',async t=>{
 const f=await fixture(t),c=f.cases[0],before=f.sqlite.prepare('SELECT * FROM point_transactions').all(),members=f.sqlite.prepare('SELECT * FROM members').all();
 const list=await f.fetch('/api/admin/storage/manual','GET',undefined,f.admin.headers);assert.equal(list.status,200);assert.equal((await list.json()).data.items[0].eligible,true);
 const v=await f.call(c,'verify');assert.equal(v.status,200,await v.clone().text());assert.equal((await v.json()).data.state,'verified');
 const d=await f.call(c,'delete');assert.equal(d.status,200,await d.clone().text());assert.equal((await d.json()).data.state,'deleted');assert.equal(f.deleteCalls(),1);assert.equal(f.driveCalls(),1);assert.equal(f.gets(),0);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM point_transactions').all(),before);assert.deepEqual(f.sqlite.prepare('SELECT * FROM members').all(),members);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM cases').first()).n,1);
 assert.match((await f.db.prepare('SELECT sha256 FROM cold_proofs').first()).sha256,/^[a-f0-9]{64}$/);assert.equal((await f.db.prepare('SELECT used_bytes FROM storage_capacity').first()).used_bytes,0);
 const get=await f.fetch('/api/admin/cases/'+c.data.case_id+'/files/'+c.file.id,'GET',undefined,f.admin.headers);assert.equal(get.status,410);assert.equal(f.gets(),0);
 const detail=await f.fetch('/api/me/cases/'+c.data.case_id,'GET',undefined,f.member.headers);assert.equal(detail.status,200);assert.equal((await detail.json()).data.files[0].storage_state,'cold');
 const lookup=await f.fetch('/api/cases/'+c.data.case_id,'GET',undefined,{'X-Case-Query-Key':c.data.query_key});assert.equal(lookup.status,200);assert.equal((await lookup.json()).data.files[0].storage_state,'cold');
 const b=await f.db.prepare('SELECT * FROM proof_backups WHERE file_id=?').bind(c.file.id).first();
 const relay=await f.fetch('/api/internal/drive-backup/'+b.id+'/content','GET',undefined,{Authorization:'Bearer '+f.env.DRIVE_BACKUP_RELAY_SECRET,'X-VoteProof-Reset-Epoch':'1','X-VoteProof-Backup-Lease':randomUUID(),'X-VoteProof-Backup-Attempt':'1'});assert.equal(relay.status,409);assert.equal(f.gets(),0);assert.equal(f.driveCalls(),1);
 assert.equal((await(await f.call(c,'delete')).json()).data.state,'deleted');assert.equal(f.deleteCalls(),1);
});
for(const variant of['missing','sha','binding'])test('Drive '+variant+' blocks manual DELETE and releases only its known pre-dispatch verification',async t=>{
 const f=await fixture(t),c=f.cases[0];f.setDrive({failure:variant==='missing',sha:variant==='sha',binding:variant==='binding'});assert.notEqual((await f.call(c,'verify')).status,200);assert.equal(f.deleteCalls(),0);assert.ok(await f.bucket.head(c.file.object_key));
 assert.equal(f.driveCalls(),1);
});
for(const variant of['pending_case','reservation','pin','unknown_r2','pending_r2','export','inventory','anomaly'])test('manual cleanup refuses '+variant+' without altering the conflict',async t=>{
 const f=await fixture(t),c=f.cases[0];
 if(variant==='pending_case')await f.write("UPDATE cases SET status='pending' WHERE id=?",c.row.id);
 if(variant==='reservation')await f.write("INSERT INTO storage_reservations(id,object_key,bytes,state,created_at) VALUES(?,?,3,'reserved',1)",randomUUID(),c.file.object_key);
 if(variant==='pin')await f.write('UPDATE proof_upload_intents SET write_token=? WHERE object_key=?',randomUUID(),c.file.object_key);
 if(['unknown_r2','pending_r2'].includes(variant))f.sqlite.prepare("INSERT INTO prelaunch_reset_operations(id,epoch,state,started_at,r2_writes,pending_r2) VALUES(?,1,'unknown',?,1,?)").run(randomUUID(),new Date().toISOString(),Number(variant==='pending_r2'));
 if(variant==='export'){
  const job=randomUUID();await f.write("INSERT INTO export_jobs(id,owner_member_id,created_at,expires_at,filters_json,from_utc,to_utc) VALUES(?,?,?,'2100-01-01','{}','2000-01-01','2100-01-01')",job,f.admin.memberId,new Date().toISOString());
  await f.write(`INSERT INTO export_job_items(job_id,ordinal,package_no,file_id,case_id,created_at,campaign_id,campaign_name,vote_type,source,review_status,review_stage,content_type,file_size,etag)
   SELECT ?,1,1,f.id,c.case_id,c.created_at,c.campaign_id,'Synthetic',c.vote_type,c.source,c.status,c.review_stage,f.content_type,f.size,f.etag FROM case_files f JOIN cases c ON c.id=f.case_id WHERE f.id=?`,job,c.file.id);
 }
 if(variant==='inventory')await f.write("UPDATE storage_capacity SET inventory_id='active' WHERE id=1");
 if(variant==='anomaly')await f.write("UPDATE storage_capacity SET anomaly='UNEXPLAINED' WHERE id=1");
 assert.notEqual((await f.call(c,'verify')).status,200);assert.equal(f.deleteCalls(),0);assert.equal(f.driveCalls(),0);
});
test('DELETE ACK loss and post-delete D1 failure retain dispatch and never resend',async t=>{for(const mode of['ack','terminal']){
 const f=await fixture(t),c=f.cases[0];assert.equal((await f.call(c,'verify')).status,200);
 if(mode==='ack'){const raw=f.bucket.delete;f.bucket.delete=async(...args)=>{await raw(...args);throw Error('SYNTHETIC_ACK_LOST');};}
 else f.sqlite.exec("CREATE TRIGGER local_cleanup_receipt_failure BEFORE INSERT ON storage_audit WHEN NEW.action='manual_cleanup_deleted' BEGIN SELECT RAISE(ABORT,'LOCAL_TERMINAL_FAILURE');END");
 assert.equal((await(await f.call(c,'delete')).json()).data.state,'unknown');assert.equal(f.deleteCalls(),1);assert.equal((await(await f.call(c,'status')).json()).data.state,'unknown');
 assert.notEqual((await f.call(c,'delete')).status,200);assert.equal(f.deleteCalls(),1);assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM storage_audit WHERE action='manual_cleanup_dispatch'").first()).n,1);
}});
test('parallel admins cannot verify/delete the same proof; new exports and backup mutations are pinned',async t=>{
 const f=await fixture(t),c=f.cases[0],rival={...c,input:{...c.input,attempt_id:randomUUID()}},rs=await Promise.all([f.call(c,'verify'),f.call(rival,'verify',f.other)]);assert.equal(rs.filter(r=>r.status===200).length,1);assert.equal(f.driveCalls(),1);
 await assert.rejects(f.db.prepare('UPDATE proof_backups SET version=version+1 WHERE file_id=?').bind(c.file.id).run(),/PINNED/);
 await assert.rejects(f.db.prepare("UPDATE storage_capacity SET inventory_id='new' WHERE id=1").run(),/IN_PROGRESS/);
 const winner=rs[0].status===200?c:rival,owner=rs[0].status===200?f.admin:f.other;
 const rs2=await Promise.all([f.call(winner,'delete',owner),f.call(winner,'delete',owner)]);assert.ok(rs2.some(r=>r.status===200));assert.equal(f.deleteCalls(),1);
});
test('manual cleanup requires schema, flag, role, CSRF and original versions',async t=>{
 const f=await fixture(t),c=f.cases[0];assert.equal((await f.call(c,'verify',f.member)).status,403);
 assert.equal((await f.call(c,'verify',{headers:{...f.admin.headers,'X-CSRF-Token':'bad'}})).status,403);
 assert.notEqual((await f.call({...c,input:{...c.input,case_version:1}},'verify')).status,200);
 f.env.R2_MANUAL_CLEANUP_ENABLED='false';assert.equal((await f.call(c,'verify')).status,503);assert.equal(f.deleteCalls(),0);
 const missing=await fixture(t,{manualSchema:false});assert.equal((await missing.call(missing.cases[0],'verify')).status,503);
});
test('manual candidates span pages in stable order; filters/cutoff bind the cursor and lists are read-only',async t=>{
 const f=await fixture(t,{count:25});const base='/api/admin/storage/manual?eligible=yes&campaign_id=MANUAL';
 const first=(await(await f.fetch(base,'GET',undefined,f.admin.headers)).json()).data;assert.equal(first.items.length,20);assert.equal(first.total,25);assert.equal(first.eligible_bytes,75);
 const next=(await(await f.fetch(base+'&cutoff='+first.cutoff+'&cursor='+encodeURIComponent(first.next_cursor),'GET',undefined,f.admin.headers)).json()).data;
 assert.equal(next.items.length,5);assert.equal(next.next_cursor,null);assert.equal(new Set([...first.items,...next.items].map(r=>r.file_id)).size,25);
 assert.equal((await f.fetch(base+'&status=rejected&cutoff='+first.cutoff+'&cursor='+encodeURIComponent(first.next_cursor),'GET',undefined,f.admin.headers)).status,400);
 const again=(await(await f.fetch(base+'&cutoff='+first.cutoff,'GET',undefined,f.admin.headers)).json()).data;assert.deepEqual(again.items.map(x=>x.file_id),first.items.map(x=>x.file_id));assert.equal(f.driveCalls(),0);assert.equal(f.deleteCalls(),0);
});
test('R2 version race and source version changes are refused before DELETE',async t=>{
 const f=await fixture(t),c=f.cases[0],head=f.bucket.head;let calls=0;
 f.bucket.head=async key=>{const o=await head(key);return ++calls===2?{...o,version:'different-native-version'}:o;};
 assert.notEqual((await f.call(c,'verify')).status,200);assert.equal(f.deleteCalls(),0);
 f.bucket.head=head;await f.write('UPDATE proof_backups SET version=version+1 WHERE file_id=?',c.file.id);
 assert.notEqual((await f.call(c,'verify')).status,200);assert.equal(f.deleteCalls(),0);
});
test('batch reject requires a reason and preserves each Case image/member/points with independent audit',async t=>{
 const f=await fixture(t,{count:3,closed:false}),items=f.cases.map(c=>({case_id:c.data.case_id,expected_version:0})),request=(body,actor=f.admin)=>f.fetch('/api/admin/cases/batch-reject','POST',body,actor.headers);
 for(const reason of['',' '.repeat(3),'x'.repeat(501),null])assert.equal((await request({cases:items,reason})).status,400);
 assert.equal((await request({cases:items,reason:'Synthetic reason'},f.member)).status,403);
 const r=await request({cases:items,reason:'Synthetic reason'});assert.equal(r.status,200);assert.equal((await r.json()).data.succeeded,3);
 const rows=(await f.db.prepare('SELECT status,status_reason,version FROM cases').all()).results;assert.ok(rows.every(r=>r.status==='rejected'&&r.status_reason==='Synthetic reason'&&r.version===1));
 assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE action='reject'").first()).n,3);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,0);assert.equal(f.deleteCalls(),0);for(const c of f.cases)assert.ok(await f.bucket.head(c.file.object_key));
 const replay=await request({cases:items,reason:'Synthetic reason'});assert.equal((await replay.json()).data.succeeded,3);assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE action='reject'").first()).n,3);
 const status=await f.fetch('/api/admin/cases/batch-reject/status','POST',{cases:items,reason:'other'},f.admin.headers);assert.equal((await status.json()).data.unknown,3);
});
test('batch reject handles mixed eligibility and competing admins using expected version; no extra ledger writes',async t=>{
 const f=await fixture(t,{count:2,closed:false}),a=f.cases[0].data.case_id,b=f.cases[1].data.case_id;
 assert.equal((await f.fetch('/api/admin/cases/'+b+'/review','POST',{action:'approve',expected_version:0},f.admin.headers)).status,200);
 const body={cases:[{case_id:a,expected_version:0},{case_id:b,expected_version:0}],reason:'A'};
 const rs=await Promise.all([f.fetch('/api/admin/cases/batch-reject','POST',body,f.admin.headers),f.fetch('/api/admin/cases/batch-reject','POST',{...body,reason:'B'},f.other.headers)]);const data=await Promise.all(rs.map(r=>r.json()));assert.equal(data.reduce((n,r)=>n+r.data.succeeded,0),1);
 assert.equal((await f.db.prepare('SELECT status FROM cases WHERE case_id=?').bind(b).first()).status,'approved');assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,1);
});
test('reject committed then lost ACK reconciles exact actor/reason audit; terminal failure rolls back and stops remainder',async t=>{for(const mode of['ack','terminal']){
 const f=await fixture(t,{count:2,closed:false}),items=f.cases.map(c=>({case_id:c.data.case_id,expected_version:0}));
 if(mode==='terminal')f.sqlite.exec("CREATE TRIGGER local_reject_failure BEFORE INSERT ON admin_audit_logs WHEN NEW.action='reject' BEGIN SELECT RAISE(ABORT,'LOCAL_REJECT_TERMINAL');END");
 else{const db=f.env.DB;let lost=false;f.env.DB={...db,batch:async xs=>{const result=await db.batch(xs);if(!lost&&xs.some(s=>s.sql.includes('UPDATE cases SET status =')&&s.values[0]==='rejected')){lost=true;throw Error('LOCAL_CASE_ACK_LOST');}return result;}};}
 const r=await f.fetch('/api/admin/cases/batch-reject','POST',{cases:items,reason:'Exact audit reason'},f.admin.headers),d=(await r.json()).data;
 if(mode==='ack'){assert.equal(d.succeeded,1);assert.equal(d.results[1].code,'REVIEW_NOT_SUBMITTED');assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE action='reject'").first()).n,1);assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM cases WHERE status='pending'").first()).n,1);}
 else{assert.equal(d.unknown,1);assert.equal(d.results[1].code,'REVIEW_NOT_SUBMITTED');assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM cases WHERE status='pending'").first()).n,2);}
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM point_transactions').first()).n,0);
}});
test('overview date windows use Taipei submission dates and reject invalid ranges without writes',async t=>{
 const f=await fixture(t,{count:2,closed:false}),a=f.cases[0],b=f.cases[1];
 await f.write("UPDATE cases SET created_at='2026-10-31T15:59:59.000Z' WHERE id=?",a.row.id);
 await f.write("UPDATE cases SET created_at='2026-10-31T16:00:00.000Z' WHERE id=?",b.row.id);
 const before=(await f.db.prepare('SELECT COUNT(*) n FROM prelaunch_reset_operations').first()).n;
 const r=await f.fetch('/api/admin/overview?from=2026-11-01&to=2026-11-01','GET',undefined,f.admin.headers);assert.equal(r.status,200);const d=(await r.json()).data;assert.equal(d.case_totals.pending,1);assert.equal(d.member_count,null);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM prelaunch_reset_operations').first()).n,before);
 for(const q of['from=bad&to=2026-11-01','from=2026-11-31&to=2026-11-31','from=2026-11-01','from=2026-11-02&to=2026-11-01','from=2026-11-01&from=2026-11-01&to=2026-11-01'])assert.equal((await f.fetch('/api/admin/overview?'+q,'GET',undefined,f.admin.headers)).status,400);
});
test('independent board presentation preserves original fixed guards; audited CAS and ledger scope remain intact',async t=>{
 const f=await fixture(t),before=(await f.db.prepare('SELECT * FROM point_transactions').all()).results,path='/api/admin/leaderboards/system-history/presentation',input={name:'歷史總成績',top_n:20,is_public:false,expected_version:0};
 f.sqlite.exec(fs.readFileSync('migrations-admin-presentation/0001_leaderboard_presentation.sql','utf8'));f.env.ADMIN_LEADERBOARD_PRESENTATION_ENABLED='true';
 let databaseError='';const raw=f.env.DB;f.env.DB={...raw,batch:async xs=>{try{return await raw.batch(xs);}catch(e){databaseError=e.message;throw e;}}};
 const r=await f.fetch(path,'POST',input,f.admin.headers);assert.equal(r.status,200,(await r.clone().text())+' '+databaseError);const data=(await r.json()).data;assert.equal(data.name,input.name);assert.equal(data.version,1);
 const list=(await(await f.fetch('/api/admin/leaderboards','GET',undefined,f.admin.headers)).json()).data;assert.equal(list.system_boards.find(b=>b.leaderboard_id==='system-history').is_public,false);
 const catalog=(await(await f.fetch('/api/leaderboards?view=catalog')).json()).data;assert.equal(catalog.leaderboards.some(b=>b.leaderboard_id==='system-history'),false);
 assert.equal((await f.fetch(path,'POST',input,f.admin.headers)).status,409);assert.equal((await f.fetch(path,'POST',{...input,expected_version:1,vote_type:'Solo'},f.admin.headers)).status,400);
 assert.deepEqual((await f.db.prepare('SELECT * FROM point_transactions').all()).results,before);
 assert.equal(await f.db.prepare('SELECT leaderboard_id FROM leaderboards WHERE leaderboard_id=?').bind('system-history').first(),null);
 assert.equal(list.system_boards.find(b=>b.leaderboard_id==='system-history').type,'all_time');
 assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM admin_audit_logs WHERE action='leaderboard_update'").first()).n,1);
 assert.equal((await f.fetch(path,'POST',{...input,expected_version:1},f.member.headers)).status,403);
});
