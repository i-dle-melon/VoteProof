import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { memberFixture, png } from "./member-fixture.mjs";

async function fixture(page, options = {}) {
  const member = await memberFixture(page, { authenticated: true, ...options });
  const sessions = new Map(), receipts = new Map(), puts = [], posts = [], prepares = [],capabilities=[],authorizations=[];
  let failedPut = false, lostCase = false;
  let releaseIdentityChange;
  const identityChanged = new Promise(resolve => { releaseIdentityChange = resolve; });
  const changeIdentity = () => {
    member.member = { ...member.member, member_id: "M-" + randomUUID() };
    releaseIdentityChange();
  };
  const reply = (route, data) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  await page.route('**/api/uploads/batch/authorize',route=>{
    const body=route.request().postDataJSON();authorizations.push({body,headers:route.request().headers()});
    return reply(route,{tickets:body.files.map(()=>randomBytes(48).toString('base64url')),expires_in:300});
  });
  await page.route("**/api/uploads/prepare", route => {
    const body = route.request().postDataJSON(); prepares.push(body);
    const session_id = randomUUID(), index = sessions.size; sessions.set(session_id, index);
    const capability=member.authenticated?null:randomBytes(32).toString('base64url');capabilities.push(capability);
    return reply(route, { storage_version:2,session_id,...(capability?{capability}:{}), expires_in: 300, uploads: body.files.map(file => ({
      key: `proofs/final/${session_id}/${randomUUID()}.png`, method: "PUT", headers: { 'Content-Type':file.type,'X-Upload-Grant':randomBytes(48).toString('base64url') },
      upload_url: `http://127.0.0.1:4173/api/uploads/put/${session_id}/${randomUUID()}` })) });
  });
  await page.route('**/api/uploads/put/**', async route => {
    const index = sessions.get(new URL(route.request().url()).pathname.split('/')[4]); puts.push(index);
    if (options.inventoryBusy && index === 0 && !failedPut) {
      failedPut = true;
      await route.fulfill({status:503,contentType:'application/json',headers:{
        'X-VoteProof-Upload-Rejected':'1','X-VoteProof-Upload-Stage':'capacity_admission','X-VoteProof-Put-State':'not_started'},
        body:JSON.stringify({ok:false,error:{code:'R2_STORAGE_INVENTORY_BUSY'}})});return;
    }
    if (options.partial && index === 1 && !failedPut) { failedPut = true; await route.abort(); return; }
    // Admission/PUT is not permission to create a Case after an identity switch.
    if (options.switchIdentity === 'before_second_put_ack' && index === 1) await identityChanged;
    if(options.putWait)await options.putWait;
    await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, body: "" });
  });
  await page.route("**/api/cases", async route => {
    const request = route.request(), body = request.postDataJSON(), key = request.headers()["idempotency-key"];
    posts.push({ body, serialized: request.postData(), key, headers: request.headers() });
    const index = sessions.get(body.upload_session.session_id);
    if (!receipts.has(key)) receipts.set(key, { case_id: "VP-20261012-" + "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[index].repeat(16),
      query_key: randomBytes(32).toString("base64url"), status: "pending" });
    if (options.partial && index === 2 && !lostCase) { lostCase = true; await route.abort(); return; }
    if (options.switchIdentity === 'after_two_cases') {
      // Both requests must have passed their own member check before changing
      // identity. Do not infer that boundary from the first request's arrival.
      if (posts.length === 2) changeIdentity();
      await identityChanged;
    } else if (options.switchIdentity === 'before_second_put_ack' && index === 0) changeIdentity();
    await reply(route, receipts.get(key));
  });
  return { member, prepares, receipts, puts, posts,capabilities,authorizations,sessions };
}
async function form(page, count = 20) {
  await page.goto("/#submit"); await expect(page.locator("#submission-fields")).toBeEnabled();
  await page.locator("#proof-images").setInputFiles(Array.from({ length: count }, (_, index) => ({ name: `proof-${index}.png`, mimeType: "image/png", buffer: png })));
  await expect(page.locator("#image-list .image-item")).toHaveCount(count);
  await expect(page.locator("#challenge-status")).toHaveText("已完成人機驗證");
}

