import { CaseError } from '../api/case-validation.js';
import { adminIdentity, adminCsrf, actorBindings, ELEVATED_AUTH_GUARD } from './admin-identity.js';
import { RESET_V1_SQL_SHA256 } from './prelaunch-reset-schema.js';
import {currentProofKey} from './proof-generation.js';
import {isMaintenanceInventory,maintenanceInventory} from './inventory-maintenance-permit.js';
import {storageAdmissionStatements,emptyStorageAdmission} from './storage-admission.js';
import {isReadOnlySQL as readSQL} from './read-only-sql.js';
const rawStatement=Symbol('reset-original-statement');
const now=()=>new Date().toISOString();
export const resetEnabled=env=>env.PRELAUNCH_RESET_FENCE_ENABLED==='true';
const denied=(code='PRELAUNCH_MAINTENANCE',status=503)=>new CaseError(status,code,'操作暫停或已過期，請重新載入後確認狀態。');
const control=db=>db.prepare('SELECT c.epoch,c.mode,c.version,c.run_id FROM prelaunch_reset_control c JOIN prelaunch_reset_schema_versions v ON v.version=1 AND v.sql_sha256=? WHERE c.id=1').bind(RESET_V1_SQL_SHA256).first();

export async function resetControlRoute(request,env,url){
 if(!resetEnabled(env)||!/^\/api\/admin\/prelaunch-reset(?:\/(pause|resume))?$/.test(url.pathname))return null;
 const actor=await adminIdentity(request,env,['super_admin']);
 if(request.method==='GET'&&url.pathname==='/api/admin/prelaunch-reset'){
  const counts=(await env.DB.prepare("SELECT state,COUNT(*) n FROM prelaunch_reset_operations WHERE state IN('active','unknown') GROUP BY state").all()).results;
  return Response.json({ok:true,data:{...await control(env.DB),active:counts.find(x=>x.state==='active')?.n??0,unknown:counts.find(x=>x.state==='unknown')?.n??0}},{headers:{'Cache-Control':'no-store'}});
 }
 if(request.method!=='POST')throw denied('METHOD_NOT_ALLOWED',405);
 const c=await control(env.DB);await adminCsrf(request,{...env,PRELAUNCH_RESET_CONTEXT:{epoch:c.epoch}},actor);
 const text=await request.text();if(text.length>1024)throw denied('INVALID_RESET_CONTROL',400);
 let input;try{input=JSON.parse(text);}catch{throw denied('INVALID_RESET_CONTROL',400);}
 if(!input||Object.keys(input).sort().join(',')!=='epoch,version'||![input.epoch,input.version].every(Number.isSafeInteger))throw denied('INVALID_RESET_CONTROL',400);
 const resume=url.pathname.endsWith('/resume'),run=resume?null:crypto.randomUUID();
 const sql=`UPDATE prelaunch_reset_control SET mode=?,version=version+1,run_id=? WHERE id=1 AND epoch=? AND version=? AND ${ELEVATED_AUTH_GUARD}
 ${resume?"AND mode='maintenance' AND NOT EXISTS(SELECT 1 FROM prelaunch_reset_operations WHERE state IN('active','unknown'))":"AND mode='open'"}`;
 const id=crypto.randomUUID(),result=await env.DB.batch([
  env.DB.prepare(sql).bind(resume?'open':'maintenance',run,input.epoch,input.version,...actorBindings(actor)),
  env.DB.prepare('INSERT INTO prelaunch_reset_audit(id,created_at,action,detail) SELECT ?,?,?,? WHERE changes()=1').bind(id,now(),resume?'resume':'pause',JSON.stringify({actor:actor.member.member_id,epoch:input.epoch,previousVersion:input.version,run}))
 ]);
 if(result[0].meta.changes!==1)throw denied('RESET_CONTROL_CONFLICT',409);
 return Response.json({ok:true,data:await control(env.DB)},{headers:{'Cache-Control':'no-store'}});
}

