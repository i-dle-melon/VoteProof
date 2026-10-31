// Quota metadata + tick-only inventory; never archive or image operations.
// Installation is a separate, operator-approved action.
// A single installer account must own this trigger. UserLock is independent of
// runBackup's ScriptLock, so listing capacity does not skip a backup execution.
var VP_STORAGE_INVENTORY_MAX_PAGES = 50;
var VP_STORAGE_INVENTORY_MAX_MS = 60000;
function vpInventoryPaused_() {
  return PropertiesService.getScriptProperties().getProperty('VOTEPROOF_INVENTORY_PAUSED') === 'true';
}

function vpInventoryConfig_() {
  var p = PropertiesService.getScriptProperties();
  var origin = p.getProperty('VOTEPROOF_ORIGIN');
  var secret = p.getProperty('DRIVE_BACKUP_RELAY_SECRET');
  vpCheck_(/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?$/.test(origin || '') &&
    /^[a-f0-9]{64}$/.test(secret || ''), 'CONFIG_MISSING');
  return { origin: origin, secret: secret };
}

function vpInventoryQuota_(c) {
  var snapshot = { id: Utilities.getUuid(), observed_at: Math.floor(Date.now() / 1000),
    state: 'unknown', total_bytes: null, used_bytes: null };
  function bytes(value) {
    if (typeof value !== 'number' &&
      (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
    var n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  try {
    // Account metadata only: no files, image bytes or Drive mutations.
    var q = Drive.About.get({fields:'storageQuota'}).storageQuota;
    if (q && q.usage !== undefined) {
      var used = bytes(q.usage), total = q.limit === undefined ? null : bytes(q.limit);
      vpCheck_(used !== null && (q.limit === undefined ||
        (total !== null && total > 0 && used <= total)), 'QUOTA_INVALID');
      snapshot.used_bytes = used;
      snapshot.total_bytes = total;
      snapshot.state = q.limit === undefined ? 'unlimited' : 'known';
    }
  } catch (_) { snapshot.state = 'error'; }
  snapshot.observed_at = Math.floor(Date.now() / 1000);
  try {
    var accepted = vpJson_(c, '/api/internal/drive-backup/storage/quota', snapshot);
    vpCheck_(accepted && accepted.accepted === true, 'QUOTA_NOT_ACCEPTED');
    return { state: snapshot.state, snapshot: 'accepted' };
  } catch (_) { return { state: snapshot.state, snapshot: 'failed' }; }
}

function vpInventoryResult_(state, pages, code, quota) {
  var result = { state: state, pages: pages };
  if (code) result.code = code;
  if (quota) result.quota = quota;
  console.log(JSON.stringify(result));
  return result;
}

function runStorageInventory() {
  // Soft pause: preserve the trigger, source, credentials and runBackup. No
  // quota, Worker or Drive request is made while paused.
  if (vpInventoryPaused_())
    return {state:'paused',pages:0};
  var lock = LockService.getUserLock();
  if (!lock.tryLock(1)) return vpInventoryResult_('overlap_skipped', 0);
  var pages = 0, started = Date.now(), quota = null;
  try {
    var c = vpInventoryConfig_();
    quota = vpInventoryQuota_(c);
    started = Date.now(); // Quota latency does not consume the R2 paging budget.
    while (pages < VP_STORAGE_INVENTORY_MAX_PAGES &&
      Date.now() - started < VP_STORAGE_INVENTORY_MAX_MS) {
      if (vpInventoryPaused_()) return {state:'paused',pages:pages};
      // Never fall back to {}: older Workers must reject this unsupported mode.
      // Cursor/pin remain authoritative in D1, including after lost responses.
      var result = vpJson_(c, '/api/internal/drive-backup/storage/tick', {inventory_only:true});
      vpCheck_(result && result.inventory_only === true && result.cleanup === null &&
        result.alerts && result.alerts.state === 'skipped_inventory_only' &&
        result.alerts.sent === 0 && result.inventory &&
        result.inventory.complete === false &&
        ['scan','finalize'].indexOf(result.inventory.phase) >= 0, 'INVENTORY_RESPONSE_INVALID');
      pages++;
      if (result.inventory.phase === 'finalize') {
        if (vpInventoryPaused_()) return {state:'paused',pages:pages};
        if (Date.now() - started >= VP_STORAGE_INVENTORY_MAX_MS) break;
        var id = result.inventory.inventory_id, version = result.inventory.inventory_version;
        vpCheck_(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '') &&
          Number.isSafeInteger(version) && version > 0, 'INVENTORY_RESPONSE_INVALID');
        // An independent HTTP invocation commits the server-owned ready scan.
        result = vpJson_(c, '/api/internal/drive-backup/storage/inventory/finalize',
          {inventory_id:id,inventory_version:version});
        vpCheck_(result && result.inventory_only === true && result.cleanup === null &&
          result.alerts && result.alerts.state === 'skipped_inventory_only' && result.alerts.sent === 0 &&
          result.inventory && result.inventory.complete === true && result.inventory.phase === 'finalize' &&
          result.inventory.inventory_id === id && result.inventory.inventory_version === version,
          'INVENTORY_RESPONSE_INVALID');
        vpCheck_(Number.isSafeInteger(result.inventory.bytes) && result.inventory.bytes >= 0 &&
          (result.inventory.anomaly === null || typeof result.inventory.anomaly === 'string'),
          'INVENTORY_RESPONSE_INVALID');
        if (result.inventory.anomaly !== null)
          return vpInventoryResult_('blocked', pages, 'STORAGE_ANOMALY', quota);
        var quotaOk = quota.snapshot === 'accepted' &&
          ['known','unlimited'].indexOf(quota.state) >= 0;
        return vpInventoryResult_(quotaOk ? 'complete' : 'partial', pages,
          quotaOk ? null : 'DRIVE_QUOTA_UNAVAILABLE', quota);
      }
    }
    // No local cursor, D1 edits or force-unblock. The next trigger resumes D1.
    return vpInventoryResult_('incomplete', pages, 'INVENTORY_BUDGET_REACHED', quota);
  } catch (e) {
    var code = ['CONFIG_MISSING','INVENTORY_RESPONSE_INVALID'].indexOf(String(e.message)) >= 0
      ? String(e.message) : vpFailure_(e);
    return vpInventoryResult_('failed', pages, code, quota);
  } finally { lock.releaseLock(); }
}

function pauseStorageInventory() {
  PropertiesService.getScriptProperties().setProperty('VOTEPROOF_INVENTORY_PAUSED','true');
  return {state:'paused'};
}
function resumeStorageInventory() {
  PropertiesService.getScriptProperties().deleteProperty('VOTEPROOF_INVENTORY_PAUSED');
  return {state:'enabled'};
}

function installStorageInventoryTrigger() {
  var lock = LockService.getUserLock();
  vpCheck_(lock.tryLock(1000), 'OVERLAP');
  try {
    vpInventoryConfig_();
    var old = ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getHandlerFunction() === 'runStorageInventory';
    });
    // Preserve an existing schedule if creating the replacement fails.
    ScriptApp.newTrigger('runStorageInventory').timeBased().everyMinutes(5).create();
    old.forEach(function(t) { ScriptApp.deleteTrigger(t); });
  } finally { lock.releaseLock(); }
}

function removeStorageInventoryTriggers() {
  var lock = LockService.getUserLock();
  vpCheck_(lock.tryLock(1000), 'OVERLAP');
  try {
    ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getHandlerFunction() === 'runStorageInventory';
    }).forEach(function(t) { ScriptApp.deleteTrigger(t); });
  } finally { lock.releaseLock(); }
}
