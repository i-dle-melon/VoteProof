// Real workerd streaming/scheduled integration; all Google traffic intercepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { localCaseRuntime, guestBody } from '../scripts/lib/local-case-runtime.mjs';
import { DRIVE_SCOPE, FOLDER_MIME } from '../src/lib/google-drive.js';
test('scheduled Worker uploads known-length R2 stream to mocked resumable API and leaves gate/data intact',async()=>{
  const files=new Map([['local_root',{id:'local_root',mimeType:FOLDER_MIME}]]),sessions=new Map(),trace=[];let serial=0,uploads=0;
  const local=await localCaseRuntime({backupService:async request=>{
    const u=new URL(request.url);
    trace.push(request.method+' '+u.pathname);
    if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:randomBytes(32).toString('hex'),expires_in:3600,scope:DRIVE_SCOPE});
    if(u.pathname.endsWith('/generateIds'))return Response.json({ids:['worker_id_'+ ++serial]});
    if(request.method==='POST'){
      const m=await request.json();
      if(u.pathname.startsWith('/upload/')){sessions.set(m.id,m);return new Response(null,{headers:{Location:'https://www.googleapis.com/upload/drive/v3/files?upload_id='+m.id}});}
      files.set(m.id,m);return Response.json({id:m.id});
    }
    if(request.method==='PUT'){
      uploads++;trace.push('length='+request.headers.get('Content-Length'));assert.equal(request.headers.get('Content-Length'),'3');
      const bytes=await request.arrayBuffer();assert.equal(bytes.byteLength,3);
      const m=sessions.get(u.searchParams.get('upload_id'));files.set(m.id,{...m,size:'3'});return Response.json({id:m.id});
    }
    const m=files.get(u.pathname.split('/').at(-1));return m?Response.json(m):new Response(null,{status:404});
  }});
  try{
    await local.setAuthConfig({DRIVE_BACKUP_TRANSPORT:'worker_oauth_legacy',GOOGLE_DRIVE_BACKUP_ENABLED:'true',GOOGLE_DRIVE_CLIENT_ID:randomBytes(12).toString('hex'),
      GOOGLE_DRIVE_CLIENT_SECRET:randomBytes(24).toString('hex'),GOOGLE_DRIVE_REFRESH_TOKEN:randomBytes(32).toString('hex'),GOOGLE_DRIVE_ROOT_FOLDER_ID:'local_root'});
    const reference=await local.upload();assert.equal((await local.fetch('/api/cases','POST',guestBody(reference))).status,201);
    await local.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
    const scheduled=await (await local.runtime.getWorker()).scheduled({scheduledTime:Date.now(),cron:'*/15 * * * *'});
    assert.equal(scheduled.outcome,'ok');
    const job=await local.db.prepare('SELECT * FROM proof_backups').first();assert.equal(job.status,'confirmed',job.last_error_code+' '+JSON.stringify(trace));assert.equal(uploads,1);
    assert.ok(await local.bucket.head(job.source_object_key));
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM cases').first()).n,1);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM point_transactions').first()).n,0);
    assert.equal((await local.db.prepare('SELECT submissions_enabled FROM submission_settings WHERE id=1').first()).submissions_enabled,0);
    assert.deepEqual(local.unexpectedUpstreams,[]);
  }finally{await local.runtime.dispose();}
});
