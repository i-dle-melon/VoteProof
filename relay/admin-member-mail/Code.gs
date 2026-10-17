// Dedicated project/deployment ONLY. Never paste into the verification relay.
// Deploy as owner idle.voteproof.verify@gmail.com. No From accepted anywhere.
var ADMIN_SENDER = 'idle.voteproof.verify@gmail.com';
function adminMac(text, secret) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, secret, Utilities.Charset.UTF_8)).replace(/=+$/, '');
}
function adminEqual(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  var mismatch = 0; for (var i = 0; i < b.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i); return mismatch === 0;
}
function adminCanonical(b) { return JSON.stringify(['VoteProof/admin-member-mail', b.version, b.timestamp, b.send_id, b.purpose, b.recipient, b.subject, b.body]); }
function adminReply(secret, id, outcome, code) {
  var r = {version:1, send_id:id, outcome:outcome, code:code || ''};
  if (secret) r.signature = adminMac(JSON.stringify(['VoteProof/admin-member-mail-receipt', 1, id, outcome, r.code]), secret);
  return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
}
function adminValid(b) {
  if (!b || Array.isArray(b) || Object.keys(b).sort().join(',') !== 'body,purpose,recipient,send_id,signature,subject,timestamp,version' || b.version !== 1 || b.purpose !== 'admin_member_message' ||
      typeof b.send_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.send_id) || !Number.isSafeInteger(b.timestamp) ||
      typeof b.recipient !== 'string' || b.recipient.length > 254 || b.recipient !== b.recipient.trim().toLowerCase() ||
      !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(b.recipient) || b.recipient.split('@')[0].startsWith('.') || b.recipient.split('@')[0].endsWith('.') || b.recipient.indexOf('..') !== -1 ||
      typeof b.subject !== 'string' || !b.subject.trim() || Array.from(b.subject).length > 150 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(b.subject) ||
      typeof b.body !== 'string' || !b.body.trim() || Array.from(b.body).length > 10000 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(b.body) ||
      [b.subject,b.body].some(function(s){return /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(s);})) return false;
  return true;
}
function doPost(e) {
  // No request, recipient, body, URL, signature or exception logging.
  var p = PropertiesService.getScriptProperties(), secret = p.getProperty('ADMIN_MAIL_RELAY_SECRET'), b;
  if (!secret || Utilities.newBlob(secret).getBytes().length < 32 || Utilities.newBlob(secret).getBytes().length > 1024 || Session.getEffectiveUser().getEmail().toLowerCase() !== ADMIN_SENDER)
    return adminReply(null, '', 'rejected', 'NOT_CONFIGURED');
  try {
    if (!e || !e.postData || e.postData.type.split(';')[0] !== 'application/json' || Utilities.newBlob(e.postData.contents).getBytes().length > 65536) throw Error();
    b = JSON.parse(e.postData.contents);
    if (!adminValid(b) || !adminEqual(b.signature, adminMac(adminCanonical(b), secret))) throw Error();
  } catch (_) { return adminReply(null, '', 'rejected', 'INVALID_REQUEST'); }
  var now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - b.timestamp) > 300) return adminReply(secret, b.send_id, 'rejected', 'EXPIRED');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return adminReply(secret, b.send_id, 'rejected', 'BUSY');
  try {
    var fingerprint = adminMac(JSON.stringify([b.recipient, b.subject, b.body]), secret), key = 'admin-mail-' + b.send_id;
    var existing = p.getProperty(key);
    if (existing) {
      var prev = JSON.parse(existing);
      if (prev.fingerprint !== fingerprint) return adminReply(secret, b.send_id, 'rejected', 'REPLAY_CONFLICT');
      return adminReply(secret, b.send_id, prev.outcome || 'ambiguous', prev.code || 'SEND_UNCERTAIN');
    }
    var all = p.getProperties(), count = 0;
    Object.keys(all).forEach(function(k) {
      if (k.indexOf('admin-mail-') !== 0) return;
      var r = JSON.parse(all[k]);
      if (r.at >= now - 86400) count++;
      // Beyond 48h, timestamp validation already makes old signed replay invalid.
      if (r.at < now - 172800) p.deleteProperty(k);
    });
    var raw = p.getProperty('ADMIN_MAIL_SITE_LIMIT'), limit = raw === null ? 10 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10 || raw !== null && !/^\d+$/.test(raw)) return adminReply(secret, b.send_id, 'rejected', 'NOT_CONFIGURED');
    if (count >= limit) return adminReply(secret, b.send_id, 'rejected', 'RATE_LIMITED');
    // Reserve 80 remaining recipients for verification; support never consumes it.
    if (MailApp.getRemainingDailyQuota() <= 80) return adminReply(secret, b.send_id, 'rejected', 'PROVIDER_QUOTA_LOW');
    var entry = {at:now, fingerprint:fingerprint, outcome:'ambiguous', code:'SEND_UNCERTAIN'};
    // Durable reservation BEFORE sending. Never retry on a MailApp exception/crash.
    p.setProperty(key, JSON.stringify(entry));
    try { MailApp.sendEmail({to:b.recipient, subject:b.subject, body:b.body, name:'VoteProof'}); entry.outcome='sent'; entry.code=''; }
    catch (_) { /* Ambiguous. Intentionally retain reservation. */ }
    p.setProperty(key, JSON.stringify(entry));
    return adminReply(secret, b.send_id, entry.outcome, entry.code);
  } catch (_) { return adminReply(secret, b.send_id, 'ambiguous', 'SEND_UNCERTAIN'); }
  finally { lock.releaseLock(); }
}
