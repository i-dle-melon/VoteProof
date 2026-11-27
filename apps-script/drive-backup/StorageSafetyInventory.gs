// Hourly R2 safety snapshot. This entry point lists object metadata only.
function runStorageSafetyInventory() {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(1)) return {state:'overlap_skipped'};
  try {
    var config = vpInventoryConfig_(), started = Date.now();
    for (var page = 0; page < 20 && Date.now() - started < 45000; page++) {
      var result = vpJson_(config, '/api/internal/drive-backup/storage/safety-inventory', {});
      vpCheck_(result && ['scanning','complete','current'].indexOf(result.state) >= 0, 'INVENTORY_RESPONSE_INVALID');
      if (result.state !== 'scanning') {
        console.log(JSON.stringify({state:result.state,pages:page+1}));
        return {state:result.state,pages:page+1};
      }
    }
    console.log(JSON.stringify({state:'incomplete',pages:page}));
    return {state:'incomplete',pages:page};
  } catch (error) {
    console.log(JSON.stringify({state:'stopped',code:vpFailure_(error)}));
    return {state:'stopped'};
  } finally {
    lock.releaseLock();
  }
}
