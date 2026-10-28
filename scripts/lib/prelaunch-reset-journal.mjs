import fs from 'node:fs';import p from 'node:path';import {digest,stable} from './prelaunch-reset-snapshot.mjs';import {assertPlan} from './prelaunch-reset-objects.mjs';
export class LocalResetJournal {
 constructor(file,plan){
  assertPlan(plan);this.file=p.resolve(file);this.lock=this.file+'.lock';this.plan=plan;
  if(!fs.existsSync(this.file))this.save({planHash:plan.hash,runId:plan.runId,events:[]});
  this.load();
 }
 load(){const state=JSON.parse(fs.readFileSync(this.file,'utf8'));if(state.planHash!==this.plan.hash||state.runId!==this.plan.runId)throw Error('OTHER_MANIFEST');
  let previous='0'.repeat(64),n=0;const states=new Map(),allowed=new Set(this.plan.targets.map(digest));
  for(const event of state.events){const {hash,...body}=event;
   const prior=states.get(body.itemHash)??'PLANNED';
   if(body.n!==++n||!allowed.has(body.itemHash)||!legalTransition(prior,body.state)||body.previous!==previous||hash!==digest(body))throw Error('JOURNAL_TAMPERED');
   states.set(body.itemHash,body.state);previous=hash;
  }return state;}
 save(state){const temp=this.file+'.new';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,this.file);}
 state(item){return this.load().events.filter(e=>e.itemHash===digest(item)).at(-1)?.state??'PLANNED';}
 append(item,state,evidence){if(!this.plan.targets.some(i=>stable(i)===stable(item))||!legalTransition(this.state(item),state))throw Error('INVALID_JOURNAL_TRANSITION');const all=this.load(),body={n:all.events.length+1,itemHash:digest(item),state,evidence,previous:all.events.at(-1)?.hash??'0'.repeat(64)};all.events.push({...body,hash:digest(body)});this.save(all);}
 exclusive(fn){let fd;try{fd=fs.openSync(this.lock,'wx',0o600);}catch{throw Error('RESET_RUN_LOCKED_NO_TTL_UNLOCK');}
  try{const n=this.load().events.length;const value=fn();if(this.load().events.length<n)throw Error('JOURNAL_ROLLBACK');return value;}finally{fs.closeSync(fd);fs.unlinkSync(this.lock);}}
}
const legalTransition=(from,to)=>from==='PLANNED'?to==='DISPATCHED':from==='DISPATCHED'?['UNKNOWN','COMPLETED'].includes(to):from==='UNKNOWN'&&to==='COMPLETED';
export function executeLocalDeletes(plan,journal,stores,vault,{guard,afterItem=()=>{},fault}={}){
 assertPlan(plan);if(typeof guard!=='function')throw Error('RESET_GUARD_REQUIRED');
 if(journal.plan.hash!==plan.hash)throw Error('OTHER_MANIFEST');
 return journal.exclusive(()=>{
  guard();for(const item of plan.targets)if(['DISPATCHED','UNKNOWN'].includes(journal.state(item)))throw Error('UNKNOWN_ACK_HOLD');
  for(const [kind,store]of Object.entries(stores)){
   const allowed=new Set([...plan.targets,...plan.preserve].filter(i=>i.store===kind).map(i=>i.object.id));
   if(store.list().some(i=>!allowed.has(i.id)))throw Error('CATALOG_CHANGED');
  }
  for(const item of plan.targets){
   guard();stores[item.store].assertFrozen(plan.runId);
   if(journal.state(item)==='COMPLETED'){if(stores[item.store].head(item.object.id))throw Error('COMPLETED_OBJECT_REAPPEARED');continue;}
   const saved=vault.head(digest(item));if(!saved||saved.sha256!==item.object.sha256||saved.size!==item.object.size||stable(saved.meta.original)!==stable(item))throw Error('RECOVERY_REQUIRED_BEFORE_DELETE');
   if(stable(stores[item.store].head(item.object.id))!==stable(item.object))throw Error('OBJECT_VERSION_CHANGED');
   journal.append(item,'DISPATCHED',{expected:digest(item.object)});
   try{stores[item.store].removeForReset(item.object,plan.runId,fault?.(item));if(stores[item.store].head(item.object.id))throw Error('DELETE_NOT_CONFIRMED');}
   catch{journal.append(item,'UNKNOWN',{reason:'delete_or_ack_unknown'});throw Error('UNKNOWN_ACK_HOLD');}
   journal.append(item,'COMPLETED',{observed:'absent'});afterItem(item);
  }
  guard();for(const item of plan.preserve)if(stable(stores[item.store].head(item.object.id))!==stable(item.object))throw Error('PRESERVED_OBJECT_CHANGED');
  for(const [kind,store]of Object.entries(stores)){
   const expected=plan.preserve.filter(i=>i.store===kind).map(i=>i.object);
   if(stable(store.list())!==stable(expected))throw Error('FINAL_CATALOG_MISMATCH');
  }
  return{deleted:plan.targets.length,state:'OBJECTS_COMPLETE_GATE_STILL_OFF'};
 });
}
export function reconcileLocalAbsent(plan,journal,item,stores,{invocationFinished,evidenceHash,guard}={}){
 assertPlan(plan);if(invocationFinished!==true||!/^[a-f0-9]{64}$/.test(evidenceHash??'')||typeof guard!=='function')throw Error('OPERATOR_RECONCILE_EVIDENCE_REQUIRED');
 if(!plan.targets.some(x=>stable(x)===stable(item)))throw Error('ITEM_NOT_IN_MANIFEST');
 return journal.exclusive(()=>{guard();stores[item.store].assertFrozen(plan.runId);if(!['UNKNOWN','DISPATCHED'].includes(journal.state(item)))throw Error('NO_AMBIGUOUS_ATTEMPT');
  if(stores[item.store].head(item.object.id))return{state:'HOLD_OBJECT_PRESENT',deleted:0};
  journal.append(item,'COMPLETED',{observed:'absent',operator_evidence_hash:evidenceHash,invocation_finished:true});return{state:'RECONCILED_ABSENT',deleted:0};
 });
}
