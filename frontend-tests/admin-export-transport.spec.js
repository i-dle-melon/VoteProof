import { test, expect } from "./isolated-ui-fixture.mjs";
import { adminFixture } from "./admin-fixture.mjs";
import { png } from "./member-fixture.mjs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
async function fixture(page, { direct = false, packages = 1, shared = false } = {}) {
  const auth = await adminFixture(page);
  await page.addInitScript(
    ({ direct }) => {
      if (!direct) {
        Object.defineProperty(window, "showSaveFilePicker", {
          value: undefined,
          configurable: true,
        });
        return;
      }
      window.__exportWrites = [];
      window.__exportClosed = false;
      window.__exportAborted = false;
      window.showSaveFilePicker = async () => ({
        createWritable: async () => ({
          write: async (bytes) => window.__exportWrites.push(Array.from(bytes)),
          close: async () => (window.__exportClosed = true),
          abort: async () => (window.__exportAborted = true),
        }),
      });
    },
    { direct },
  );
  const id = randomUUID(),
    files = Array.from({ length: 3 }, () => ({
      case_id: auth.caseId,
      file_id: randomUUID(),
      created_at: "2026-10-14T04:00:00.000Z",
      campaign_id: "LOCAL",
      campaign_name: "本機假活動",
      vote_type: "Solo",
      source: "member",
      review_status: "approved",
      review_stage: "initial",
      content_type: "image/png",
      file_size: png.length,
      etag: "fake",
    }));
  const state = {
    proofs: 0,
    failProof: false,
    slow: false,
    ackFailures: 0,
    failQuery: false,
    jobs: [],
    calls: [],
    claims: new Map(),
  };
  const reply = (route, data, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(
        status === 200 ? { ok: true, data } : { ok: false, error: { code: data } },
      ),
    });
  await page.route("**/api/admin/image-exports**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      b = req.postData() ? req.postDataJSON() : null;
    state.calls.push({ path, method: req.method(), body: b });
    if (path.endsWith("/query"))
      return state.failQuery
        ? reply(route, "ADMIN_SERVICE_UNAVAILABLE", 503)
        : reply(route, { image_count: 3, total_bytes: png.length * 3 });
    if (path === "/api/admin/image-exports") return reply(route, { jobs: state.jobs });
    if (path.endsWith("/jobs")) {
      const j = {
        id: b.job_id,
        filters: b.filters,
        image_count: 3,
        total_bytes: png.length * 3,
        created_at: "2026-10-14T04:00:00.000Z",
        packages: Array.from({length:packages},(_,i)=>(
          {
            number: i+1,
            image_count: 3,
            total_bytes: png.length * 3,
            status: "planned",
            attempt_id: null,
          }
        )),
      };
      state.jobs.unshift(j);
      return reply(route, j);
    }
    const job = state.jobs.find((j) => path.includes(j.id));
    if (!job) return reply(route, "EXPORT_NOT_FOUND", 404);
    const number=Number(path.match(/\/packages\/(\d+)/)?.[1]??1),p=job.packages[number-1];
    if (path.endsWith("/start")) {
      const readOnly=p.status==='completed';
      if(shared&&readOnly)state.claims.set(p.number,b.attempt_id);
      if(!readOnly){p.status = "in_progress";p.attempt_id = b.attempt_id;}
      return reply(route, { package: p, items: files,read_only:readOnly,...(shared?{download_attempt_id:b.attempt_id}:{}) });
    }
    if (path.includes("/files/")) {
      state.proofs++;
      if (state.slow) await new Promise((resolve) => setTimeout(resolve, 1000));
      if (state.failProof) return reply(route, "PROOF_NOT_FOUND", 404);
      return route.fulfill({
        contentType: "image/png",
        headers: { "Content-Length": String(png.length) },
        body: png,
      });
    }
    if (path.endsWith("/state")) {
      if(b.status==='completed'&&b.confirmed!==true)return reply(route,'INVALID_EXPORT_QUERY',400);
      if (b.status === "completed" && state.ackFailures-- > 0)
        return reply(route, "ADMIN_SERVICE_UNAVAILABLE", 503);
      if(shared&&p.status==='completed'){
        if(state.claims.get(p.number)!==b.attempt_id)return reply(route,'EXPORT_PACKAGE_CONFLICT',409);
        state.claims.delete(p.number);return reply(route,p);
      }
      p.status = b.status;
      return reply(route, p);
    }
    return reply(route, job);
  });
  await page.goto("/#admin");
  await page
    .locator("#admin-tabs")
    .getByRole("button", { name: "圖片批次匯出", exact: true })
    .click();
  await expect(page.locator("#admin-panel")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "查詢並規劃下載包" }).click();
  await expect(page.locator('[data-package="1"]')).toBeVisible();
  return state;
}
const download = (page) =>
  page.locator('[data-package="1"]').getByRole("button", { name: "下載", exact: true });
