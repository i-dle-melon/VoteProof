import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
const source=JSON.parse(fs.readFileSync('test/fixtures/wrangler-4.156.0-dashboard-metadata.json','utf8'));
function harness({denyRoutes=true,origin='dash',workersDev=true,customRoute=false}={}){
 const calls=[];
 const context=vm.createContext({fetchResult:async(_config,path)=>{
  calls.push({method:'GET',path});
  if(path.includes('/routes?')){
   if(denyRoutes)throw Object.assign(Error('Synthetic permission denied'),{status:403,code:10000});
   return customRoute?[{pattern:'synthetic.example/*'}]:[];
  }
  if(path.endsWith('/subdomain'))return {enabled:workersDev,previews_enabled:false};
  return [];
 }});
 const fetchWorkerConfig=vm.runInContext('('+source.metadata_function+')',context);
 context.downloadWorkerConfig=(config,name,environment,_entry,account)=>fetchWorkerConfig(config,account,name,environment);
 // Execute the original Dashboard branch and original metadata-fetch function.
 // Only API responses are replaced; no production requests or SDK patches.
 const invoke=vm.runInContext('(async function(script,config2,name2,serviceMetaData,props,accountId){'+
  source.dashboard_callsite+' return remoteWorkerConfig; } return {dashboard_read_skipped:true}; })',context);
 return {calls,run:()=>invoke({last_deployed_from:origin},{workers_dev:workersDev,routes:[]},'synthetic-worker',
  {default_environment:{environment:'production'}},{entry:{file:'synthetic.js'},routes:[]},'synthetic-account')};
}
test('upstream 4.156.0 excerpts are intact and the Dashboard branch is not conditional on Routes or workers.dev',()=>{
 assert.equal(source.version,'4.156.0');
 assert.equal(createHash('sha256').update(source.metadata_function+'\n'+source.dashboard_callsite).digest('hex'),source.excerpt_sha256);
 assert.ok(source.dashboard_callsite.startsWith('if (script.last_deployed_from === "dash")'));
 assert.doesNotMatch(source.dashboard_callsite,/workers_dev|routes\.length/);
});
test('skipping VoteProof preflight still makes actual Wrangler 4.156.0 fail Routes 403 for workers.dev-only',async()=>{
 const h=harness();
 await assert.rejects(h.run(),e=>e.message.includes('Unable to fetch bindings')&&e.cause.status===403&&e.cause.code===10000);
 assert.equal(h.calls.filter(c=>c.path.includes('/routes?show_zonename=true')).length,1);
 assert.ok(h.calls.every(c=>c.method==='GET'));assert.equal(h.calls.length,6);
});
test('metadata 200 succeeds in the same unmodified upstream branch',async()=>{
 const h=harness({denyRoutes:false}),r=await h.run();
 assert.equal(r.routes.length,0);assert.equal(r.subdomainStatus.enabled,true);assert.equal(h.calls.length,6);
});
test('Wrangler only skips this Dashboard metadata branch for a non-Dashboard source',async()=>{
 const h=harness({origin:'wrangler'}),r=await h.run();assert.equal(r.dashboard_read_skipped,true);assert.equal(h.calls.length,0);
});
test('unexpected custom route remains visible to the downstream config comparison',async()=>{
 const h=harness({denyRoutes:false,customRoute:true}),r=await h.run();
 assert.equal(r.routes.length,1);assert.equal(r.routes[0].pattern,'synthetic.example/*');
});