export async function fencedRequest(env,request,handler){
 if(!resetEnabled(env))return handler(env);
 const db=env.DB,initial=await control(db);if(!initial)throw denied('RESET_SCHEMA_REQUIRED');
 const url=new URL(request.url);
 const uploadDiagnostic=request.method==='PUT'&&url.pathname.startsWith('/api/uploads/put/')?{stage:'reset_fence',putState:'not_started'}:null;
 if(initial.epoch>0&&url.pathname.startsWith('/api/internal/')&&request.headers.get('X-VoteProof-Reset-Epoch')!==String(initial.epoch))throw denied('PRELAUNCH_RELAY_EPOCH_REQUIRED',403);
 const mutation=!['GET','HEAD','OPTIONS'].includes(request.method)||/^\/api\/auth\/google\/(callback|result)/.test(url.pathname);
 if(initial.mode!=='open'&&mutation){
  if(initial.mode==='maintenance'&&isMaintenanceInventory(request,url))return maintenanceInventory(request,env,initial);
  throw denied();
 }
 let operation=null,admissionPromise=null,ioPending=0,ioWrites=0,writeBatches=0,uncertain=false,unknownPromise=null;
 const assertOpen=async()=>{const c=await control(db);if(c?.mode!=='open'||c.epoch!==initial.epoch)throw denied('PRELAUNCH_EPOCH_CHANGED',409);};
 async function ensureOperation(){
  if(operation)return;
  if(!admissionPromise)admissionPromise=(async()=>{const id=crypto.randomUUID();
   const result=await db.prepare("INSERT INTO prelaunch_reset_operations(id,epoch,state,started_at) SELECT ?,epoch,'active',? FROM prelaunch_reset_control WHERE id=1 AND epoch=? AND mode='open'").bind(id,now(),initial.epoch).run();
   if(result.meta.changes!==1)throw denied('PRELAUNCH_EPOCH_CHANGED',409);operation=id;})();
  return admissionPromise;
 }
 async function unknown(){
  uncertain=true;
  // Persist at most once per request, including a lost ACK. A later error must
  // not retry an ambiguous write; durable active/pending evidence still holds.
  if(operation&&!unknownPromise)unknownPromise=Promise.resolve().then(()=>db.prepare("UPDATE prelaunch_reset_operations SET state='unknown' WHERE id=?").bind(operation).run()).catch(()=>{});
  if(unknownPromise)await unknownPromise;
 }
 async function writeBatch(statements,admission=null){
  await ensureOperation();
  try{
   const results=await db.batch([
    db.prepare("INSERT INTO prelaunch_reset_permit(id,epoch,operation_id,purpose,scope_json) SELECT 1,epoch,?,'normal','{}' FROM prelaunch_reset_control WHERE id=1 AND epoch=? AND mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations WHERE id=? AND state='active')").bind(operation,initial.epoch,operation),
    ...statements,db.prepare('DELETE FROM prelaunch_reset_permit WHERE id=1 AND operation_id=?').bind(operation)
   ]);
   if(results[0].meta.changes!==1)throw denied('PRELAUNCH_EPOCH_CHANGED',409);
   const rows=results.slice(1,-1);
   // Only this server-built conditional admission can acknowledge no business
   // write. Other failures/zero-change statements keep the original policy.
   if(!admission||!emptyStorageAdmission(rows,admission.claim))writeBatches++;
   return rows;
  }catch(error){await unknown();throw error;}
 }
 const wrappedDB={prepare(sql){
  const create=(raw)=>({[rawStatement]:raw,bind(...values){return create(raw.bind(...values));},
   async all(){return readSQL(sql)?raw.all():(await writeBatch([raw]))[0];},
   async first(column){if(readSQL(sql))return raw.first(column);const r=(await writeBatch([raw]))[0].results?.[0]??null;return column?r?.[column]??null:r;},
   async run(){return readSQL(sql)?raw.run():(await writeBatch([raw]))[0];},sql});
  return create(db.prepare(sql));
 },async batch(statements){
  if(statements.some(x=>!x[rawStatement]))throw denied('RESET_STATEMENT_SCOPE',500);
  const raw=statements.map(x=>x[rawStatement]);
  return statements.every(x=>readSQL(x.sql))?db.batch(raw):writeBatch(raw);
 }};
 const wrappedBucket=env.PROOFS_BUCKET?new Proxy(env.PROOFS_BUCKET,{get(target,property){
  const value=Reflect.get(target,property);if(typeof value!=='function')return value;
  if(!['put','delete','get','head','list'].includes(property))return value.bind(target);
  return async(...args)=>{
   const previousStage=uploadDiagnostic?.stage;
   if(uploadDiagnostic&&property==='put'){uploadDiagnostic.stage='r2_fence';uploadDiagnostic.putState='not_started';}
   if(uploadDiagnostic&&property==='head')uploadDiagnostic.stage='r2_head_fence';
   await assertOpen();
   if(property!=='list')for(const key of Array.isArray(args[0])?args[0]:[args[0]]){
    if(typeof key==='string'&&key.startsWith('proofs/')&&(property==='put'||initial.epoch>0)&&!currentProofKey({PRELAUNCH_RESET_FENCE_ENABLED:'true',PRELAUNCH_RESET_CONTEXT:{epoch:initial.epoch}},key))throw denied('PRELAUNCH_PROOF_GENERATION_RETIRED',410);
    if(await db.prepare('SELECT object_key FROM prelaunch_reset_retired_keys WHERE object_key=?').bind(key).first())throw denied('PRELAUNCH_PROOF_RETIRED',410);
   }
   if(!['put','delete'].includes(property)){
    if(uploadDiagnostic&&property==='head')uploadDiagnostic.stage='r2_head';
    const result=await value.apply(target,args);
    if(uploadDiagnostic&&property==='head')uploadDiagnostic.stage='r2_head_fence';
    try{await assertOpen();}catch(error){try{await result?.body?.cancel();}catch{}throw error;}
    if(uploadDiagnostic&&property==='head')uploadDiagnostic.stage=previousStage;return result;
   }
   await ensureOperation();
   if(uploadDiagnostic&&property==='put')uploadDiagnostic.stage='r2_dispatch';
   const started=await db.prepare("UPDATE prelaunch_reset_operations SET pending_r2=pending_r2+1,r2_writes=r2_writes+1 WHERE id=? AND state='active' AND epoch=? AND EXISTS(SELECT 1 FROM prelaunch_reset_control WHERE id=1 AND epoch=? AND mode='open')").bind(operation,initial.epoch,initial.epoch).run();
   if(started.meta.changes!==1)throw denied('PRELAUNCH_EPOCH_CHANGED',409);
   ioPending++;ioWrites++;
   try{
    if(uploadDiagnostic&&property==='put'){uploadDiagnostic.stage='r2_put';uploadDiagnostic.putState='unknown';}
    const result=await value.apply(target,args);
    if(uploadDiagnostic&&property==='put'){uploadDiagnostic.stage='r2_receipt';uploadDiagnostic.putState='acknowledged';}
    const receipt=await db.prepare('UPDATE prelaunch_reset_operations SET pending_r2=pending_r2-1 WHERE id=? AND pending_r2>0').bind(operation).run();
    if(receipt.meta.changes!==1)throw denied('RESET_R2_RECEIPT_UNKNOWN');
    ioPending--;return result;
   }catch(error){await unknown();throw error;}
  };
 } }):undefined;
 const admitStorage=input=>writeBatch(storageAdmissionStatements(db,input),input);
 const scoped={...env,DB:wrappedDB,...(wrappedBucket?{PROOFS_BUCKET:wrappedBucket}:{}),PRELAUNCH_RESET_CONTEXT:Object.freeze({epoch:initial.epoch,assertOpen,admitStorage,...(uploadDiagnostic?{uploadDiagnostic}:{})})};
 let response;
 try{response=await handler(scoped);if((ioWrites||writeBatches)&&response.status>=500)await unknown();const end=await control(db);if(end?.epoch!==initial.epoch){try{await response.body?.cancel();}catch{}throw denied('PRELAUNCH_EPOCH_CHANGED',409);}return response;}
 catch(error){if(ioWrites||writeBatches)await unknown();throw error;}
 finally{
  if(operation&&!uncertain&&!ioPending)try{await db.prepare("UPDATE prelaunch_reset_operations SET state='completed',ended_at=? WHERE id=? AND state='active' AND pending_r2=0").bind(now(),operation).run();}catch{/* active is retained; never claim drained after a lost receipt. */}
 }
}