test("real Worker transport: private proof fetch then valid ZIP, completed reload", async ({
  page,
}) => {
  const state = await fixture(page),
    event = page.waitForEvent("download");
  await download(page).click();
  const file = await event;
  const zip = unzipSync(new Uint8Array(await readFile(await file.path())));
  expect(Object.keys(zip)).toHaveLength(4);
  await expect(page.locator("[data-export-state]")).toHaveAttribute(
    "data-export-state",
    "completed",
  );
  expect(state.proofs).toBe(3);
  await page.reload();
  await page
    .locator("#admin-tabs")
    .getByRole("button", { name: "圖片批次匯出", exact: true })
    .click();
  await expect(page.locator("[data-export-state]")).toHaveAttribute(
    "data-export-state",
    "completed",
  );
});
test("missing proof fails without download, retry succeeds", async ({ page }) => {
  const state = await fixture(page);
  state.failProof = true;
  let count = 0;
  page.on("download", () => count++);
  await download(page).click();
  await expect(page.locator("[data-export-state]")).toHaveAttribute("data-export-state", "failed");
  expect(count).toBe(0);
  await expect(page.locator(".image-export")).toContainText("1 個檔案無法取得");
  state.failProof = false;
  const retried=page.waitForEvent("download");
  await page.getByRole("button", { name: "重新下載", exact: true }).click();
  await expect(page.locator("[data-export-state]")).toHaveAttribute(
    "data-export-state",
    "completed",
  );
  const retriedFile=await retried;expect(await retriedFile.failure()).toBe(null);
  expect(Object.keys(unzipSync(new Uint8Array(await readFile(await retriedFile.path()))))).toHaveLength(4);
  expect(count).toBe(1);
});
test("cancel aborts proof transfer and does not complete", async ({ page }) => {
  const state = await fixture(page);
  state.slow = true;
  await download(page).click();
  await expect(page.locator("#export-progress")).toContainText("下載圖片");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator("[data-export-state]")).toHaveAttribute("data-export-state", "failed");
  expect(state.calls.filter((c) => c.path.endsWith("/state"))).toHaveLength(1);
});
test("lost complete acknowledgment retries only metadata, never re-downloads", async ({ page }) => {
  const state = await fixture(page);
  state.ackFailures = 1;
  await download(page).click();
  await expect(page.getByRole("button", { name: "重送完成確認" })).toBeVisible();
  const n = state.proofs;
  await page.getByRole("button", { name: "重送完成確認" }).click();
  await expect(page.locator("[data-export-state]")).toHaveAttribute(
    "data-export-state",
    "completed",
  );
  expect(state.proofs).toBe(n);
});
test("lost acknowledgement stays bound to original job after a new query", async ({ page }) => {
  const state = await fixture(page);
  state.ackFailures = 1;
  await download(page).click();
  await expect(page.getByRole("button", { name: "重送完成確認" })).toBeVisible();
  const original = state.jobs[0],
    n = state.proofs;
  await page.getByRole("button", { name: "查詢並規劃下載包" }).click();
  await expect(page.locator("[data-export-state]")).toHaveAttribute("data-export-state", "planned");
  await page.getByRole("button", { name: "重送完成確認" }).click();
  await expect.poll(() => original.packages[0].status).toBe("completed");
  expect(state.jobs[0].packages[0].status).toBe("planned");
  expect(state.proofs).toBe(n);
});
test("direct file writer applies chunks and closes only after complete ZIP", async ({ page }) => {
  const state = await fixture(page, { direct: true });
  await expect(page.locator("#export-package_bytes")).toHaveValue(String(512 * 1024 ** 2));
  await download(page).click();
  await expect(page.locator("[data-export-state]")).toHaveAttribute(
    "data-export-state",
    "completed",
  );
  const saved = await page.evaluate(() => ({
    chunks: window.__exportWrites,
    closed: window.__exportClosed,
    aborted: window.__exportAborted,
  }));
  expect(saved.closed).toBe(true);
  expect(saved.aborted).toBe(false);
  const bytes = Uint8Array.from(saved.chunks.flat());
  expect(Object.keys(unzipSync(bytes))).toHaveLength(4);
  expect(state.proofs).toBe(3);
});
test("reviewer sees bulk export with only review tabs", async ({ page }) => {
  await adminFixture(page, { role: "reviewer" });
  await page.goto("/#admin");
  await expect(page.locator("#admin-tabs button")).toHaveCount(3);
  await expect(
    page.locator("#admin-tabs").getByRole("button", { name: "圖片批次匯出" }),
  ).toHaveCount(1);
});

