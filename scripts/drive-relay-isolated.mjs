// Isolated synthetic connection harness. No Cloudflare API, OAuth or live R2.
import {createHash} from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { localCaseRuntime, guestBody } from './lib/local-case-runtime.mjs';
const args=process.argv.slice(2), name=args.find(v=>v.startsWith('--fixture='))?.slice(10) ?? 'manual';
if(!/^[a-z0-9-]{1,80}$/.test(name))throw Error('Invalid isolated fixture name');
const folder=resolve('.wrangler/drive-relay-isolated',name), configPath=resolve(folder,'private-config.json');
await mkdir(folder,{recursive:true});
let privateConfig;
try{privateConfig=JSON.parse(await readFile(configPath,'utf8'));}
catch(e){if(e.code!=='ENOENT')throw Error('Invalid private config');privateConfig={DRIVE_BACKUP_RELAY_SECRET:randomBytes(32).toString('hex')};await writeFile(configPath,JSON.stringify(privateConfig),{mode:0o600,flag:'wx'});}
if(!/^[a-f0-9]{64}$/.test(privateConfig.DRIVE_BACKUP_RELAY_SECRET??''))throw Error('Invalid private config');
function syntheticPng(){
  const chunk=(type,body)=>{const name=Buffer.from(type),data=Buffer.concat([name,body]);let crc=0xffffffff;
    for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(body.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,data,sum]);};
  const w=128,h=48,head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=2;
  const pixels=Buffer.alloc((w*3+1)*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*(w*3+1)+1+x*3,c=((x>>3)+(y>>3))%2;pixels[i]=c?32:230;pixels[i+1]=c?120:240;pixels[i+2]=c?190:250;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
const local=await localCaseRuntime({resourcePersistencePath:resolve(folder,'state'),submissionsEnabled:false});
await local.setAuthConfig({GOOGLE_DRIVE_BACKUP_ENABLED:'true',DRIVE_BACKUP_RELAY_SECRET:privateConfig.DRIVE_BACKUP_RELAY_SECRET});
try{
  if((await local.db.prepare('SELECT count(*) AS n FROM cases').first()).n===0){
    const bytes=syntheticPng();await writeFile(resolve(folder,'synthetic.png'),bytes);
    await local.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();
    const prep=await local.fetch('/api/uploads/prepare','POST',{turnstile_token:randomUUID(),files:[{name:'synthetic.png',type:'image/png',size:bytes.length,algorithm:'sha256',sha256:createHash('sha256').update(bytes).digest('hex')}]});
    if(prep.status!==200)throw Error('Local prepare failed');const p=(await prep.json()).data,reference={session_id:p.session_id,keys:p.uploads.map(v=>v.key)};
    await local.put(p.uploads[0],bytes);
    if((await local.fetch('/api/uploads/complete','POST',reference)).status!==200)throw Error('Local upload complete failed');
    if((await local.fetch('/api/cases','POST',guestBody(reference),{'Idempotency-Key':randomUUID()})).status!==201)throw Error('Local synthetic case failed');
    await local.db.prepare('UPDATE submission_settings SET submissions_enabled=0 WHERE id=1').run();
  }
}catch(e){await local.runtime.dispose();throw Error('Isolated preparation failed');}
async function status(){
  const rows=(await local.db.prepare('SELECT id,status,attempts,drive_file_id,drive_folder_id,last_error_code FROM proof_backups').all()).results;
  return {isolated:true,cases:(await local.db.prepare('SELECT count(*) AS n FROM cases').first()).n,backups:rows,
    submissions_enabled:(await local.db.prepare('SELECT submissions_enabled FROM submission_settings WHERE id=1').first()).submissions_enabled,
    foreign_key_check:(await local.db.prepare('PRAGMA foreign_key_check').all()).results.length===0?'PASS':'FAIL',quick_check:(await local.db.prepare('PRAGMA quick_check').first()).quick_check};
}
if(args.includes('--check')){console.log(JSON.stringify(await status()));await local.runtime.dispose();}
else{
  const port=Number(args.find(v=>v.startsWith('--port='))?.slice(7)??65011);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid local port');
  let loseAck=false;
  const allowed=req=>{const value=req.headers.authorization??'',expected='Bearer '+privateConfig.DRIVE_BACKUP_RELAY_SECRET;return !Object.hasOwn(req.headers,'origin')&&value.length===expected.length&&timingSafeEqual(Buffer.from(value),Buffer.from(expected));};
  const server=createServer(async(req,res)=>{
    try{
      res.setHeader('Cache-Control','no-store');if(!allowed(req)){res.writeHead(401);res.end('{"ok":false}');return;}
      if(req.url==='/__status'&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await status()));return;}
      if(req.url==='/__lose-complete-ack'&&req.method==='POST'){loseAck=true;res.end('{"armed":true}');return;}
      if(req.url==='/__restart'&&req.method==='POST'){await local.setAuthConfig({RELAY_FIXTURE_RESTART:randomUUID()});res.end('{"restarted":true}');return;}
      if(!/^\/api\/internal\/drive-backup\//.test(req.url??'')){res.writeHead(404);res.end();return;}
      const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>16384){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const response=await local.fetch(req.url,req.method,chunks.length?Buffer.concat(chunks).toString('utf8'):undefined,req.headers);
      if(loseAck&&req.url.endsWith('/complete')&&response.status===200){loseAck=false;res.writeHead(503);res.end('{"ok":false,"error":{"code":"NETWORK"}}');return;}
      res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
    }catch{res.writeHead(503);res.end('{"ok":false}');}
  });
  server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({isolated:true,listen:'http://127.0.0.1:'+port,private_config:configPath,production_access:false})));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await local.runtime.dispose();process.exit(0);}));
}
