// Private installable script. Set values ONLY in Script Properties, never in source.
var VP_BACKUP_MAX_BYTES = 5 * 1024 * 1024;
var VP_FOLDER_MIME = 'application/vnd.google-apps.folder';
var VP_FIELDS = 'id,name,mimeType,size,parents,trashed,appProperties';
function vpCheck_(condition, code) { if (!condition) throw new Error(code); }
function vpConfig_() {
  var p = PropertiesService.getScriptProperties(), origin = p.getProperty('VOTEPROOF_ORIGIN'), secret = p.getProperty('DRIVE_BACKUP_RELAY_SECRET'), root = p.getProperty('ROOT_FOLDER_ID');
  vpCheck_(/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?$/.test(origin || ''), 'CONFIG_MISSING');
  vpCheck_(/^[a-f0-9]{64}$/.test(secret || '') && /^[A-Za-z0-9_-]{1,200}$/.test(root || ''), 'CONFIG_MISSING');
  return { origin: origin, secret: secret, root: root, properties: p };
}
function vpRequest_(c, path, method, body, job) {
  vpCheck_(/^\/api\/internal\/drive-backup\//.test(path), 'INVALID_SOURCE');
  var headers = { Authorization: 'Bearer ' + c.secret };
  if (job) { headers['X-VoteProof-Backup-Lease'] = job.lease_token; headers['X-VoteProof-Backup-Attempt'] = String(job.attempt); }
  var options = { method: method, headers: headers, muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true };
  if (body !== undefined) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  var response;
  try { response = UrlFetchApp.fetch(c.origin + path, options); } catch (_) { throw new Error('NETWORK'); }
  if (response.getResponseCode() !== 200) {
    var code; try { code = JSON.parse(response.getContentText()).error.code; } catch (_) {}
    if (code === 'RELAY_SOURCE_CHANGED') throw new Error('SOURCE_CHANGED');
    throw new Error(['DRIVE_BACKUP_DISABLED','DRIVE_BACKUP_NOT_CONFIGURED','RELAY_LEASE_EXPIRED','RELAY_LEASE_CONFLICT','RELAY_VERIFICATION_FAILED'].indexOf(code) >= 0 ? code : 'NETWORK');
  }
  return response;
}
function vpJson_(c, path, body) { var v = JSON.parse(vpRequest_(c, path, 'post', body).getContentText()); vpCheck_(v.ok === true, 'NETWORK'); return v.data; }
function vpGetFile_(id) {
  try { return Drive.Files.get(id, { fields: VP_FIELDS }); }
  catch (e) { if (/404|not found|File not found/i.test(String(e.message))) return null; throw e; }
}
function vpHash_(key) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8).map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }
function vpFolder_(id, name, parent, key) {
  var existing = vpGetFile_(id), tag = vpHash_(key);
  if (!existing) {
    try { Drive.Files.create({id:id,name:name,mimeType:VP_FOLDER_MIME,parents:[parent],appProperties:{source:'voteproof',folder_key:tag}}, null, {fields:VP_FIELDS}); }
    catch (e) { existing = vpGetFile_(id); if (!existing) throw e; }
    existing = vpGetFile_(id);
  }
  // Display names are mutable; identity is the persisted ID, parent and key tag.
  vpCheck_(existing && existing.id === id && !existing.trashed && existing.mimeType === VP_FOLDER_MIME &&
    Array.isArray(existing.parents) && existing.parents.length === 1 && existing.parents[0] === parent &&
    existing.appProperties && existing.appProperties.source === 'voteproof' && existing.appProperties.folder_key === tag, 'VERIFY_FAILED');
  return id;
}
function vpVerify_(meta, job, ids) {
  vpCheck_(meta && meta.id === ids.drive_file_id && !meta.trashed && meta.name === job.filename && Number(meta.size) === job.size && meta.mimeType === job.mime &&
    Array.isArray(meta.parents) && meta.parents.length === 1 && meta.parents[0] === ids.drive_folder_id && meta.appProperties &&
    meta.appProperties.source === 'voteproof' && meta.appProperties.storage_source === 'r2' && meta.appProperties.voteproof_case_id === job.case_id && meta.appProperties.voteproof_proof_id === job.proof_id, 'VERIFY_FAILED');
}
function vpFailure_(e) {
  var m = String(e.message || '');
  if (/storageQuotaExceeded|storage.*quota|storage.*full|not enough storage/i.test(m)) return 'DRIVE_FULL';
  if (/quota|too many times|rate.?limit/i.test(m)) return 'RATE_LIMIT';
  if (/permission|forbidden|access denied/i.test(m)) return 'DRIVE_ACCESS_DENIED';
  return ['NETWORK','VERIFY_FAILED','SOURCE_CHANGED','ROOT_INACCESSIBLE','CONFIG_MISSING','INVALID_SOURCE'].indexOf(m) >= 0 ? m : 'INTERNAL';
}
function runBackup() {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(1)) return {state:'overlap_skipped'};
  var c, job;
  try {
    c = vpConfig_(); var nonce = c.properties.getProperty('CLAIM_REQUEST_ID');
    if (!nonce) { nonce = Utilities.getUuid(); c.properties.setProperty('CLAIM_REQUEST_ID', nonce); }
    var claim = vpJson_(c, '/api/internal/drive-backup/claim', {request_id:nonce,root_folder_id:c.root});
    if (claim.state !== 'claimed') { c.properties.deleteProperty('CLAIM_REQUEST_ID'); return {state:claim.state}; }
    job = claim.job;
    vpCheck_(/^[A-Za-z0-9_-]+\.(png|jpg|webp)$/.test(job.filename) && /^VP-/.test(job.case_id) && job.filename.indexOf(job.case_id + '.') === 0 &&
      ['image/png','image/jpeg','image/webp'].indexOf(job.mime) >= 0 && Number.isSafeInteger(job.size) && job.size > 0 && job.size <= VP_BACKUP_MAX_BYTES && job.root_folder_id === c.root, 'INVALID_SOURCE');
    var root = vpGetFile_(c.root); vpCheck_(root && !root.trashed && root.mimeType === VP_FOLDER_MIME, 'ROOT_INACCESSIBLE');
    var proposed = Drive.Files.generateIds({count:3,space:'drive',type:'files'}).ids; vpCheck_(proposed && proposed.length === 3, 'VERIFY_FAILED');
    // IDs are persisted by the Worker BEFORE any folder/file create. Lost ACK reuses them.
    var ids = vpJson_(c, '/api/internal/drive-backup/' + job.backup_id + '/identity', {lease_token:job.lease_token,attempt:job.attempt,
      drive_file_id:job.drive_file_id || proposed[0],campaign_folder_id:proposed[1],date_folder_id:proposed[2]});
    vpFolder_(ids.campaign_folder_id, job.campaign_name, c.root, job.campaign_key);
    vpFolder_(ids.date_folder_id, job.date, ids.campaign_folder_id, job.date_key);
    var meta = vpGetFile_(ids.drive_file_id);
    if (!meta) {
      var response = vpRequest_(c, '/api/internal/drive-backup/' + job.backup_id + '/content', 'get', undefined, job), headers = response.getAllHeaders();
      var typeKey = Object.keys(headers).find(function(k) { return k.toLowerCase() === 'content-type'; });
      var blob = response.getBlob(), bytes = blob.getBytes();
      vpCheck_(typeKey && String(headers[typeKey]).split(';')[0] === job.mime && bytes.length === job.size && bytes.length <= VP_BACKUP_MAX_BYTES, 'SOURCE_CHANGED');
      blob.setContentType(job.mime); blob.setName(job.filename);
      var properties = {source:'voteproof',storage_source:'r2',voteproof_case_id:job.case_id,voteproof_proof_id:job.proof_id};
      try { Drive.Files.create({id:ids.drive_file_id,name:job.filename,mimeType:job.mime,parents:[ids.drive_folder_id],appProperties:properties}, blob, {fields:VP_FIELDS}); }
      catch (e) { meta = vpGetFile_(ids.drive_file_id); if (!meta) throw e; }
      meta = vpGetFile_(ids.drive_file_id);
    }
    vpVerify_(meta, job, ids);
    var result = vpJson_(c, '/api/internal/drive-backup/' + job.backup_id + '/complete', {lease_token:job.lease_token,attempt:job.attempt,
      drive_file_id:ids.drive_file_id,drive_folder_id:ids.drive_folder_id,verification:{name:meta.name,size:Number(meta.size),mime:meta.mimeType,parents:meta.parents,appProperties:meta.appProperties}});
    c.properties.deleteProperty('CLAIM_REQUEST_ID'); console.log(JSON.stringify({state:result.state})); return {state:result.state};
  } catch (e) {
    var code = vpFailure_(e);
    if (c && job) {
      try { vpJson_(c, '/api/internal/drive-backup/' + job.backup_id + '/failed', {lease_token:job.lease_token,attempt:job.attempt,error_code:code}); c.properties.deleteProperty('CLAIM_REQUEST_ID'); }
      catch (_) { /* Preserve nonce when ACK is uncertain; next execution reconciles. */ }
    }
    console.log(JSON.stringify({state:'failed',code:code})); return {state:'failed',code:code};
  } finally { lock.releaseLock(); }
}
function installTrigger() {
  var lock=LockService.getScriptLock();vpCheck_(lock.tryLock(1000),'OVERLAP');
  try { vpConfig_(); removeTriggers(); ScriptApp.newTrigger('runBackup').timeBased().everyMinutes(5).create(); }
  finally { lock.releaseLock(); }
}
function removeTriggers() { ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'runBackup'; }).forEach(function(t) { ScriptApp.deleteTrigger(t); }); }
function createIsolatedTestRoot() {
  vpCheck_(PropertiesService.getScriptProperties().getProperty('ENVIRONMENT')==='isolated','ISOLATED_ONLY');
  vpCreatePrivateRoot_('VoteProof Backup - Apps Script Connection Test','apps_script_connection_test');
}
// Future operator-approved Production setup only; never invoked by runBackup.
function createBackupRoot() {
  vpCheck_(PropertiesService.getScriptProperties().getProperty('ENVIRONMENT')==='production','PRODUCTION_SETUP_ONLY');
  vpCreatePrivateRoot_('VoteProof Backup','apps_script_production');
}
function vpCreatePrivateRoot_(name,tag) {
  var p=PropertiesService.getScriptProperties();
  var id=p.getProperty('ROOT_FOLDER_ID');if(!id){id=Drive.Files.generateIds({count:1,space:'drive',type:'files'}).ids[0];p.setProperty('ROOT_FOLDER_ID',id);}
  var m=vpGetFile_(id);
  if(!m){Drive.Files.create({id:id,name:name,mimeType:VP_FOLDER_MIME,appProperties:{source:'voteproof',backup_root:tag}},null,{fields:VP_FIELDS});m=vpGetFile_(id);}
  vpCheck_(m && m.name===name && !m.trashed && m.mimeType===VP_FOLDER_MIME,'ROOT_INACCESSIBLE');
  var permissions=Drive.Permissions.list(id,{fields:'permissions(type,role),nextPageToken'});vpCheck_(permissions.permissions.length===1&&!permissions.nextPageToken&&permissions.permissions[0].type==='user'&&permissions.permissions[0].role==='owner','ROOT_NOT_PRIVATE');
  console.log('PRIVATE_ROOT_READY');
}
