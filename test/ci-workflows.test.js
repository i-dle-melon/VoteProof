import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { classify, baseline } from '../scripts/ci/plan.mjs';
import { ensureValidation, githubClient, trustedRun } from '../scripts/ci/validation.mjs';
const inventory={node:(await readdir('test')).filter(f=>f.endsWith('.test.js')).map(f=>'test/'+f),browser:(await readdir('frontend-tests')).filter(f=>f.endsWith('.spec.js')).map(f=>'frontend-tests/'+f)};
const sha='a'.repeat(40),other='b'.repeat(40),repository='owner/VoteProof';
const run=(extra={})=>({id:12,head_sha:sha,head_repository:{full_name:repository},head_branch:'codex/ui',event:'push',status:'completed',conclusion:'success',html_url:'https://github.com/owner/VoteProof/actions/runs/12',...extra});
test('CSS/copy changes select UI checks without backend or migrations',()=>{
  const p=classify(['public/css/app.css','public/index.html'],inventory);
  assert.equal(p.full,false);assert.equal(p.migrations,false);
  assert.ok(p.browser.includes('frontend-tests/admin.spec.js')); // Newly-added buttons cannot evade security-form regression.
  assert.ok(!p.node.includes('test/auth.test.js'));assert.ok(!p.browser.includes('frontend-tests/admin-export.spec.js'));
});
test('auth source changes retain related security/ownership tests, exclude unrelated exports',()=>{
  const p=classify(['src/api/auth-recovery.js','src/lib/password-operation.js'],inventory);
  for(const name of ['auth.test','auth-recovery-alternatives.test','b4s.test','rc-staff-security.test','members.test'])assert.ok(p.node.includes('test/'+name+'.js'));
  assert.ok(p.browser.includes('frontend-tests/admin.spec.js'));assert.ok(!p.browser.includes('frontend-tests/admin-export.spec.js'));assert.equal(p.migrations,false);
});
test('test-only fixes select their suite; shared helpers, unknown/deleted paths and CI policy fail broad',()=>{
  const p=classify(['frontend-tests/admin.spec.js'],inventory);assert.deepEqual(p.browser,['frontend-tests/admin.spec.js','frontend-tests/ci-smoke.spec.js']);
  for(const f of ['frontend-tests/admin-fixture.mjs','src/lib/new-shared.js','test/removed.test.js','.github/workflows/branch-validation.yml'])assert.equal(classify([f],inventory).full,true);
});
test('documentation and Node-only test changes do not install or run browsers',()=>{
  for(const file of ['docs/ci-and-publishing.md','AGENTS.md','test/auth-recovery-alternatives.test.js'])assert.deepEqual(classify([file],inventory).browser,[]);
});
test('migrations, dependency changes and explicit full run include local schema safety',()=>{
  for(const f of ['migrations/0025_example.sql','package-lock.json','wrangler.jsonc']){const p=classify([f],inventory);assert.equal(p.full,true);assert.equal(p.migrations,true);}
  assert.equal(classify([],inventory,true).migrations,true);
});
test('failed, unrelated, fork and PR runs cannot establish a trusted baseline',async()=>{
  const runs=[run({head_sha:other,conclusion:'failure'}),run({head_sha:other,event:'pull_request'}),run({head_sha:other,head_repository:{full_name:'fork/VoteProof'}}),run({head_sha:other})];
  const prior=process.env.GITHUB_REPOSITORY;process.env.GITHUB_REPOSITORY=repository;
  try{assert.equal(await baseline(runs,sha,async s=>s===other),other);assert.equal(await baseline(runs,sha,async()=>false),null);}finally{if(prior===undefined)delete process.env.GITHUB_REPOSITORY;else process.env.GITHUB_REPOSITORY=prior;}
});
test('Production reuses only exact-SHA trusted success without dispatch or test rerun',async()=>{
  const calls=[];const result=await ensureValidation({sha,repository,api:async(p,b)=>{calls.push({p,b});return p.startsWith('/actions/workflows/')?{workflow_runs:[run({head_sha:other}),run()]}:run();},sleep:async()=>{throw Error('Successful CI must not wait');}});
  assert.equal(result.run_id,12);assert.equal(calls.length,2);assert.ok(calls.every(c=>!c.b));
  assert.equal(trustedRun(run({event:'pull_request'}),repository),false);
});
test('running exact-SHA validation is awaited without dispatch; failure blocks release',async()=>{
  let checks=0;
  const r=await ensureValidation({sha,repository,api:async p=>p.startsWith('/actions/workflows/')?{workflow_runs:[run({status:'in_progress',conclusion:null})]}:run({status:++checks===1?'in_progress':'completed'}),sleep:async()=>{}});assert.equal(r.run_id,12);
  await assert.rejects(ensureValidation({sha,repository,api:async()=>({workflow_runs:[run({conclusion:'failure'})]})}),/failed|cancelled/);
});
test('missing validation dispatches once with approved SHA and rejects a moving main',async()=>{
  let dispatched=0;
  const api=async(p,b)=>{
    if(b){assert.equal(b.ref,'main');assert.equal(b.inputs.approved_sha,sha);dispatched++;return{};}
    if(p==='/git/ref/heads/main')return{object:{sha}};
    if(p.startsWith('/actions/workflows/'))return{workflow_runs:dispatched?[run()]:[]};
    return run();
  };
  assert.equal((await ensureValidation({sha,repository,api,sleep:async()=>{}})).run_id,12);assert.equal(dispatched,1);
  await assert.rejects(ensureValidation({sha,repository,sleep:async()=>{},api:async p=>p==='/git/ref/heads/main'?{object:{sha:other}}:{workflow_runs:[]}}),/main changed/);
});
test('provenance changes, timeout, API errors and invalid SHA fail closed',async()=>{
  await assert.rejects(ensureValidation({sha,repository,api:async p=>p.startsWith('/actions/workflows/')?{workflow_runs:[run()]}:run({head_sha:other})}),/provenance/);
  let clock=0;await assert.rejects(ensureValidation({sha,repository,now:()=>clock,timeout:10,sleep:async()=>{clock+=11;},api:async p=>p.startsWith('/actions/workflows/')?{workflow_runs:[run({status:'in_progress'})]}:run({status:'in_progress'})}),/timed out/);
  await assert.rejects(ensureValidation({sha:'not-a-sha',repository,api:async()=>{throw Error('must not call');}}),/SHA/);
  await assert.rejects(githubClient({token:'fake',repository,fetcher:async()=>new Response('',{status:403})})('/actions/runs'),/403/);
});
test('workflow wiring preserves isolation, manual deploy, exact gate and parallel browser matrix',async()=>{
  const read=p=>readFile('.github/workflows/'+p+'.yml','utf8');const [pages,prod,ci]=await Promise.all(['pages-preview','production-deploy','branch-validation'].map(read));
  assert.doesNotMatch(pages,/Require full branch CI|CLOUDFLARE|wrangler deploy/);assert.match(pages,/ci-smoke.spec.js/);assert.match(pages,/pages-public-build.test.js/);
  assert.match(prod,/workflow_dispatch:/);assert.doesNotMatch(prod,/^\s*(push|schedule|pull_request):/m);assert.match(prod,/needs: validate/);assert.match(prod,/--keep-vars/);
  assert.equal((prod.match(/npx wrangler deploy/g)??[]).length,1);
  assert.match(ci,/fail-fast: false/);for(const name of ['desktop-chrome','android-chrome','iphone-webkit'])assert.ok(ci.includes(name));
  assert.match(ci,/if: needs.plan.outputs.migrations == 'true'/);
  for(const w of [ci,pages,prod])assert.doesNotMatch(w,/node-version: ["']22["']/);
});
