// Tests offline builders against disposable local D1 only. No operator CLI,
// Production bootstrap, provider request, export or restore rehearsal is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { unstable_splitSqlQuery } from 'wrangler';
import { localCaseRuntime } from '../scripts/lib/local-case-runtime.mjs';
import { adminBootstrapPlan, campaignBootstrapPlan, legacyCleanupPlan } from '../scripts/lib/release-plans.mjs';
import { newCaseId, sha256 } from '../src/lib/case-keys.js';
import { reviewCampaign } from '../src/lib/campaign-policy.js';
const hex=bytes=>randomBytes(bytes).toString('hex');
async function isolated(fn) { const h=await localCaseRuntime({seedCampaign:false});try {await fn(h);} finally {await h.runtime.dispose();} }
const run=(h,sql)=>h.db.batch(unstable_splitSqlQuery(sql).map(s=>h.db.prepare(s)));
const count=async(h,table)=>(await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n;
async function identity(h,{totp=true,mfa=true,status='active'}={}) {
  const id='M-'+randomUUID(), now=Math.floor(Date.now()/1000), stamp=new Date().toISOString();
  await h.db.prepare('INSERT INTO members(id,member_id,login_name,status,created_at,updated_at,last_login_at) VALUES(?,?,?,?,?,?,?)')
    .bind(randomUUID(),id,hex(16),status,stamp,stamp,stamp).run();
  await h.db.prepare(`INSERT INTO auth_identities(member_id,provider,provider_subject,email_lookup_hash,email_ciphertext,email_iv,email_key_version,password_enabled,created_at)
    VALUES(?,'supabase',?,?,?,?,1,0,?)`).bind(id,randomUUID(),hex(32),hex(48),hex(12),now).run();
  if(totp)await h.db.prepare('INSERT INTO member_credentials(member_id,totp_ciphertext,totp_iv,totp_key_version,last_used_time_step,updated_at) VALUES(?,?,?,1,?,?)')
    .bind(id,hex(48),hex(12),Math.floor(now/30),now).run();
  await h.db.prepare('INSERT INTO auth_sessions(token_hash,member_id,created_at,expires_at,elevated_until,reauthenticated_until,auth_method) VALUES(?,?,?,?,?,?,?)')
    .bind(hex(32),id,now,now+3600,mfa?now+3600:0,mfa?now+300:0,'google').run();
  return id;
}
const admin=id=>adminBootstrapPlan({member_id:id,role:'super_admin',reason:'operator ticket / disposable local test'});
const campaign=id=>({actor_member_id:id,reason:'disposable fixture only',campaign:{campaign_id:'LOCAL-RELEASE-FIXTURE',name:'Local fixture',category:'local',start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',campaign_timezone:'Asia/Taipei',points_per_proof:1,daily_limit:1,status:'active',note:null}});

test('release admin rejects nonexistent member atomically',()=>isolated(async h=>{
  await assert.rejects(run(h,admin('M-'+randomUUID()).sql));assert.equal(await count(h,'admin_memberships'),0);assert.equal(await count(h,'admin_audit_logs'),0);
}));
test('release Google-only member without VoteProof TOTP cannot bootstrap',()=>isolated(async h=>{
  const id=await identity(h,{totp:false});await assert.rejects(run(h,admin(id).sql));assert.equal(await count(h,'admin_memberships'),0);
}));
test('release TOTP enrollment alone or trusted-device login does not suffice',()=>isolated(async h=>{
  const id=await identity(h,{mfa:false});await assert.rejects(run(h,admin(id).sql));assert.equal(await count(h,'admin_memberships'),0);
}));
test('release suspended member cannot bootstrap',()=>isolated(async h=>{
  const id=await identity(h,{status:'suspended'});await assert.rejects(run(h,admin(id).sql));
}));
test('release initial admin grants once with audit; duplicate refuses safely',()=>isolated(async h=>{
  const id=await identity(h);await run(h,admin(id).sql);
  assert.equal(await count(h,'admin_memberships'),1);const audit=await h.db.prepare('SELECT * FROM admin_audit_logs').first();
  assert.equal(audit.action,'bootstrap_membership');assert.equal(audit.admin_member_id,id);assert.equal(JSON.parse(audit.after_json).role,'super_admin');
  await assert.rejects(run(h,admin(id).sql));assert.equal(await count(h,'admin_memberships'),1);assert.equal(await count(h,'admin_audit_logs'),1);assert.equal(await count(h,'auth_atomic_guards'),0);
}));
test('release concurrent initial grants cannot create two memberships',()=>isolated(async h=>{
  const a=await identity(h),b=await identity(h);const results=await Promise.allSettled([run(h,admin(a).sql),run(h,admin(b).sql)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await count(h,'admin_memberships'),1);assert.equal(await count(h,'admin_audit_logs'),1);
}));
test('release audit failure rolls back role',()=>isolated(async h=>{
  const id=await identity(h);await h.db.prepare("CREATE TRIGGER local_force_audit_failure BEFORE INSERT ON admin_audit_logs BEGIN SELECT RAISE(ABORT,'local test'); END").run();
  await assert.rejects(run(h,admin(id).sql));assert.equal(await count(h,'admin_memberships'),0);assert.equal(await count(h,'auth_atomic_guards'),0);
}));
test('release plan rejects placeholders, invalid role and SQL-shaped member id',()=>{
  assert.throws(()=>adminBootstrapPlan({member_id:null,role:null,reason:null}));
  assert.throws(()=>adminBootstrapPlan({member_id:'M-'+randomUUID(),role:'reviewer',reason:'ticket'}));
  assert.throws(()=>adminBootstrapPlan({member_id:"M-'; DROP TABLE members;--",role:'admin',reason:'ticket'}));
  assert.throws(()=>campaignBootstrapPlan({actor_member_id:'M-'+randomUUID(),reason:'ticket',campaign:{}}));
});
test('release campaign uses accepted validation, active MFA actor and atomic audit',()=>isolated(async h=>{
  const id=await identity(h);await run(h,admin(id).sql);const input=campaign(id);await run(h,campaignBootstrapPlan(input).sql);
  const row=await h.db.prepare('SELECT * FROM campaigns').first();assert.equal(row.campaign_timezone,'Asia/Taipei');assert.equal(row.created_by,id);
  assert.equal(row.vote_start_date,'2000-01-01');assert.equal(await count(h,'admin_audit_logs'),2);
  await assert.rejects(run(h,campaignBootstrapPlan(input).sql));assert.equal(await count(h,'campaigns'),1);assert.equal(await count(h,'admin_audit_logs'),2);
}));
test('release campaign rejects a normal member and expired fresh MFA',()=>isolated(async h=>{
  const id=await identity(h);await assert.rejects(run(h,campaignBootstrapPlan(campaign(id)).sql));await run(h,admin(id).sql);
  await h.db.prepare('UPDATE auth_sessions SET reauthenticated_until=0').run();await assert.rejects(run(h,campaignBootstrapPlan(campaign(id)).sql));assert.equal(await count(h,'campaigns'),0);
}));
test('release reason is escaped without changing SQL semantics',()=>isolated(async h=>{
  const id=await identity(h);const why="operator's ticket";await run(h,adminBootstrapPlan({member_id:id,role:'admin',reason:why}).sql);
  assert.equal((await h.db.prepare('SELECT reason FROM admin_audit_logs').first()).reason,why);
}));
async function legacy(h) {
  const id=randomUUID(),case_id=newCaseId(),session=randomUUID(),file=randomUUID(),source=randomUUID();
  const stamp=new Date().toISOString(), query=randomBytes(32).toString('base64url');
  const key=`proofs/cases/${id}/${file}.png`,stage=`proofs/staging/2026/10/10/${session}/${source}.png`;
  // These are precisely B3 columns/SQL, after expanded migrations; no Campaign.
  await h.db.prepare('INSERT INTO completed_uploads(session_id,manifest_hash,completed_at,expires_at) VALUES(?,?,?,?)').bind(session,hex(32),stamp,'2100-01-01T00:00:00.000Z').run();
  await h.db.prepare("INSERT INTO completed_upload_files(session_id,object_key,content_type,size,etag) VALUES(?,?,'image/png',8,'local-fixture')").bind(session,stage).run();
  await h.db.prepare(`INSERT INTO cases(id,case_id,created_at,updated_at,nickname,player_id,campaign_id,vote_type,vote_date,query_key_hash,upload_session_id)
    VALUES(?,?,?,?,'local fixture','local','B3-PRODUCTION-ACCEPTANCE','Solo','2026-10-10',?,?)`).bind(id,case_id,stamp,stamp,await sha256(query),session).run();
  await h.db.prepare("INSERT INTO case_files(id,case_id,object_key,content_type,size,etag,created_at,upload_object_key) VALUES(?,?,?,'image/png',8,'local-fixture',?,?)").bind(file,id,key,stamp,stage).run();
  await h.db.prepare('UPDATE completed_uploads SET consumed_case_id=?,consumed_at=?').bind(id,stamp).run();
  return {query,input:{id,case_id,recorded_case_id:case_id,upload_session_id:session,campaign_id:'B3-PRODUCTION-ACCEPTANCE',status:'pending',member_id:null,points_awarded:0,total_cases:1,
    acceptance_release:'de6e15f25cf94c66df92d7d179bda589f2f848af',files:[{id:file,case_id:id,object_key:key,upload_object_key:stage,size:8,etag:'local-fixture',content_type:'image/png'}],upload_files:[{session_id:session,object_key:stage}]}};
}
test('release expanded schema preserves old B3 insert/query; unregistered approval fails closed',()=>isolated(async h=>{
  const {query,input}=await legacy(h);const response=await h.fetch(`/api/cases/${input.case_id}?key=${query}`);assert.equal(response.status,200);
  await assert.rejects(reviewCampaign(h.db,await h.db.prepare('SELECT * FROM cases').first()),e=>e.code==='CAMPAIGN_NOT_REVIEWABLE');
  assert.equal(await count(h,'point_transactions'),0);
}));
test('release exact acceptance cleanup clears FK cycle and only lists exact R2 keys',()=>isolated(async h=>{
  const {input}=await legacy(h),plan=legacyCleanupPlan(input);assert.deepEqual(plan.r2_keys,[input.files[0].object_key,input.upload_files[0].object_key]);
  assert.ok(input.files[0].object_key.startsWith(`proofs/cases/${input.id}/`));
  assert.throws(()=>legacyCleanupPlan({...input,files:[{...input.files[0],object_key:`proofs/cases/${input.case_id}/${input.files[0].id}.png`}]}));
  await run(h,plan.sql);for(const table of ['cases','case_files','case_idempotency','completed_uploads','completed_upload_files'])assert.equal(await count(h,table),0);
  assert.deepEqual((await h.db.prepare('PRAGMA foreign_key_check').all()).results,[]);await assert.rejects(run(h,plan.sql));
}));
test('release cleanup refuses changed row and leaves all rows intact',()=>isolated(async h=>{
  const {input}=await legacy(h),plan=legacyCleanupPlan(input);await h.db.prepare("UPDATE cases SET status='rejected'").run();
  await assert.rejects(run(h,plan.sql));assert.equal(await count(h,'cases'),1);assert.equal(await count(h,'case_files'),1);
}));
test('release cleanup rejects unproven identities, nonzero points and traversal',()=>isolated(async h=>{
  const {input}=await legacy(h);assert.throws(()=>legacyCleanupPlan({...input,recorded_case_id:newCaseId()}));
  assert.throws(()=>legacyCleanupPlan({...input,points_awarded:1}));assert.throws(()=>legacyCleanupPlan({...input,files:[{...input.files[0],object_key:'../other'}]}));
}));
test('release schema verification reports no missing objects on clean 0001-0007',()=>isolated(async h=>{
  const sql=await readFile(new URL('../docs/release/verify-expanded-schema.sql',import.meta.url),'utf8');
  // This harness applies files directly; CLI tracking is separately verified by
  // check:admin-schema with Wrangler's actual local migrations runner.
  const statements=unstable_splitSqlQuery(sql).filter(s=>!s.includes('SELECT name FROM d1_migrations'));
  const results=await h.db.batch(statements.map(s=>h.db.prepare(s)));assert.ok(results.every(r=>r.success));
  assert.ok(!results.flatMap(r=>r.results).some(r=>r.defect));assert.equal((await h.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
}));

const nodeTool=(file,args)=>spawnSync(process.execPath,[file,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
test('release plan refuses incomplete Production identity before opening inputs',()=>{
  const r=nodeTool('scripts/prepare-release-plan.mjs',['--kind','admin','--input','not-opened','--output','not-written','--target','production']);
  assert.equal(r.status,1);assert.equal(r.stderr.trim(),'RELEASE_PLAN_REFUSED');assert.equal(r.stdout,'');
});
test('release local plan rejects ambiguous Production database flags',()=>{
  const r=nodeTool('scripts/prepare-release-plan.mjs',['--kind','campaign','--input','not-opened','--output','not-written','--database','voteproof-cases']);
  assert.equal(r.status,1);assert.equal(r.stderr.trim(),'RELEASE_PLAN_REFUSED');
});
test('release cleanup plan requires explicit preparation acknowledgement',()=>{
  const r=nodeTool('scripts/prepare-release-plan.mjs',['--kind','legacy','--input','not-opened','--output','not-written']);
  assert.equal(r.status,1);assert.equal(r.stderr.trim(),'RELEASE_PLAN_REFUSED');
});
test('release migration staging refuses incomplete or ambiguous targets',()=>{
  for(const args of [['--target','production'],['--database','voteproof-cases'],['--target','production','--database','wrong','--confirm-database-id',randomUUID()]]){
    const r=nodeTool('scripts/prepare-migration-stages.mjs',args);assert.equal(r.status,1);assert.equal(r.stderr.trim(),'MIGRATION_STAGE_PREPARATION_REFUSED');assert.equal(r.stdout,'');
  }
});
const powershellTool=args=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','scripts/release-secret-preflight.ps1',...args],{encoding:'utf8',windowsHide:true,timeout:10000});
test('release Secret preflight defaults to no Cloudflare request',()=>{
  if(process.platform!=='win32')return;
  const r=powershellTool([]);assert.equal(r.status,0);assert.ok(r.stdout.includes('LOCAL_COPY_FORMAT_ONLY_NO_CLOUDFLARE_REQUEST'));
  const summary=JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));assert.equal(summary.target,'local');assert.equal(summary.metadata_pass,null);assert.equal(summary.secrets_written,false);
});
test('release Secret preflight refuses Production without explicit database/version',()=>{
  if(process.platform!=='win32')return;
  const r=powershellTool(['-Target','production']);assert.equal(r.status,1);assert.equal(r.stdout.trim(),'SECRET_PREFLIGHT_STOPPED');
});
