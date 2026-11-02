import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {metadataPreflight} from '../scripts/ci/deploy-metadata-preflight.mjs';
const accountId='7a1ae5a3d1e51008d0880ac526740717',token='synthetic-test-token-never-production';
const bindings=[{name:'DB',type:'d1',id:'9e2b885d-66e2-4e4d-b768-4bded261296a'},
 {name:'PROOFS_BUCKET',type:'r2_bucket',bucket_name:'voteproof-proofs'},{name:'ASSETS',type:'assets'},
 {name:'SYNTHETIC_PRIVATE_SETTING',type:'plain_text',text:'synthetic-sensitive-payload'},
 {name:'SYNTHETIC_SECRET_NAME',type:'secret_text'}];
function fixture({source='dash',failAt=-1,status=403,malformed=false,wrongBinding=false,throwAt=-1}={}){
 const calls=[];
 const fetcher=async(url,options)=>{
  const i=calls.length;calls.push({url,method:options.method});
  assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+token);
  if(i===throwAt)throw Error(token+' synthetic-sensitive-payload');
  if(i===failAt)return malformed?{status:200,ok:true,json:async()=>{throw Error(token);}}:
   Response.json({success:false,errors:[{code:10000,message:'synthetic-sensitive-payload'}]},{status});
  const result=i===0?{default_environment:{environment:'production',script:{last_deployed_from:source}}}:
   i===1?wrongBinding?bindings.map(b=>b.name==='DB'?{...b,id:'wrong-db'}:b):bindings:[];
  return Response.json({success:true,result});
 };
 return {calls,run:()=>metadataPreflight({accountId,token,fetcher})};
}
test('Dashboard-origin metadata reads are bounded to seven GETs, retain safety checks and omit payloads',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.ok,true);assert.equal(r.mutations,0);assert.equal(f.calls.length,7);
 assert.equal(JSON.stringify(r).includes(token),false);assert.equal(JSON.stringify(r).includes('synthetic-sensitive-payload'),false);
 assert.equal(JSON.stringify(r).includes('SYNTHETIC_SECRET_NAME'),false);
});
for(const failAt of[0,1,2,3,4,5,6])test('metadata failure at endpoint '+failAt+' stops without retry or deploy',async()=>{
 const f=fixture({failAt}),r=await f.run();
 assert.equal(r.ok,false);assert.equal(f.calls.length,failAt+1);
 assert.equal(r.checks.at(-1).http_status,403);assert.deepEqual(r.checks.at(-1).error_codes,[10000]);
 assert.equal(JSON.stringify(r).includes('synthetic-sensitive-payload'),false);
});
for(const status of[401,404,429,500,503])test('HTTP '+status+' remains HOLD',async()=>{
 const f=fixture({failAt:1,status}),r=await f.run();assert.equal(r.ok,false);assert.equal(f.calls.length,2);
});
test('network/timeout and malformed JSON are UNKNOWN with no exception payload',async()=>{
 for(const options of[{throwAt:1},{failAt:1,malformed:true}]){
  const f=fixture(options),r=await f.run();assert.equal(r.ok,false);assert.equal(f.calls.length,2);
  assert.equal(JSON.stringify(r).includes(token),false);
 }
});
test('other Account and absent token are rejected before any request',async()=>{
 let calls=0;const fetcher=()=>{calls++;throw Error();};
 await assert.rejects(metadataPreflight({accountId:'5f8bbc516ec1bd412160ce1fbd35ec25',token,fetcher}));
 await assert.rejects(metadataPreflight({accountId,token:'',fetcher}));assert.equal(calls,0);
});
test('wrong DB binding or unknown deployment origin cannot pass silently',async()=>{
 assert.equal((await fixture({wrongBinding:true}).run()).reason,'PRODUCTION_BINDINGS_MISMATCH');
 assert.equal((await fixture({source:'unknown'}).run()).reason,'REMOTE_DEPLOY_SOURCE_UNKNOWN');
});
for(const source of['api','wrangler'])test(source+' origin still validates bindings, without unnecessary Dashboard-only reads',async()=>{
 const f=fixture({source}),r=await f.run();assert.equal(r.ok,true);assert.equal(f.calls.length,2);
});
test('deployment keeps exact-SHA, protected Environment, Vars, Assets and no-migration contract',()=>{
 const s=fs.readFileSync('.github/workflows/production-deploy.yml','utf8');
 assert.ok(s.includes('environment: production'));assert.ok(s.includes('ref: ${{ github.sha }}'));
 assert.ok(s.includes('node scripts/ci/deploy-metadata-preflight.mjs'));
 assert.ok(s.includes('npx --yes --package=wrangler@4.156.0 wrangler deploy --name voteproof'));
 assert.ok(s.includes('--keep-vars --message "Git commit $RELEASE_SHA"'));
 assert.equal((s.match(/wrangler deploy --name/g)||[]).length,1);
 assert.equal(/--force|skip.*config.diff|wrangler.*migrations.*apply|wrangler.*rollback/.test(s),false);
 assert.ok(s.includes('config.assets.directory = path.resolve(config.assets.directory)'));
 assert.ok(s.indexOf('node scripts/ci/deploy-metadata-preflight.mjs')<s.indexOf('npx --yes --package='));
});
