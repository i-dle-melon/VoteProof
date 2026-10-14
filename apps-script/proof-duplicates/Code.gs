// Standalone PRIVATE project, independent of the Drive backup project/lock/nonce.
// Script Properties only: DUPLICATE_API_ORIGIN and DUPLICATE_PROCESSOR_SECRET.
// No trigger installation or production activation is included.
function runDuplicateAnalysis() {
  var lock=LockService.getScriptLock();if(!lock.tryLock(1))return {state:'overlap_skipped'};
  try {
    var properties=PropertiesService.getScriptProperties(),origin=properties.getProperty('DUPLICATE_API_ORIGIN'),secret=properties.getProperty('DUPLICATE_PROCESSOR_SECRET');
    if(!/^https:\/\/[a-zA-Z0-9.-]+$/.test(origin||'')||!/^[a-f0-9]{64}$/.test(secret||''))return {state:'not_configured'};
    var id=properties.getProperty('DUPLICATE_REQUEST_ID');
    if(!id){id=Utilities.getUuid();properties.setProperty('DUPLICATE_REQUEST_ID',id);}
    var response=UrlFetchApp.fetch(origin+'/api/internal/proof-duplicates/process',{
      method:'post',headers:{Authorization:'Bearer '+secret},contentType:'application/json',payload:JSON.stringify({request_id:id}),
      muteHttpExceptions:true,followRedirects:false,validateHttpsCertificates:true
    });
    if(response.getResponseCode()!==200)return {state:'unavailable'};
    var value=JSON.parse(response.getContentText());
    if(value.ok!==true||!value.data||['idle','pending','clear','exact_duplicate','failed','processing','lease_expired','lease_conflict'].indexOf(value.data.state)<0)return {state:'unavailable'};
    properties.deleteProperty('DUPLICATE_REQUEST_ID');
    return {state:value.data.state};
  } catch(_){return {state:'unavailable'};}
  finally{lock.releaseLock();}
}
