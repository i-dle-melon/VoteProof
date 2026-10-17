import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {fakeAdminRelay} from './helpers/admin-mail-relay.mjs';
import {adminMailConfig,signedAdminMail,mailCanonical,adminMailSignature,deliverAdminMail} from '../src/lib/admin-mail-relay.js';
const url='https://script.google.com'+'/macros/s/SYNTHETIC_ADMIN_CONTACT/exec';
test('dedicated relay config rejects verification reuse, non-HTTPS, foreign URL and credential reuse',()=>{
 const secret=randomBytes(32).toString('hex'),env={ADMIN_MAIL_RELAY_URL:url,ADMIN_MAIL_RELAY_SECRET:secret};assert.equal(adminMailConfig(env).url,url);
 for(const change of [{ADMIN_MAIL_RELAY_URL:'http://script.google.com/macros/s/x/exec'},{ADMIN_MAIL_RELAY_URL:url+'?token=x'},{ADMIN_MAIL_RELAY_URL:url+'#x'},{ADMIN_MAIL_RELAY_URL:'https://evil.invalid/exec'},{ADMIN_MAIL_RELAY_URL:url.replace('/exec','/dev')},{ADMIN_MAIL_RELAY_SECRET:'short'},{MAIL_RELAY_URL:url},{MAIL_RELAY_SECRET:secret},{AUTH_SECRET:secret}])assert.throws(()=>adminMailConfig({...env,...change}),{code:'ADMIN_MAIL_NOT_CONFIGURED'});
});
test('actual Apps Script template accepts Worker canonical HMAC and returns authenticated fixed-sender receipt',async()=>{
 const relay=fakeAdminRelay(),payload=await signedAdminMail(relay.secret,randomUUID(),' member@example.invalid ','主旨','一\n二');assert.equal(payload.signature,createHmac('sha256',relay.secret).update(mailCanonical(payload)).digest('base64url'));
 const receipt=relay.request(payload);assert.equal(receipt.outcome,'sent');assert.equal(relay.sent.length,1);assert.deepEqual(Object.keys(relay.sent[0]).sort(),['body','name','subject','to']);assert.equal(relay.sent[0].to,'member@example.invalid');
 const upstream=mock.method(globalThis,'fetch',relay.fetch.bind(relay));try{assert.equal((await deliverAdminMail({url,secret:relay.secret},payload.send_id,payload.recipient,payload.subject,payload.body)).outcome,'sent');assert.equal(relay.sent.length,1);}finally{upstream.mock.restore();}
});
test('script durable replay, payload conflict, expired timestamp, bad signature and disallowed fields cannot deliver twice',async()=>{
 const relay=fakeAdminRelay(),p=await signedAdminMail(relay.secret,randomUUID(),'member@example.invalid','subject','body');assert.equal(relay.request(p).outcome,'sent');assert.equal(relay.request(p).outcome,'sent');assert.equal(relay.sent.length,1);
 const sign=async b=>({...b,signature:await adminMailSignature(relay.secret,mailCanonical(b))});
 assert.equal(relay.request(await sign({...p,body:'changed'})).code,'REPLAY_CONFLICT');assert.equal(relay.request(await sign({...p,send_id:randomUUID(),timestamp:p.timestamp-301})).code,'EXPIRED');
 for(const b of [{...p,send_id:randomUUID(),signature:'x'.repeat(43)},{...p,from:'attacker@example.invalid'},{...p,html:'<b>x</b>'},{...p,to:'attacker@example.invalid'},{...p,subject:'x\r\nBcc: attacker@example.invalid'},{...p,body:'x\u0000'}])assert.notEqual(relay.request(b).outcome,'sent');assert.equal(relay.sent.length,1);
});
test('script checks effective sender, provider reserve, site quota, lock and uncertain provider exception without retry',async()=>{
 const relay=fakeAdminRelay(),make=()=>signedAdminMail(relay.secret,randomUUID(),'member@example.invalid','subject','body');
 relay.setOwner('wrong@example.invalid');assert.equal(relay.request(await make()).code,'NOT_CONFIGURED');relay.setOwner('idle.voteproof.verify@gmail.com');
 relay.setQuota(80);assert.equal(relay.request(await make()).code,'PROVIDER_QUOTA_LOW');assert.equal(relay.sent.length,0);relay.setQuota(100);
 relay.setLocked(true);assert.equal(relay.request(await make()).code,'BUSY');relay.setLocked(false);
 relay.setFailure(true);const failed=await make();assert.equal(relay.request(failed).outcome,'ambiguous');assert.equal(relay.request(failed).outcome,'ambiguous');assert.equal(relay.sent.length,1);relay.setFailure(false);
 relay.properties.ADMIN_MAIL_SITE_LIMIT='1';assert.equal(relay.request(await make()).code,'RATE_LIMITED');relay.properties.ADMIN_MAIL_SITE_LIMIT='11';assert.equal(relay.request(await make()).code,'NOT_CONFIGURED');assert.equal(relay.sent.length,1);
});
test('Worker follows Google receipt redirect only as GET without POST, refuses foreign/307/308 and untrusted receipts',async()=>{
 const relay=fakeAdminRelay(),id=randomUUID(),config={url,secret:relay.secret};let calls=0,receipt;
 let upstream=mock.method(globalThis,'fetch',async(u,o)=>{calls++;if(calls===1){receipt=relay.request(JSON.parse(o.body));return new Response(null,{status:302,headers:{Location:'https://script.googleusercontent.com/macros/echo?synthetic=1'}});}assert.equal(o.method,'GET');assert.equal(o.body,undefined);assert.equal(o.headers,undefined);return Response.json(receipt);});
 try{assert.equal((await deliverAdminMail(config,id,'member@example.invalid','subject','body')).outcome,'sent');assert.equal(calls,2);}finally{upstream.mock.restore();}
 for(const[status,location]of [[307,url],[308,url],[302,'https://evil.invalid/macros/echo'],[302,'https://script.googleusercontent.com/evil'],[302,'http://script.googleusercontent.com/macros/echo']]){calls=0;upstream=mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status,headers:{Location:location}});});try{assert.equal((await deliverAdminMail(config,randomUUID(),'member@example.invalid','subject','body')).outcome,'ambiguous');assert.equal(calls,1);}finally{upstream.mock.restore();}}
 for(const body of [{version:1,send_id:id,outcome:'sent',signature:'x'.repeat(43)},{ok:true},'x'.repeat(5000)]){upstream=mock.method(globalThis,'fetch',async()=>Response.json(body));try{assert.equal((await deliverAdminMail(config,id,'member@example.invalid','subject','body')).outcome,'ambiguous');}finally{upstream.mock.restore();}}
});