const fixed=JSON.parse(fs.readFileSync('test/fixtures/wrangler-4.156.2-dashboard-metadata.json','utf8'));
function fixedHarness({routes=[],command='deploy',deny='routing'}={}){
 const calls=[];
 const context=vm.createContext({fetchResult:async(_config,path)=>{
  calls.push(path);
  if((deny==='routing'&&(path.includes('/routes?')||path.includes('/domains/records?')))||
   (deny==='bindings'&&path.endsWith('/bindings')))
   throw Object.assign(Error('Synthetic permission denied'),{status:403,code:10000});
  if(deny==='timeout'&&path.endsWith('/bindings'))throw Error('Synthetic timeout');
  if(path.endsWith('/bindings'))return[{name:'DB',type:'d1',id:'synthetic-db'}];
  if(path.endsWith('/subdomain'))return{enabled:true,previews_enabled:false};
  if(path.endsWith('/schedules'))return{schedules:[]};
  if(path.includes('/routes?'))return[{pattern:'synthetic.example/*'}];
  if(path.includes('/domains/records?'))return[{hostname:'app.synthetic.example'}];
  return{script:{compatibility_date:'2026-10-07'}};
 }});
 vm.runInContext(fixed.partition,context);
 const read=vm.runInContext('('+fixed.metadata+')',context);
 context.downloadWorkerConfig=(config,name,environment,_entry,account,scope)=>read(config,account,name,environment,scope);
 const invoke=vm.runInContext('(async function(script,props,config2,name2,serviceMetaData,accountId){'+
  fixed.callsite+' return remoteWorkerConfig;} return null;})',context);
 return{calls,read:scope=>read({},'synthetic-account','synthetic-worker','production',scope),
  run:()=>invoke({last_deployed_from:'dash'},{routes,command,entry:{file:'synthetic.js'}},
   {workers_dev:true,routes},'synthetic-worker',{default_environment:{environment:'production'}},'synthetic-account')};
}
test('official 4.156.2 fixture has verified version and excerpt digest',()=>{
 assert.equal(fixed.version,'4.156.2');
 assert.equal(createHash('sha256').update(fixed.partition+'\n'+fixed.metadata+'\n'+fixed.callsite).digest('hex'),fixed.excerpt_sha256);
});
test('official 4.156.2 no-route Dashboard deployment succeeds without either denied routing read',async()=>{
 const h=fixedHarness(),r=await h.run();assert.equal(h.calls.length,4);
 assert.equal(h.calls.some(p=>p.includes('/routes?')||p.includes('/domains/records?')),false);
 assert.equal(r.bindings[0].id,'synthetic-db');assert.equal(r.subdomainStatus.enabled,true);
 assert.equal(r.serviceEnvMetadata.script.compatibility_date,'2026-10-07');
});
test('official 4.156.2 still rejects necessary Route 403 when ordinary routes are configured',async()=>{
 const h=fixedHarness({routes:['synthetic.example/*']});
 await assert.rejects(h.run(),e=>e.cause?.status===403);
 assert.equal(h.calls.filter(p=>p.includes('/routes?')).length,1);
 assert.equal(h.calls.some(p=>p.includes('/domains/records?')),false);
});
test('official 4.156.2 still rejects necessary Custom Domain 403',async()=>{
 const h=fixedHarness({routes:[{pattern:'synthetic.example',custom_domain:true}]});
 await assert.rejects(h.run(),e=>e.cause?.status===403);
 assert.equal(h.calls.some(p=>p.includes('/routes?')),false);
 assert.equal(h.calls.filter(p=>p.includes('/domains/records?')).length,1);
});
test('official 4.156.2 complete-config download still requires both route categories',async()=>{
 const h=fixedHarness();await assert.rejects(h.read(undefined),e=>e.cause?.status===403);assert.equal(h.calls.length,6);
});
for(const deny of['bindings','timeout'])test('official 4.156.2 necessary '+deny+' failure remains failure',async()=>{
 const h=fixedHarness({deny});await assert.rejects(h.run());assert.equal(h.calls.length,4);
});
test('official 4.156.2 retains returned routes rather than erasing configured connections',async()=>{
 const h=fixedHarness({deny:'none',routes:['synthetic.example/*',{pattern:'app.synthetic.example',custom_domain:true}]}),r=await h.run();
 assert.equal(h.calls.length,6);assert.equal(r.routes[0].pattern,'synthetic.example/*');
 assert.equal(r.customDomains[0].hostname,'app.synthetic.example');
});
