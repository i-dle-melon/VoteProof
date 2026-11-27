// Manually reconcile backup presence from Drive changes.
function syncDriveBackupChanges() {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(1)) return {state:'overlap_skipped'};
  try {
    var c = vpConfig_();
    var root = Drive.Files.get(c.root, {fields:'id,ownedByMe,trashed,mimeType'});
    vpCheck_(root && root.id === c.root && root.ownedByMe === true && root.trashed === false &&
      root.mimeType === VP_FOLDER_MIME, 'ROOT_INACCESSIBLE');
    var key = 'VOTEPROOF_DRIVE_CHANGES_CURSOR_' + vpHash_(c.root),
        token = c.properties.getProperty(key);
    if (!token) {
      var start = Drive.Changes.getStartPageToken().startPageToken;
      vpCheck_(typeof start === 'string' && start.length > 0, 'DRIVE_CURSOR_INVALID');
      c.properties.setProperty(key, start);
      return {state:'tracking_started'};
    }
    var page = Drive.Changes.list(token, {pageSize:40, spaces:'drive', includeRemoved:true,
      fields:'nextPageToken,newStartPageToken,changes(changeType,fileId,removed,file(id,trashed))'});
    var next = page.nextPageToken || page.newStartPageToken, changes = page.changes || [];
    vpCheck_(typeof next === 'string' && next.length > 0 && Array.isArray(changes) && changes.length <= 40,
      'DRIVE_CURSOR_INVALID');
    var latest = new Map();
    changes.forEach(function(change) {
      if (change.changeType !== 'file' || !/^[A-Za-z0-9_-]{1,200}$/.test(change.fileId || '')) return;
      var file = change.file, state;
      if (change.removed === true) state = 'unavailable';
      else if (file && file.id === change.fileId && typeof file.trashed === 'boolean')
        state = file.trashed ? 'trashed' : 'available';
      if (state) latest.set(change.fileId, {drive_file_id:change.fileId,state:state});
    });
    var files = Array.from(latest.values()), applied = 0;
    if (files.length) {
      var saved = vpJson_(c, '/api/internal/drive-backup/presence', {root_folder_id:c.root,files:files});
      vpCheck_(saved && Number.isSafeInteger(saved.applied) && saved.applied >= 0 && saved.applied <= files.length,
        'DRIVE_PRESENCE_NOT_ACCEPTED');
      applied = saved.applied;
    }
    c.properties.setProperty(key, next);
    console.log(JSON.stringify({state:'synced',applied:applied,has_more:!!page.nextPageToken}));
    return {state:'synced',applied:applied,has_more:!!page.nextPageToken};
  } finally { lock.releaseLock(); }
}