export function resetSessionStatement(env,session,keys,kind,{ifMissing=false}={}){
 if(!resetEnabled(env))return null;
 const context=env.PRELAUNCH_RESET_CONTEXT;if(!context)throw denied('RESET_CONTEXT_REQUIRED');
 if(keys.some(key=>!currentProofKey(env,key)))throw denied('PRELAUNCH_UPLOAD_RETIRED',409);
 const sql=ifMissing?'INSERT INTO prelaunch_reset_issuance(session_id,epoch,kind,keys_json,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM prelaunch_reset_issuance WHERE session_id=?)'
  :'INSERT INTO prelaunch_reset_issuance(session_id,epoch,kind,keys_json,created_at) VALUES(?,?,?,?,?)';
 return env.DB.prepare(sql).bind(session,context.epoch,kind,JSON.stringify([...keys].sort()),now(),...(ifMissing?[session]:[]));
}
export async function issueResetSession(env,session,keys,kind){
 const statement=resetSessionStatement(env,session,keys,kind);
 if(statement)await statement.run();
}
export async function requireResetSession(env,session,keys,{singlePut=false}={}){
 if(!resetEnabled(env))return;
 const context=env.PRELAUNCH_RESET_CONTEXT;if(!context)throw denied('RESET_CONTEXT_REQUIRED');
 if(keys.some(key=>!currentProofKey(env,key)))throw denied('PRELAUNCH_UPLOAD_RETIRED',409);
 const row=await env.DB.prepare('SELECT epoch,keys_json FROM prelaunch_reset_issuance WHERE session_id=?').bind(session).first();
 const issued=row?JSON.parse(row.keys_json):[];
 if(!row||row.epoch!==context.epoch||(singlePut?keys.length!==1||!issued.includes(keys[0]):row.keys_json!==JSON.stringify([...keys].sort())))throw denied('PRELAUNCH_UPLOAD_RETIRED',409);
 await context.assertOpen();
}
