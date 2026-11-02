import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {metadataPreflight,assertLocalRoutingScope} from '../scripts/ci/deploy-metadata-preflight.mjs';
const accountId='7a1ae5a3d1e51008d0880ac526740717',token='synthetic-test-token-never-production';
const localConfig={name:'voteproof'};
const bindings=[{name:'DB',type:'d1',id:'9e2b885d-66e2-4e4d-b768-4bded261296a'},
 {name:'PROOFS_BUCKET',type:'r2_bucket',bucket_name:'voteproof-proofs'},{name:'ASSETS',type:'assets'},
 {name:'SYNTHETIC_PRIVATE_SETTING',type:'plain_text',text:'synthetic-sensitive-payload'},
 {name:'SYNTHETIC_SECRET_NAME',type:'secret_text'}];
function fixture({source='dash',failAt=-1,status=403,malformed=false,throwAt=-1,overrides={}}={}){
 const calls=[];
 const fetcher=async(url,options)=>{
  const i=calls.length;calls.push({url,method:options.method});
  assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+token);
  assert.doesNotMatch(url,/\/routes\?|\/domains\/records/);
  if(i===throwAt)throw Error(token+' synthetic-sensitive-payload');
  if(i===failAt)return malformed?{status:200,ok:true,json:async()=>{throw Error(token);}}:
   Response.json({success:false,errors:[{code:10000,message:'synthetic-sensitive-payload'}]},{status});
  const values=[
   {name:'voteproof',default_environment:{environment:'production',script:{last_deployed_from:source}}},
   bindings,{enabled:true,previews_enabled:false},{script:{compatibility_date:'2026-10-07'}},{schedules:[]}
  ];
  return Response.json({success:true,result:Object.hasOwn(overrides,i)?overrides[i]:values[i]});
 };
 return {calls,run:()=>metadataPreflight({accountId,token,localConfig,fetcher})};
}