test('UAT mobile: active batch progress and case counts are actually inside the viewport',async({page},info)=>{
  let release;const putWait=new Promise(r=>release=r);const state=await fixture(page,{putWait});
  await page.setViewportSize({width:390,height:844});
  try {
    await form(page,20);await page.locator('#submit-button').click();
    await expect.poll(()=>state.puts.length).toBe(2);
    await expect(page.locator('#batch-counts')).toContainText('已成功建立 0 / 20 個案件');
    await page.screenshot({path:`.wrangler/frontend-previews/uat-visible-${info.project.name}.png`});
    await expect(page.locator('#progress-label')).toBeInViewport();
    await expect(page.locator('#batch-counts')).toBeInViewport();
    expect(state.authorizations).toHaveLength(1);
    expect(state.prepares.every(x=>x.batch_ticket&&!Object.hasOwn(x,'turnstile_token'))).toBe(true);
  } finally {release();}
});

for(const authenticated of [false,true])test(`UAT shared verification: ${authenticated?'member':'guest'} 20-image UI shows human verification only once`,async({page},info)=>{
  let authorizeRelease,putRelease;
  const authorizeWait=new Promise(r=>authorizeRelease=r),putWait=new Promise(r=>putRelease=r);
  const state=await fixture(page,{authenticated,putWait});
  await page.route('**/api/uploads/batch/authorize',async route=>{await authorizeWait;await route.fallback();});
  try {
    await form(page,20);
    await page.locator('#progress-label').evaluate(label=>{
      globalThis.__uatVerificationLabels=[];
      new MutationObserver(()=>{if(label.textContent.includes('人機驗證'))globalThis.__uatVerificationLabels.push(label.textContent);}).observe(label,{childList:true});
    });
    await page.locator('#submit-button').click();
    await expect(page.locator('#progress-label')).toHaveText('正在確認人機驗證（本批共用一次）…');
    await expect(page.locator('#batch-items')).not.toContainText('人機驗證');
    expect(state.prepares).toHaveLength(0);expect(state.puts).toHaveLength(0);
    authorizeRelease();await expect.poll(()=>state.puts.length).toBe(2);
    await expect(page.locator('#progress-label')).not.toContainText('人機驗證');
    await expect(page.locator('#batch-items')).not.toContainText('人機驗證');
    await page.screenshot({path:`.wrangler/frontend-previews/uat-shared-${authenticated?'member':'guest'}-${info.project.name}.png`});
    putRelease();await expect(page.locator('#submission-success')).toBeVisible();
    expect(state.authorizations).toHaveLength(1);expect(state.prepares).toHaveLength(20);
    expect(state.prepares.every(x=>x.batch_ticket&&!Object.hasOwn(x,'turnstile_token'))).toBe(true);
    expect(state.posts).toHaveLength(20);expect(state.receipts.size).toBe(20);
    expect(await page.evaluate(()=>globalThis.__uatVerificationLabels)).toEqual(['正在確認人機驗證（本批共用一次）…']);
  } finally {authorizeRelease();putRelease();}
});

