// Isolated-only archive controller. No automatic install, inventory or mail.
// Code.gs owns authenticated vpConfig_ / vpJson_. Worker owns all delete guards.
var VP_ARCHIVE_CANARY_PATH = '/api/internal/drive-backup/storage/archive';
var VP_ARCHIVE_CANARY_TRIGGER = 'runStorageArchiveCanary';
var VP_ARCHIVE_CANARY_JOURNAL = 'STORAGE_ARCHIVE_CANARY_JOURNAL';
var VP_ARCHIVE_CANARY_INSTALL = 'STORAGE_ARCHIVE_CANARY_INSTALL_PENDING';

function vpArchiveCanaryIsolated_() {
  var p=PropertiesService.getScriptProperties(),origin=p.getProperty('VOTEPROOF_ORIGIN')||'';
  // Positive allowlist plus an independently pinned origin, not a one-URL denylist.
  return p.getProperty('ENVIRONMENT')==='isolated' &&
    p.getProperty('STORAGE_ARCHIVE_CANARY_ORIGIN')===origin &&
    /^https:\/\/voteproof-archive-canary-test-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(origin);
}
function vpArchiveCanaryAllowed_() {
  return vpArchiveCanaryIsolated_()&&PropertiesService.getScriptProperties().getProperty('STORAGE_ARCHIVE_CANARY_ENABLED')==='true';
}
function vpArchiveCanaryOwner_() {
  var configured=PropertiesService.getScriptProperties().getProperty('STORAGE_ARCHIVE_CANARY_TRIGGER_OWNER');
  var current=Session.getEffectiveUser().getEmail();
  if(!configured||!current||configured.toLowerCase()!==current.toLowerCase())throw new Error('CANARY_OWNER_REQUIRED');
}
function vpArchiveCanaryReply_(data) {
  var r=data&&data.cleanup;
  if(!r||!['idle','target_reached','no_eligible_proofs','dry_run','verification_ready',
      'delete_pending','cold','cold_reconciled','delete_ambiguous','blocked','busy','unavailable'].includes(r.state)||
    !Number.isSafeInteger(r.deleted)||r.deleted<0||r.deleted>1||r.retention_days!==7||
    !['dry-run','live'].includes(r.mode)||
    (r.deleted===1&&(r.state!=='cold'||r.mode!=='live'))||
    (['cold','cold_reconciled'].includes(r.state)&&r.mode!=='live'))throw new Error('ARCHIVE_RESPONSE_INVALID');
  return r;
}
function vpArchiveCanarySave_(p,journal) {
  p.setProperty(VP_ARCHIVE_CANARY_JOURNAL,JSON.stringify(journal));
}
// At most TWO separate HTTP invocations. A is always non-destructive; B consumes
// precisely A's durable claim. Any uncertainty is a durable operator hold, not
// an instruction for the next trigger to try another candidate.
function runStorageArchiveCanary() {
  if(!vpArchiveCanaryAllowed_())return {state:'disabled',deleted:0,requests:0};
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(1))return {state:'overlap_skipped',deleted:0,requests:0};
  var requests=0,p=PropertiesService.getScriptProperties(),journal=null;
  try {
    if(p.getProperty(VP_ARCHIVE_CANARY_JOURNAL))return {state:'operator_hold',deleted:null,requests:0};
    var c=vpConfig_();
    if(!vpArchiveCanaryAllowed_()||c.origin!==p.getProperty('STORAGE_ARCHIVE_CANARY_ORIGIN'))throw new Error('CONFIG_MISSING');
    journal={version:1,run_id:Utilities.getUuid(),origin:c.origin,phase:'verify_in_flight',started_at:Date.now()};
    // Persist BEFORE a network call; a future crash keeps this durable hold.
    vpArchiveCanarySave_(p,journal);
    requests=1;
    var first=vpArchiveCanaryReply_(vpJson_(c,VP_ARCHIVE_CANARY_PATH,{canary:true}));
    if(first.state!=='verification_ready') {
      if(first.deleted!==0||['cold','cold_reconciled','delete_ambiguous'].includes(first.state))throw new Error('ARCHIVE_PHASE_INVALID');
      if(['idle','target_reached','no_eligible_proofs','dry_run'].includes(first.state))p.deleteProperty(VP_ARCHIVE_CANARY_JOURNAL);
      else {journal.phase='operator_hold';journal.outcome=first.state;vpArchiveCanarySave_(p,journal);}
      return {state:first.state,deleted:first.deleted,requests:requests,mode:first.mode};
    }
    var uuidSource='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',uuid=new RegExp('^'+uuidSource+'$');
    var handoffShape=new RegExp('^'+uuidSource+'\\.'+uuidSource+'$');
    if(first.mode!=='live'||first.deleted!==0||first.phase!=='verify'||typeof first.handoff!=='string'||typeof first.file_id!=='string'||!handoffShape.test(first.handoff)||!uuid.test(first.file_id)||first.handoff.split('.')[0]!==first.file_id)throw new Error('ARCHIVE_PHASE_INVALID');
    if(!vpArchiveCanaryAllowed_())throw new Error('CONFIG_MISSING');
    journal.phase='delete_in_flight';journal.file_id=first.file_id;
    vpArchiveCanarySave_(p,journal);
    requests=2;
    var second=vpArchiveCanaryReply_(vpJson_(c,VP_ARCHIVE_CANARY_PATH,{canary:true,handoff:first.handoff}));
    if(!['cold','cold_reconciled','delete_pending','delete_ambiguous','blocked','unavailable','busy','no_eligible_proofs'].includes(second.state))throw new Error('ARCHIVE_PHASE_INVALID');
    if(['cold','cold_reconciled'].includes(second.state)){
      if(second.phase!=='delete'||second.file_id!==first.file_id||second.deleted!==(second.state==='cold'?1:0))throw new Error('ARCHIVE_PHASE_INVALID');
      p.deleteProperty(VP_ARCHIVE_CANARY_JOURNAL);
    }else {journal.phase='operator_hold';journal.outcome=second.state;vpArchiveCanarySave_(p,journal);}
    return {state:second.state,deleted:second.state==='delete_ambiguous'?null:second.deleted,requests:requests,mode:second.mode};
  }catch(e){
    var code=e&&['ARCHIVE_RESPONSE_INVALID','ARCHIVE_PHASE_INVALID','CONFIG_MISSING'].includes(String(e.message))?String(e.message):'ARCHIVE_UNCONFIRMED';
    // Never clear the pre-call journal after a persistence/network failure.
    if(journal)try{journal.phase='operator_hold';journal.outcome=code;vpArchiveCanarySave_(p,journal);}catch(_){}
    return {state:'unconfirmed',code:code,deleted:null,requests:requests};
  }finally{lock.releaseLock();}
}
function installStorageArchiveCanaryTrigger() {
  if(!vpArchiveCanaryAllowed_())throw new Error('ISOLATED_CANARY_ONLY');
  vpArchiveCanaryOwner_();
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))throw new Error('OVERLAP');
  var p=PropertiesService.getScriptProperties();
  try {
    vpConfig_();
    if(p.getProperty(VP_ARCHIVE_CANARY_JOURNAL)||p.getProperty(VP_ARCHIVE_CANARY_INSTALL))throw new Error('CANARY_OPERATOR_HOLD');
    var triggers=ScriptApp.getProjectTriggers();
    if(triggers.some(function(t){return t.getHandlerFunction()==='runStorageMaintenance';}))throw new Error('LEGACY_MAINTENANCE_TRIGGER_CONFLICT');
    var existing=triggers.filter(function(t){return t.getHandlerFunction()===VP_ARCHIVE_CANARY_TRIGGER;});
    if(existing.length>1)throw new Error('DUPLICATE_CANARY_TRIGGERS');
    if(existing.length===1)return {state:'already_installed'};
    p.setProperty(VP_ARCHIVE_CANARY_INSTALL,'pending');
    ScriptApp.newTrigger(VP_ARCHIVE_CANARY_TRIGGER).timeBased().everyMinutes(5).create();
    p.deleteProperty(VP_ARCHIVE_CANARY_INSTALL);
    return {state:'installed'};
  }finally{lock.releaseLock();}
}
function removeStorageArchiveCanaryTriggers() {
  // Safe removal remains possible AFTER the run flag has been switched OFF.
  if(!vpArchiveCanaryIsolated_())throw new Error('ISOLATED_CANARY_ONLY');
  vpArchiveCanaryOwner_();
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))throw new Error('OVERLAP');
  try {ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()===VP_ARCHIVE_CANARY_TRIGGER;}).forEach(function(t){ScriptApp.deleteTrigger(t);});}
  finally{lock.releaseLock();}
}
