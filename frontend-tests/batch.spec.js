import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { memberFixture, png } from "./member-fixture.mjs";

async function fixture(page, options = {}) {
  const member = await memberFixture(page, { authenticated: true, ...options });
  const sessions = new Map(), receipts = new Map(), puts = [], posts = [], prepares = [],capabilities=[],authorizations=[];
  let failedPut = false, lostCase = false;
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
    await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, body: "" });
  });
  await page.route("**/api/cases", async route => {
    const request = route.request(), body = request.postDataJSON(), key = request.headers()["idempotency-key"];
    posts.push({ body, serialized: request.postData(), key, headers: request.headers() });
    const index = sessions.get(body.upload_session.session_id);
    if (!receipts.has(key)) receipts.set(key, { case_id: "VP-20261012-" + "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[index].repeat(16),
      query_key: randomBytes(32).toString("base64url"), status: "pending" });
    if (options.partial && index === 2 && !lostCase) { lostCase = true; await route.abort(); return; }
    if (options.switchIdentity && index === 0) member.member = { ...member.member, member_id: "M-" + randomUUID() };
    await reply(route, receipts.get(key));
  });
  return { member, prepares, receipts, puts, posts,capabilities,authorizations };
}
async function form(page, count = 20) {
  await page.goto("/#submit"); await expect(page.locator("#submission-fields")).toBeEnabled();
  await page.locator("#proof-images").setInputFiles(Array.from({ length: count }, (_, index) => ({ name: `proof-${index}.png`, mimeType: "image/png", buffer: png })));
  await expect(page.locator("#image-list .image-item")).toHaveCount(count);
  await expect(page.locator("#challenge-status")).toHaveText("已完成人機驗證");
}

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

for(const authenticated of [false,true])test(`inventory Busy waits and resumes the ${authenticated?'member':'guest'} batch without another challenge`,async({page})=>{
  const state=await fixture(page,{authenticated,inventoryBusy:true});await form(page,3);await page.locator('#submit-button').click();
  await expect(page.locator('#progress-label')).toContainText('背景容量盤點');
  await expect(page.locator('#submission-success')).toBeVisible({timeout:15000});
  expect(state.authorizations.length).toBe(1);expect(state.prepares.length).toBe(3);
  expect(state.puts).toEqual([0,0,1,2]);expect(state.receipts.size).toBe(3);
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
  expect(state.posts[1].serialized).toBe(state.posts[3].serialized); expect(state.posts[1].key).toBe(state.posts[3].key);
  expect(state.posts.filter(post => post.key === state.posts[0].key).length).toBe(1);
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

test("account change between batch items stops before another member proof is prepared", async ({ page }) => {
  const state = await fixture(page, { switchIdentity: true }); await form(page, 3); await page.locator("#submit-button").click();
  await expect(page.locator("#retry-note")).toBeVisible();
  await expect(page.locator("#batch-summary")).toHaveText("共 3 張 · 已送出 1 · 未成功 1 · 等待 1");
  expect(state.prepares.length).toBe(1); expect(state.posts.length).toBe(1);
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
