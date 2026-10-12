import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { oauthUrl, authorizeLocal, createBackupRoot } from '../scripts/google-drive-oauth.mjs';
import { DRIVE_SCOPE, FOLDER_MIME } from '../src/lib/google-drive.js';
test('setup URL requests only drive.file, offline consent and S256 state-protected callback', () => {
  const url = new URL(oauthUrl('local-client','http://127.0.0.1:53682/oauth/callback',randomBytes(32).toString('hex'),randomBytes(48).toString('hex')));
  assert.equal(url.searchParams.get('scope'),DRIVE_SCOPE); assert.equal(url.searchParams.get('access_type'),'offline');
  assert.equal(url.searchParams.get('prompt'),'consent'); assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(url.searchParams.has('client_secret'),false);
});
test('loopback callback rejects bad state, exchanges only once, stores privately and shuts down', async () => {
  let exchanges=0, saved=0, savedValid=false;
  const runtimeRefresh=randomBytes(32).toString('hex'), runtimeAccess=randomBytes(32).toString('hex');
  const result=await authorizeLocal({ clientId:'local-client',clientSecret:randomBytes(24).toString('hex'), port:53782,
    fetcher:async(url,init)=>{
      exchanges++; assert.equal(url,'https://oauth2.googleapis.com/token'); assert.equal(init.body.get('grant_type'),'authorization_code');
      assert.ok(init.body.get('code_verifier').length>=43);
      return Response.json({refresh_token:runtimeRefresh,access_token:runtimeAccess,scope:DRIVE_SCOPE});
    }, save:async value=>{saved++; savedValid=value.GOOGLE_DRIVE_REFRESH_TOKEN===runtimeRefresh&&!Object.hasOwn(value,'access_token');},
    onUrl:async value=>{
      const auth=new URL(value), callback=new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('state','wrong'); callback.searchParams.set('code',randomBytes(12).toString('hex'));
      assert.equal((await fetch(callback)).status,400); assert.equal(exchanges,0);
      callback.searchParams.set('state',auth.searchParams.get('state')); assert.equal((await fetch(callback)).status,200);
    },
  });
  assert.deepEqual(result,{authorized:true}); assert.equal(exchanges,1); assert.equal(saved,1); assert.equal(savedValid,true);
  await assert.rejects(fetch('http://127.0.0.1:53782/oauth/callback'));
});
test('setup root persists reserved ID before create and reruns create no duplicate/sharing', async () => {
  let savedId, creates=0; const files=new Map();
  const fetcher=async(url,init={})=>{
    if(url.includes('oauth2.googleapis.com')) return Response.json({access_token:randomBytes(32).toString('hex'),expires_in:3600,scope:DRIVE_SCOPE});
    const u=new URL(url); assert.equal(u.pathname.includes('permissions'),false);
    if(u.pathname.endsWith('/generateIds'))return Response.json({ids:['root_test']});
    if(init.method==='POST'){const m=JSON.parse(init.body);assert.equal(savedId,m.id);assert.equal(m.name,'VoteProof Backup');assert.equal(m.mimeType,FOLDER_MIME);creates++;files.set(m.id,m);return Response.json(m);}
    return files.has(u.pathname.split('/').at(-1))?Response.json(files.get(u.pathname.split('/').at(-1))):new Response(null,{status:404});
  };
  const env={GOOGLE_DRIVE_CLIENT_ID:'local-client',GOOGLE_DRIVE_CLIENT_SECRET:randomBytes(24).toString('hex'),GOOGLE_DRIVE_REFRESH_TOKEN:randomBytes(32).toString('hex')};
  const id=await createBackupRoot(env,{fetcher,saveId:async id=>{savedId=id;}});assert.equal(id,'root_test');
  assert.equal(await createBackupRoot(env,{fetcher,id,saveId:()=>assert.fail('must reuse')}),id);assert.equal(creates,1);
});

test('failed OAuth exchange exposes no provider text, writes nothing and closes listener', async () => {
  let saved=0;
  await assert.rejects(authorizeLocal({clientId:'local-client',clientSecret:randomBytes(24).toString('hex'),port:53783,
    fetcher:async()=>Response.json({error:'invalid_grant',error_description:randomBytes(32).toString('hex')},{status:400}),
    save:async()=>{saved++;},onUrl:async value=>{
      const auth=new URL(value),callback=new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('state',auth.searchParams.get('state'));callback.searchParams.set('code',randomBytes(12).toString('hex'));
      const response=await fetch(callback);assert.equal(response.status,400);assert.equal(await response.text(),'Authorization failed. Check local setup.');
    }}),{message:'OAUTH_SETUP_FAILED'});
  assert.equal(saved,0);await assert.rejects(fetch('http://127.0.0.1:53783/oauth/callback'));
});