async function actualZIP(page,click){
 const event=page.waitForEvent('download');await click();const file=await event;
 expect(await file.failure()).toBe(null);const zip=unzipSync(new Uint8Array(await readFile(await file.path())));
 expect(Object.keys(zip)).toHaveLength(4);return {file,zip};
}
test('actual Blob completed re-download preserves attempt and server completion; URL remains live',async({page})=>{
 const state=await fixture(page);const first=await actualZIP(page,()=>download(page).click());
 await expect(page.locator('[data-export-state]')).toHaveAttribute('data-export-state','completed');
 const before=structuredClone(state.jobs[0].packages[0]),writes=state.calls.filter(c=>c.path.endsWith('/state')).length;
 const second=await actualZIP(page,()=>page.getByRole('button',{name:'再次下載',exact:true}).click());
 expect(second.zip).toEqual(first.zip);expect(state.jobs[0].packages[0]).toEqual(before);expect(state.calls.filter(c=>c.path.endsWith('/state'))).toHaveLength(writes);expect(state.proofs).toBe(6);
});
test('actual Blob completed retry failure and cancel leave no orphan state or extra download',async({page})=>{
 const state=await fixture(page);await actualZIP(page,()=>download(page).click());await expect(page.locator('[data-export-state]')).toHaveAttribute('data-export-state','completed');
 const before=structuredClone(state.jobs[0].packages[0]),writes=state.calls.filter(c=>c.path.endsWith('/state')).length;let downloads=0;page.on('download',()=>downloads++);
 state.failProof=true;await page.getByRole('button',{name:'再次下載',exact:true}).click();await expect(page.locator('.image-export')).toContainText('再次下載未完成');expect(state.jobs[0].packages[0]).toEqual(before);
 state.failProof=false;state.slow=true;await page.getByRole('button',{name:'再次下載',exact:true}).click();await expect(page.locator('#export-progress')).toContainText('下載圖片');await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('.image-export')).toContainText('再次下載已取消');
 expect(state.jobs[0].packages[0]).toEqual(before);expect(state.calls.filter(c=>c.path.endsWith('/state'))).toHaveLength(writes);expect(downloads).toBe(0);await expect(page.locator('#export-progress')).toHaveCount(0);
});
test('actual Blob batch-all produces separate sequential ZIPs with one real Worker and operator policy hint',async({page})=>{
 await page.addInitScript(()=>{const Original=window.Worker;window.__zipWorkers={active:0,max:0};window.Worker=class extends Original{constructor(...args){super(...args);window.__zipWorkers.max=Math.max(window.__zipWorkers.max,++window.__zipWorkers.active);}terminate(){window.__zipWorkers.active--;return super.terminate();}};});
 const state=await fixture(page,{packages:3}),downloads=[];state.jobs[0].packages[1].status='completed';state.jobs[0].packages[1].attempt_id=randomUUID();const completedBefore=structuredClone(state.jobs[0].packages[1]);page.on('download',file=>downloads.push(file));
 await page.getByRole('button',{name:'批次全下載',exact:true}).click();await expect(page.locator('[data-export-state="completed"]')).toHaveCount(3);await expect.poll(()=>downloads.length).toBe(3);
 for(const file of downloads){expect(await file.failure()).toBe(null);const zip=unzipSync(new Uint8Array(await readFile(await file.path())));expect(Object.keys(zip)).toHaveLength(4);}
 expect(new Set(downloads.map(d=>d.suggestedFilename())).size).toBe(3);expect(state.proofs).toBe(9);expect(state.jobs[0].packages[1]).toEqual(completedBefore);expect(state.calls.filter(c=>c.path.endsWith('/state')).map(c=>Number(c.path.match(/\/packages\/(\d+)/)[1]))).toEqual([1,3]);expect(await page.evaluate(()=>window.__zipWorkers)).toEqual({active:0,max:1});
 expect(state.calls.filter(c=>c.path.endsWith('/start')).map(c=>Number(c.path.match(/\/packages\/(\d+)/)[1]))).toEqual([1,2,3]);await expect(page.locator('.image-export')).toContainText('瀏覽器可能要求允許多個檔案下載');expect(state.calls.every(c=>!c.path.includes('combined'))).toBe(true);
});