test("20-image member batch creates 20 independent cases, status/receipts and mobile layouts", async ({ page }, testInfo) => {
  const state = await fixture(page); const errors = []; page.on("pageerror", error => errors.push(error.message));
  await form(page); await expect(page.locator("#submission-mode")).toHaveValue("member");
  await expect(page.locator("#submission-mode")).toBeHidden(); await page.locator("#submit-button").click();
  await expect(page.locator("#batch-summary")).toHaveText("共 20 張 · 已送出 20 · 未成功 0 · 等待 0");
  await expect(page.locator("#submission-success")).toBeVisible();
  await expect(page.locator("#batch-items .credentials")).toHaveCount(20);
  expect(state.prepares.length).toBe(20); expect(state.prepares.every((body,i) => body.files.length === 1 && body.storage_version===2 && body.campaign_id===state.posts[i].body.campaign_id)).toBe(true);
  expect(state.authorizations).toHaveLength(1);expect(state.authorizations[0].body.files).toHaveLength(20);
  expect(state.authorizations[0].headers['x-csrf-token']).toBe(state.member.csrf);
  expect(state.prepares.every(body=>typeof body.batch_ticket==='string'&&!Object.hasOwn(body,'turnstile_token'))).toBe(true);
  expect(state.posts.length).toBe(20); expect(new Set(state.posts.map(post => post.key)).size).toBe(20);
  expect(state.receipts.size).toBe(20); expect(new Set([...state.receipts.values()].map(row => row.case_id)).size).toBe(20);
  expect(state.posts.every(post => !Object.hasOwn(post.body, "member_id") && post.body.upload_session.keys.length === 1 && post.headers["x-csrf-token"] === state.member.csrf)).toBe(true);
  expect(await page.evaluate(() => globalThis.__transportFixture.filter(call => call.path === "/api/cases").every(call => call.credentials === "same-origin"))).toBe(true);
  expect(await page.evaluate(() => globalThis.__transportFixture.filter(call => /^\/api\/uploads\/(prepare|complete)$/.test(call.path)).every(call => call.credentials === "same-origin"))).toBe(true);
  await page.locator("#batch-query-info summary").click();await page.locator("#batch-copy").click();
  expect((await page.evaluate(() => globalThis.__copiedFixture)).match(/案件編號：/g).length).toBe(20);
  for (const width of [320, 390, 430]) for (const theme of ["dark", "light"]) {
    await page.setViewportSize({ width, height: 844 });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme-toggle").evaluate(button => button.click());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390 && theme === "dark") await page.screenshot({ path: `.wrangler/frontend-previews/batch-${testInfo.project.name}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(1); // theme preference only
});

test('one mobile click waits for delayed verification; focus/Gate refresh and duplicate submit never reset or duplicate it',async({page})=>{
 const state=await fixture(page,{authenticated:false});
 await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',route=>route.fulfill({contentType:'text/javascript',body:
  `globalThis.__resets=0;let o;globalThis.turnstile={render(_,v){o=v;return 'delayed';},reset(){globalThis.__resets++;}};globalThis.__verify=()=>o.callback('synthetic-fresh-once');`}));
 await page.goto('/#submit');await expect(page.locator('#submission-fields')).toBeEnabled();
 await page.locator('#proof-images').setInputFiles([{name:'one.png',mimeType:'image/png',buffer:png}]);
 await page.locator('#submit-button').click();await expect(page.locator('#submit-button')).toBeDisabled();
 // Disabled also covers the pre-submit Gate check. Resolve the synthetic
 // challenge only after the actual verification waiter has been registered.
 await expect(page.locator('#challenge-status')).toHaveText('請完成人機驗證，批次投稿會接著繼續。');
 await page.locator('#submission-form').evaluate(form=>{form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));window.dispatchEvent(new Event('focus'));});
 expect(state.prepares).toHaveLength(0);await page.evaluate(()=>globalThis.__verify());
 await expect(page.locator('#submission-success')).toBeVisible();expect(state.puts).toHaveLength(1);expect(state.posts).toHaveLength(1);expect(await page.evaluate(()=>globalThis.__resets)).toBe(0);
});

test('Complete failure resumes confirmed bytes on one click without PUT or another challenge',async({page})=>{
 const state=await fixture(page);let completes=0;
 await page.route('**/api/uploads/complete',route=>{
  completes++;return route.fulfill({status:completes===1?400:200,contentType:'application/json',body:JSON.stringify(completes===1?{ok:false,error:{code:'UPLOAD_INCOMPLETE'}}:{ok:true,data:{}})});
 });
 await form(page,1);await page.locator('#submit-button').click();await expect(page.locator('#retry-note')).toBeVisible();
 await expect(page.locator('.upload-completion-hint')).toBeVisible();expect(state.puts).toHaveLength(1);expect(state.posts).toHaveLength(0);
 await page.locator('#submit-button').click();await expect(page.locator('#submission-success')).toBeVisible();
 expect(completes).toBe(2);expect(state.puts).toHaveLength(1);expect(state.posts).toHaveLength(1);expect(state.prepares).toHaveLength(1);
});

