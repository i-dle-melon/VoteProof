// Copy only into an independent, disposable Apps Script test project.
// No credentials, Production changes, image reads or Drive mutations.
function vpInventoryIsolatedGuard_() {
  var c = vpInventoryConfig_();
  vpCheck_(/^https:\/\/voteproof-inventory-test-[a-f0-9]{10}\.[a-z0-9-]+\.workers\.dev$/.test(c.origin), 'ISOLATED_TEST_REQUIRED');
}
function verifyIsolatedInventory() {
  vpInventoryIsolatedGuard_();
  var result = runStorageInventory();
  vpCheck_(result.state === 'complete' && result.quota.snapshot === 'accepted' &&
    ['known','unlimited'].indexOf(result.quota.state) >= 0, 'INVENTORY_FAILED');
  var old = VP_STORAGE_INVENTORY_MAX_PAGES;
  var partial, resumed;
  try {
    VP_STORAGE_INVENTORY_MAX_PAGES = 1;
    partial = runStorageInventory();
    vpCheck_(partial.state === 'incomplete' && partial.pages === 1, 'PAGING_NOT_EXERCISED');
  } finally { VP_STORAGE_INVENTORY_MAX_PAGES = old; }
  resumed = runStorageInventory();
  vpCheck_(resumed.state === 'complete' && resumed.pages === result.pages - 1, 'RESUME_FAILED');
  // The isolated Worker claim endpoint returns idle; no backup images are read.
  var backup = runBackup();
  vpCheck_(backup.state === 'idle', 'BACKUP_REGRESSION');
  console.log(JSON.stringify({isolated_acceptance:'PASS',pages:result.pages,
    resume_pages:resumed.pages,quota:result.quota.state,backup:backup.state}));
}
function holdIsolatedInventoryLock() {
  vpInventoryIsolatedGuard_();
  var lock = LockService.getUserLock();
  vpCheck_(lock.tryLock(1), 'TEST_LOCK_BUSY');
  try {
    console.log('ISOLATED_USER_LOCK_HELD');
    // Run runStorageInventory concurrently from a second editor/trigger.
    Utilities.sleep(45000);
  } finally { lock.releaseLock(); }
  console.log('ISOLATED_USER_LOCK_RELEASED');
}
function verifyIsolatedTriggerOverlap() {
  vpInventoryIsolatedGuard_();
  var lock = LockService.getUserLock();
  vpCheck_(lock.tryLock(1), 'TEST_LOCK_BUSY');
  var trigger;
  try {
    trigger = ScriptApp.newTrigger('runStorageInventory').timeBased().after(1000).create();
    vpCheck_(runBackup().state === 'idle', 'BACKUP_LOCK_REGRESSION');
    console.log('ISOLATED_TRIGGER_USER_LOCK_HELD');
    Utilities.sleep(90000);
  } finally {
    lock.releaseLock();
    // A completed one-shot trigger may already have been removed by Google.
    if (trigger) ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getUniqueId() === trigger.getUniqueId();
    }).forEach(function(t) { ScriptApp.deleteTrigger(t); });
  }
  console.log('ISOLATED_TRIGGER_USER_LOCK_RELEASED');
}