test('workers.dev-only uses five bounded required GETs without querying denied Routes or Domains',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.ok,true);assert.equal(r.mutations,0);assert.equal(f.calls.length,5);
 assert.equal(r.routing.remote_zone_routes,'NOT_REQUESTED_NOT_MODIFIED');
 assert.equal(r.routing.remote_custom_domains,'NOT_REQUESTED_NOT_MODIFIED');
 assert.equal(r.routing.remote_route_inventory_verified,false);assert.equal(r.routing.remote_workers_dev,'ON');
 assert.equal(r.routing.wrangler_version,'4.156.2');assert.equal(r.routing.wrangler_routes_read_required,false);
 assert.equal(r.checks.some(c=>['routes','custom_domains'].includes(c.endpoint)),false);
 for(const secret of[token,'synthetic-sensitive-payload','SYNTHETIC_SECRET_NAME'])
  assert.equal(JSON.stringify(r).includes(secret),false);
});
for(const failAt of[0,1,2,3,4])test('required metadata failure at endpoint '+failAt+' stops without retry or deploy',async()=>{
 const f=fixture({failAt}),r=await f.run();assert.equal(r.ok,false);assert.equal(f.calls.length,failAt+1);
 assert.equal(r.checks.at(-1).http_status,403);assert.deepEqual(r.checks.at(-1).error_codes,[10000]);
 assert.equal(JSON.stringify(r).includes('synthetic-sensitive-payload'),false);
});
for(const status of[401,404,429,500,503])test('HTTP '+status+' on necessary metadata remains HOLD',async()=>{
 const f=fixture({failAt:1,status}),r=await f.run();assert.equal(r.ok,false);assert.equal(f.calls.length,2);
});
test('network/timeout and malformed JSON are UNKNOWN without exception payload',async()=>{
 for(const options of[{throwAt:1},{failAt:1,malformed:true}]){
  const f=fixture(options),r=await f.run();assert.equal(r.ok,false);assert.equal(f.calls.length,2);
  assert.equal(JSON.stringify(r).includes(token),false);
 }
});
test('other Account and absent token are rejected before any request',async()=>{
 let calls=0;const fetcher=()=>{calls++;throw Error();};
 await assert.rejects(metadataPreflight({localConfig,accountId:'5f8bbc516ec1bd412160ce1fbd35ec25',token,fetcher}));
 await assert.rejects(metadataPreflight({localConfig,accountId,token:'',fetcher}));assert.equal(calls,0);
});
for(const name of['DB','PROOFS_BUCKET','ASSETS'])test('mismatched or missing '+name+' cannot pass',async()=>{
 const bad=bindings.map(b=>b.name!==name?b:{...b,id:'wrong-db',bucket_name:'wrong-bucket',type:'wrong-type'});
 for(const value of[bad,bindings.filter(b=>b.name!==name)]){
  const f=fixture({overrides:{1:value}});assert.equal((await f.run()).reason,'PRODUCTION_BINDINGS_MISMATCH');
  assert.equal(f.calls.length,2);
 }
});
test('missing or malformed routing configuration holds before any API call',async()=>{
 let calls=0;const fetcher=()=>{calls++;throw Error();};
 const invalid=[undefined,null,{}, {name:'another-worker'},{name:'voteproof',route:null},
  {name:'voteproof',routes:null},{name:'voteproof',routes:'unknown'},
  {name:'voteproof',routes:['synthetic.example/*']},
  {name:'voteproof',routes:[{pattern:'synthetic.example',custom_domain:true}]},
  {name:'voteproof',workers_dev:false},{name:'voteproof',workers_dev:'true'},
  {name:'voteproof',preview_urls:true},{name:'voteproof',preview_urls:'false'},
  {name:'voteproof',env:null},{name:'voteproof',env:{production:{routes:[]}}}];
 for(const config of invalid){
  assert.throws(()=>assertLocalRoutingScope(config),/LOCAL_ROUTING_SCOPE_REQUIRES_REVIEW/);
  await assert.rejects(metadataPreflight({accountId,token,localConfig:config,fetcher}),/LOCAL_ROUTING_SCOPE_REQUIRES_REVIEW/);
 }
 assert.equal(calls,0);
});
test('known no-route configuration can omit defaults or state the approved settings explicitly',()=>{
 assert.doesNotThrow(()=>assertLocalRoutingScope(localConfig));
 assert.doesNotThrow(()=>assertLocalRoutingScope({name:'voteproof',routes:[],workers_dev:true,preview_urls:false,env:{}}));
 assert.doesNotThrow(()=>assertLocalRoutingScope(JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'))));
});
for(const data of[{},[],{enabled:false,previews_enabled:false},{enabled:true,previews_enabled:true}])
test('unknown or conflicting workers.dev/Preview settings HOLD',async()=>{
 const f=fixture({overrides:{2:data}}),r=await f.run();assert.equal(r.ok,false);assert.equal(f.calls.length,3);
 assert.match(r.reason,/REMOTE_SUBDOMAIN_UNKNOWN|UNEXPECTED_WORKERS_DEV_SETTING/);
});
for(const hint of[{routes:['synthetic.example/*']},{custom_domains:[{hostname:'synthetic.example'}]},
 {routes:null},{custom_domains:'unknown'},{route:'synthetic.example/*'}])
test('unexpected or unknown routing hints in metadata cannot be silently ignored',async()=>{
 for(const nested of[false,true]){
  const data={name:'voteproof',default_environment:{environment:'production',script:{last_deployed_from:'dash'}}};
  Object.assign(nested?data.default_environment:data,hint);
  const f=fixture({overrides:{0:data}}),r=await f.run();
  assert.equal(r.ok,false);assert.equal(r.reason,'REMOTE_ROUTING_SCOPE_REQUIRES_REVIEW');assert.equal(f.calls.length,1);
  assert.equal(JSON.stringify(r).includes('synthetic.example'),false);
 }
});
test('unknown environment, deploy source or wrong Worker stays HOLD',async()=>{
 for(const data of[
  {default_environment:{environment:'invalid/name',script:{last_deployed_from:'dash'}}},
  {default_environment:{environment:'staging',script:{last_deployed_from:'dash'}}},
  {default_environment:{environment:'production',script:{last_deployed_from:'unknown'}}},
  {name:'wrong-worker',default_environment:{environment:'production',script:{last_deployed_from:'dash'}}}
 ]){
  const f=fixture({overrides:{0:data}});assert.equal((await f.run()).ok,false);assert.equal(f.calls.length,1);
 }
});
for(const source of['api','wrangler'])test(source+' origin retains necessary routing and metadata checks',async()=>{
 const f=fixture({source}),r=await f.run();assert.equal(r.ok,true);assert.equal(f.calls.length,5);
});
test('unknown environment metadata or schedules and unexpected Cron hold',async()=>{
 for(const overrides of[{3:{}},{3:[]},{4:[]},{4:{schedules:[{cron:'* * * * *'}]}}]){
  const r=await fixture({overrides}).run();assert.equal(r.ok,false);
  assert.match(r.reason,/REMOTE_ENVIRONMENT_METADATA_UNKNOWN|REMOTE_SCHEDULES_UNKNOWN|UNEXPECTED_REMOTE_SCHEDULES/);
 }
});
test('deployment preserves exact SHA, protected Environment, Vars, Assets and no-migration contract',()=>{
 const s=fs.readFileSync('.github/workflows/production-deploy.yml','utf8');
 assert.ok(s.includes('environment: production'));assert.ok(s.includes('ref: $'+'{{ github.sha }}'));
 assert.ok(s.includes('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"'));
 assert.ok(s.includes('node scripts/ci/deploy-metadata-preflight.mjs'));
 assert.ok(s.includes('npx --yes --package=wrangler@4.156.2 wrangler deploy --name voteproof'));
 assert.ok(s.includes('--keep-vars --message "Git commit $RELEASE_SHA"'));
 assert.equal((s.match(/wrangler deploy --name/g)||[]).length,1);
 assert.equal(/--force|skip.*config.diff|wrangler.*migrations.*apply|wrangler.*rollback/.test(s),false);
 assert.ok(s.includes('config.assets.directory = path.resolve(config.assets.directory)'));
 assert.ok(s.includes('config.workers_dev = true'));assert.ok(s.includes('config.preview_urls = false'));
 assert.ok(s.includes("JSON.stringify(before.data)!==JSON.stringify(after.data)"));
 assert.ok(s.indexOf('node scripts/ci/deploy-metadata-preflight.mjs')<s.indexOf('npx --yes --package='));
});