test('one tap during foreground Gate refresh waits; a fresh OFF still prevents every write',async({page})=>{
 const state=await fixture(page);await form(page,3);let release,entered;
 const pending=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 await page.route('**/api/submissions/status',async route=>{entered();await pending;await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:{submissions_enabled:false,submissions_message:'暫停'}})});});
 try{
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await started;
  await page.locator('#submit-button').click();await expect(page.locator('#submit-button')).toBeDisabled();expect(state.prepares).toHaveLength(0);
  release();await expect(page.locator('#submit-state')).toHaveText('目前暫停投稿');await expect(page.locator('#submit-button')).toBeDisabled();
  expect(state.authorizations).toHaveLength(0);expect(state.puts).toHaveLength(0);expect(state.posts).toHaveLength(0);await expect(page.locator('#image-list .image-item')).toHaveCount(3);
 }finally{release();}
});

test('UNKNOWN remains a warning and confirmation-only retry never uploads again',async({page})=>{
 const state=await fixture(page);let missing=true;
 await page.route('**/api/uploads/put/**',async route=>{state.puts.push(0);await route.abort();});
 await page.route('**/api/uploads/complete',route=>route.fulfill({status:missing?400:200,contentType:'application/json',body:JSON.stringify(missing?{ok:false,error:{code:'UPLOAD_INCOMPLETE'}}:{ok:true,data:{}})}));
 await form(page,1);await page.locator('#submit-button').click();await expect(page.locator('#batch-counts')).toContainText('結果待確認：1');
 await expect(page.locator('#batch-items [data-state="unknown"]')).toContainText('不會直接重新傳送');
 await page.locator('#submit-button').click();await expect(page.locator('#submit-button')).toBeEnabled();expect(state.puts).toHaveLength(1);expect(state.posts).toHaveLength(0);
 missing=false;await page.locator('#submit-button').click();await expect(page.locator('#submission-success')).toBeVisible();expect(state.puts).toHaveLength(1);expect(state.receipts.size).toBe(1);
});

test('20 pending images keep stable DOM, truthful sub-100 progress and mobile layout',async({page},info)=>{
 let release;const wait=new Promise(r=>release=r);const state=await fixture(page,{putWait:wait});
 try{
  await form(page,20);await page.locator('#submit-button').click();await expect.poll(()=>state.puts.length).toBe(2);
  await expect(page.locator('#batch-items .batch-item')).toHaveCount(20);await expect(page.locator('#batch-counts')).toContainText('處理中：2');
  await page.locator('#batch-items .batch-item').first().evaluate(row=>{globalThis.__firstRow=row;});
  expect(await page.locator('#progress').evaluate(p=>p.value)).toBeLessThan(100);await expect(page.locator('.upload-completion-hint')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`.wrangler/frontend-previews/batch-inflight-${info.project.name}.png`,fullPage:true});
  release();await expect(page.locator('#submission-success')).toBeVisible();
  expect(await page.locator('#batch-items .batch-item').first().evaluate(row=>row===globalThis.__firstRow)).toBe(true);
  expect(state.posts).toHaveLength(20);await expect(page.locator('#batch-title')).toHaveText('本次投稿全部完成');
 }finally{release();}
});

for(const authenticated of [false,true])test(`inventory Busy waits and resumes the ${authenticated?'member':'guest'} batch without another challenge`,async({page})=>{
  const state=await fixture(page,{authenticated,inventoryBusy:true});await form(page,3);await page.locator('#submit-button').click();
  await expect(page.locator('#progress-label')).toContainText('背景容量盤點');
  await expect(page.locator('#submission-success')).toBeVisible({timeout:15000});
  expect(state.authorizations.length).toBe(1);expect(state.prepares.length).toBe(3);
  expect(state.puts.filter(i=>i===0)).toHaveLength(2);expect(state.puts.filter(i=>i===1)).toHaveLength(1);expect(state.puts.filter(i=>i===2)).toHaveLength(1);expect(state.receipts.size).toBe(3);
  expect(new Set(state.posts.map(p=>p.key)).size).toBe(3);expect(state.posts.length).toBe(3);
});

