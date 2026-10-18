// Independent deployment; never use the verification/support relay project or secret.
var VP_STORAGE_FROM='idle.voteproof.verify@gmail.com';
function storageSign_(secret,text){return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text,secret,Utilities.Charset.UTF_8)).replace(/=+$/,'');}
function doPost(e){var r,secret,result={send_id:'',outcome:'rejected'};
 try{var p=PropertiesService.getScriptProperties();secret=p.getProperty('STORAGE_ALERT_RELAY_SECRET');if(!secret||secret.length<32||Session.getEffectiveUser().getEmail().toLowerCase()!==VP_STORAGE_FROM)throw Error();if(!e||!e.postData||typeof e.postData.contents!=='string'||e.postData.contents.length>4096)throw Error();r=JSON.parse(e.postData.contents);result.send_id=r.send_id;
 if(Object.keys(r).sort().join(',')!=='from,kind,purpose,send_id,signature,timestamp,to,version'||r.version!==1||r.purpose!=='storage_alert'||r.from!==VP_STORAGE_FROM||!['90','95','cleanup_failed','recovered'].includes(r.kind)||!Number.isSafeInteger(r.timestamp)||Math.abs(Math.floor(Date.now()/1000)-r.timestamp)>120||!(/^[a-f0-9-]{36}$/.test(r.send_id))||!(/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(r.to)))throw Error();
 var signature=storageSign_(secret,JSON.stringify(['VoteProof/storage-alert',r.version,r.purpose,r.timestamp,r.send_id,r.from,r.to,r.kind]));if(typeof r.signature!=='string'||r.signature.length!==signature.length)throw Error();var diff=0;for(var i=0;i<signature.length;i++)diff|=signature.charCodeAt(i)^r.signature.charCodeAt(i);if(diff)throw Error();
 var lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw Error();try{
 var all=p.getProperties(),cutoff=Math.floor(Date.now()/1000)-7*86400;Object.keys(all).forEach(function(key){
 if(key.indexOf('storage-send-')===0){try{if(JSON.parse(all[key]).created_at<cutoff)p.deleteProperty(key);}catch(_){}}
 if(key.indexOf('storage-hour-')===0&&Number(key.slice(13))<Math.floor(Date.now()/3600000)-48)p.deleteProperty(key);
 if(key.indexOf('storage-day-')===0&&Number(key.slice(12))<Math.floor(Date.now()/86400000)-8)p.deleteProperty(key);
 });
 var fingerprint=storageSign_(secret,JSON.stringify([r.send_id,r.from,r.to,r.kind])),prior=p.getProperty('storage-send-'+r.send_id);if(prior){var receipt=JSON.parse(prior);if(receipt.fingerprint!==fingerprint)throw Error();result.outcome=receipt.state;}
 else if(MailApp.getRemainingDailyQuota()>5){var hour=Math.floor(Date.now()/3600000),day=Math.floor(Date.now()/86400000),h=Number(p.getProperty('storage-hour-'+hour)||0),d=Number(p.getProperty('storage-day-'+day)||0);if(h>=5||d>=20)throw Error();
 p.setProperty('storage-send-'+r.send_id,JSON.stringify({state:'ambiguous',fingerprint:fingerprint,created_at:Math.floor(Date.now()/1000)}));p.setProperty('storage-hour-'+hour,String(h+1));p.setProperty('storage-day-'+day,String(d+1));result.outcome='ambiguous';
 try{MailApp.sendEmail({to:r.to,subject:'VoteProof 儲存空間通知',body:'儲存事件：'+r.kind+'。請登入 VoteProof 管理後台查看容量快照與稽核。',name:'VoteProof 管理團隊',replyTo:VP_STORAGE_FROM});p.setProperty('storage-send-'+r.send_id,JSON.stringify({state:'sent',fingerprint:fingerprint,created_at:Math.floor(Date.now()/1000)}));result.outcome='sent';}catch(_){}
 }
 }finally{lock.releaseLock();}
 }catch(_){}
 if(secret)result.signature=storageSign_(secret,JSON.stringify(['VoteProof/storage-alert-result',result.send_id,result.outcome]));return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
