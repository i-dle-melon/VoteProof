// Disposable local fixtures only; never use live credentials or proof objects.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DRIVE_SCOPE, FOLDER_MIME } from '../../src/lib/google-drive.js';
// Deprecated path is explicit in isolated comparison fixtures; never a Production default.
export const driveConfigFixture = () => ({ DRIVE_BACKUP_TRANSPORT:'worker_oauth_legacy', GOOGLE_DRIVE_BACKUP_ENABLED:'true', GOOGLE_DRIVE_ROOT_FOLDER_ID:'local_root',
  GOOGLE_DRIVE_CLIENT_ID:randomBytes(12).toString('hex'), GOOGLE_DRIVE_CLIENT_SECRET:randomBytes(24).toString('hex'),
  GOOGLE_DRIVE_REFRESH_TOKEN:randomBytes(32).toString('hex') });
export function countDatabase(source) {
  let queries=0; const raw=new WeakMap();
  const wrap = statement => {
    const proxy=new Proxy(statement,{get(target,key){
      if(key==='bind')return (...args)=>wrap(target.bind(...args));
      if(['first','all','run','raw'].includes(key))return (...args)=>{queries++;return target[key](...args);};
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});raw.set(proxy,statement);return proxy;
  };
  return { db:{prepare:sql=>wrap(source.prepare(sql)),batch:statements=>{
    queries+=statements.length;return source.batch(statements.map(s=>raw.get(s)??s));
  }},get queries(){return queries;},reset(){queries=0;} };
}
export function driveMock() {
  const files=new Map([['local_root',{id:'local_root',mimeType:FOLDER_MIME}]]),sessions=new Map();
  const state={calls:0,uploads:0,folders:0,serial:0,fail:null,loseAck:false,hook:null};
  const fetcher=async(url,init={})=>{
    state.calls++;const u=new URL(url);assert.ok(['oauth2.googleapis.com','www.googleapis.com'].includes(u.hostname));
    assert.equal(init.redirect,'manual');await state.hook?.(u,init);
    if(u.hostname==='oauth2.googleapis.com'){
      if(state.fail==='auth')return Response.json({error:'invalid_grant',error_description:'private mock text'},{status:400});
      return Response.json({access_token:randomBytes(32).toString('hex'),expires_in:3600,scope:DRIVE_SCOPE});
    }
    if(u.pathname.endsWith('/generateIds'))return Response.json({ids:['local_'+ ++state.serial]});
    if(init.method==='POST'){
      const m=JSON.parse(init.body);
      if(u.pathname.startsWith('/upload/')){sessions.set(m.id,m);return new Response(null,{headers:{Location:'https://www.googleapis.com/upload/drive/v3/files?upload_id='+m.id}});}
      if(files.has(m.id))return new Response(null,{status:409});state.folders++;files.set(m.id,m);return Response.json({id:m.id});
    }
    if(init.method==='PUT'){
      state.uploads++;
      if(state.fail==='upload')return Response.json({error:{message:'private mock text'}},{status:503});
      const m=sessions.get(u.searchParams.get('upload_id')),bytes=await new Response(init.body).arrayBuffer();
      assert.equal(Number(init.headers['Content-Length'] ?? init.headers['content-length']),bytes.byteLength);
      files.set(m.id,{...m,size:String(bytes.byteLength)});
      if(state.loseAck)throw Error('lost mock acknowledgement');return Response.json({id:m.id});
    }
    const m=files.get(u.pathname.split('/').at(-1));return m?Response.json(m):new Response(null,{status:404});
  };
  return {files,state,fetcher,service:async request=>fetcher(request.url,{method:request.method,redirect:'manual',
    headers:Object.fromEntries(request.headers),body:request.method==='POST'?await request.text():request.body})};
}