test("partial batch keeps successes and retries only failed PUT/lost case items", async ({ page }) => {
  const state = await fixture(page, { partial: true }); await form(page, 3); await page.locator("#submit-button").click();
  await expect(page.locator("#retry-note")).toBeVisible();
  await expect(page.locator("#batch-summary")).toHaveText("共 3 張 · 已送出 1 · 未成功 2 · 等待 0");
  await expect(page.locator("#batch-items .credentials")).toHaveCount(1);
  await page.locator("#submit-button").click(); await expect(page.locator("#submission-success")).toBeVisible();
  await expect(page.locator("#batch-items .credentials")).toHaveCount(3);
  // Aborted transport is UNKNOWN. Mock Complete verifies the original bytes;
  // the client must not resend that PUT just because the response was lost.
  expect(state.prepares.length).toBe(3); expect(state.puts).toEqual([0, 1, 2]);
  expect(state.posts.length).toBe(4); expect(state.receipts.size).toBe(3);
  const groups=[...state.receipts.keys()].map(key=>state.posts.filter(p=>p.key===key));
  expect(groups.map(g=>g.length).sort()).toEqual([1,1,2]);
  const replay=groups.find(g=>g.length===2);expect(replay[0].serialized).toBe(replay[1].serialized);
});

test('guest final upload carries its capability only in the request body and keeps anonymous identity',async({page})=>{
  const state=await fixture(page,{authenticated:false});await form(page,1);await page.locator('#submit-button').click();
  await expect(page.locator('#batch-summary')).toHaveText('共 1 張 · 已送出 1 · 未成功 0 · 等待 0');
  expect(state.posts[0].body.upload_session.capability).toBe(state.capabilities[0]);
  expect(state.posts[0].body).not.toHaveProperty('member_id');expect(state.posts[0].body).not.toHaveProperty('player_id');expect(state.posts[0].body).not.toHaveProperty('nickname');
  expect(await page.evaluate(()=>globalThis.__transportFixture.filter(c=>/^\/api\/(uploads\/(prepare|complete)|cases)$/.test(c.path)).every(c=>c.credentials==='omit'))).toBe(true);
  expect(page.url()).not.toContain(state.capabilities[0]);
  expect(await page.evaluate(cap=>[...Object.values(localStorage),...Object.values(sessionStorage)].some(v=>v.includes(cap)),state.capabilities[0])).toBe(false);
});

test("fresh OFF blocks all 20 selected images without any upload or new case", async ({ page }) => {
  const state = await fixture(page); await form(page);
  await page.route("**/api/submissions/status", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { submissions_enabled: false, submissions_message: "暫停" } }) }));
  await page.locator("#submit-button").click(); await expect(page.locator("#submit-button")).toBeDisabled();
  await expect(page.locator("#image-list .image-item")).toHaveCount(20);
  expect(state.prepares).toEqual([]); expect(state.puts).toEqual([]); expect(state.posts).toEqual([]);
});

test("account change after two Case checks retains both receipts and stops new lanes", async ({ page }) => {
  const state = await fixture(page, { switchIdentity: 'after_two_cases' }); await form(page, 3); await page.locator("#submit-button").click();
  await expect(page.locator("#retry-note")).toBeVisible();
  await expect(page.locator("#batch-summary")).toHaveText("共 3 張 · 已送出 2 · 未成功 1 · 等待 0");
  expect(state.prepares).toHaveLength(2); expect(state.posts).toHaveLength(2);
  expect([...state.puts].sort()).toEqual([0, 1]);
  expect(state.receipts.size).toBe(2); expect(new Set(state.posts.map(p=>p.key)).size).toBe(2);
  expect(new Set(state.posts.map(p=>p.body.upload_session.session_id)).size).toBe(2);
  expect(state.posts.every(p=>state.sessions.has(p.body.upload_session.session_id) &&
    p.body.upload_session.keys.length===1 && p.body.upload_session.keys[0].startsWith(`proofs/final/${p.body.upload_session.session_id}/`))).toBe(true);
  expect(state.authorizations).toHaveLength(1);
  expect(state.prepares.every(p=>p.batch_ticket&&!Object.hasOwn(p,'turnstile_token'))).toBe(true);
  expect(new Set(state.prepares.map(p=>p.batch_ticket)).size).toBe(2);
  await expect(page.locator('#batch-items .credentials')).toHaveCount(2);
  expect(state.posts.every(p=>p.headers['x-csrf-token']===state.member.csrf)).toBe(true);
});

