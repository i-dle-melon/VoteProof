import { test, expect } from "@playwright/test";
import { adminFixture } from "./admin-fixture.mjs";
import { png } from "./member-fixture.mjs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
async function fixture(page, { direct = false } = {}) {
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
    state.calls.push({ path, method: req.method() });
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
        packages: [
          {
            number: 1,
            image_count: 3,
            total_bytes: png.length * 3,
            status: "planned",
            attempt_id: null,
          },
        ],
      };
      state.jobs.unshift(j);
      return reply(route, j);
    }
    const job = state.jobs.find((j) => path.includes(j.id));
    if (!job) return reply(route, "EXPORT_NOT_FOUND", 404);
    const p = job.packages[0];
    if (path.endsWith("/start")) {
      p.status = "in_progress";
      p.attempt_id = b.attempt_id;
      return reply(route, { package: p, items: files });
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
      if (b.status === "completed" && state.ackFailures-- > 0)
        return reply(route, "ADMIN_SERVICE_UNAVAILABLE", 503);
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
  await page.getByRole("button", { name: "重新下載", exact: true }).click();
  await expect(page.locator("[data-export-state]")).toHaveAttribute(
    "data-export-state",
    "completed",
  );
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
test("reviewer does not see bulk export entry", async ({ page }) => {
  await adminFixture(page, { role: "reviewer" });
  await page.goto("/#admin");
  await expect(page.locator("#admin-tabs button")).toHaveCount(2);
  await expect(
    page.locator("#admin-tabs").getByRole("button", { name: "圖片批次匯出" }),
  ).toHaveCount(0);
});