// The legacy fixtures above intentionally omit download_attempt_id. Shared V2
// leases require ACKs, but these must never mutate the original completed row.
test('shared V2 re-download failure, cancel, success and lost ACK preserve completed package',async({page})=>{
 const state=await fixture(page,{shared:true});await actualZIP(page,()=>download(page).click());await expect(page.locator('[data-export-state]')).toHaveAttribute('data-export-state','completed');
 const before=structuredClone(state.jobs[0].packages[0]);
 state.failProof=true;await page.getByRole('button',{name:'再次下載',exact:true}).click();await expect(page.locator('.image-export')).toContainText('再次下載未完成');expect(state.claims.size).toBe(0);expect(state.jobs[0].packages[0]).toEqual(before);
 state.failProof=false;state.slow=true;await page.getByRole('button',{name:'再次下載',exact:true}).click();await expect(page.locator('#export-progress')).toContainText('下載圖片');await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('.image-export')).toContainText('再次下載已取消');expect(state.claims.size).toBe(0);expect(state.jobs[0].packages[0]).toEqual(before);
 state.slow=false;state.ackFailures=1;await actualZIP(page,()=>page.getByRole('button',{name:'再次下載',exact:true}).click());await expect(page.getByRole('button',{name:'重送完成確認'})).toBeVisible();expect(state.jobs[0].packages[0]).toEqual(before);const reads=state.proofs;await page.getByRole('button',{name:'重送完成確認'}).click();await expect(page.getByRole('button',{name:'重送完成確認'})).toHaveCount(0);expect(state.proofs).toBe(reads);expect(state.claims.size).toBe(0);expect(state.jobs[0].packages[0]).toEqual(before);
 const reports=state.calls.filter(c=>c.path.endsWith('/state'));expect(reports.map(c=>c.body.status)).toEqual(['completed','failed','failed','completed','completed']);expect(reports.filter(c=>c.body.status==='completed').every(c=>c.body.confirmed===true)).toBe(true);expect(reports.slice(1).every(c=>c.body.attempt_id!==before.attempt_id)).toBe(true);
});

test('shared V2 batch-all releases redownload leases and reports every package exactly once',async({page})=>{
 const state=await fixture(page,{packages:3,shared:true});state.jobs[0].packages[1].status='completed';state.jobs[0].packages[1].attempt_id=randomUUID();const before=structuredClone(state.jobs[0].packages[1]);
 await page.getByRole('button',{name:'批次全下載',exact:true}).click();await expect(page.locator('.image-export')).toContainText('全部套件已依序產生');expect(state.jobs[0].packages.every(p=>p.status==='completed')).toBe(true);expect(state.jobs[0].packages[1]).toEqual(before);expect(state.claims.size).toBe(0);
 expect(state.calls.filter(c=>c.path.endsWith('/state')).map(c=>Number(c.path.match(/packages\/(\d+)/)[1]))).toEqual([1,2,3]);expect(state.calls.filter(c=>c.path.endsWith('/state')).every(c=>c.body.confirmed===true)).toBe(true);
});