test('account change before second PUT ACK retains one receipt and blocks the second Case',async({page})=>{
  const state=await fixture(page,{switchIdentity:'before_second_put_ack'});await form(page,3);await page.locator('#submit-button').click();
  await expect(page.locator('#retry-note')).toBeVisible();
  await expect(page.locator('#batch-summary')).toHaveText('共 3 張 · 已送出 1 · 未成功 2 · 等待 0');
  expect(state.prepares).toHaveLength(2);expect([...state.puts].sort()).toEqual([0,1]);
  expect(state.posts).toHaveLength(1);expect(state.receipts.size).toBe(1);
  const post=state.posts[0];expect(state.sessions.get(post.body.upload_session.session_id)).toBe(0);
  expect(post.body.upload_session.keys).toHaveLength(1);
  expect(post.body.upload_session.keys[0]).toMatch(new RegExp(`^proofs/final/${post.body.upload_session.session_id}/`));
  expect(post.key).toMatch(/^[0-9a-f]{64}$/);expect(state.receipts.has(post.key)).toBe(true);
  expect(post.headers['x-csrf-token']).toBe(state.member.csrf);
  expect(state.authorizations).toHaveLength(1);expect(new Set(state.prepares.map(p=>p.batch_ticket)).size).toBe(2);
  expect(state.prepares.every(p=>p.batch_ticket&&!Object.hasOwn(p,'turnstile_token'))).toBe(true);
  await expect(page.locator('#batch-items .credentials')).toHaveCount(1);
  await expect(page.locator('#image-list .image-item')).toHaveCount(3);
  await expect(page.locator('#submission-error')).toContainText('登入身份已改變');
});

test("one interactive challenge authorizes the batch without reusing the consumed token", async ({ page }) => {
  const state = await fixture(page);
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", route => route.fulfill({ contentType: "text/javascript", body:
    "let options;globalThis.__batchResets=0;globalThis.turnstile={render(_,o){options=o;queueMicrotask(()=>o.callback('first-local-token'));return 'local';},reset(){globalThis.__batchResets++;}};globalThis.__batchVerification=()=>options.callback('second-local-token');" }));
  await form(page, 2); await page.locator("#submit-button").click();
  await expect(page.locator("#submission-success")).toBeVisible();
  expect(state.authorizations.map(a=>a.body.turnstile_token)).toEqual(['first-local-token']);
  expect(await page.evaluate(()=>globalThis.__batchResets)).toBe(0);
  expect(state.prepares).toHaveLength(2);expect(state.posts).toHaveLength(2);
  expect(state.prepares.every(body=>!Object.hasOwn(body,'turnstile_token')&&typeof body.batch_ticket==='string')).toBe(true);
});
test('classified duplicate and pending-hint receipts are not mislabeled as ordinary pending results',async({page})=>{
 const state=await fixture(page);const seen=new Map();
 await page.route(/\/api\/cases(?:\/direct)?$/,async route=>{const body=route.request().postDataJSON(),key=route.request().headers()['idempotency-key'];if(!seen.has(key)){const i=seen.size;seen.set(key,{case_id:'VP-20261031-'+('ABCDEFGH'[i]).repeat(16),query_key:randomBytes(32).toString('base64url'),status:i===0?'duplicate':'pending',exact_classification:{decision:i===0?'exact_duplicate':'pending_match'}});}return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:seen.get(key)})});});
 await form(page,2);await page.locator('#submit-button').click();await expect(page.locator('#batch-title')).toHaveText('本次投稿全部完成');
 await expect(page.locator('#batch-items')).toContainText('相同檔案已歸類重複，不重複計分');await expect(page.locator('#batch-items')).toContainText('疑似重複，等待人工審核');
 expect(seen.size).toBe(2);expect(state.authorizations).toHaveLength(1);await page.locator('#batch-items').scrollIntoViewIfNeeded();await page.screenshot({path:'.wrangler/frontend-previews/exact-classification-batch-'+test.info().project.name+'.png'});
});
