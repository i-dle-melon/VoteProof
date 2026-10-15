// Real frontend + real local Worker/D1/R2; every browser request stays local.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { localAdminRuntime } from "./lib/local-admin-runtime.mjs";
import { frontendServer } from "./lib/frontend-server.mjs";
const h = await localAdminRuntime({ directIntent: true }),
  l = h.local,
  origin = "https://voteproof.example";
let server,
  browser,
  checks = 0;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=",
  "base64",
);
try {
  await l.db
    .prepare(
      "UPDATE campaigns SET points_per_proof=10,daily_limit=NULL WHERE campaign_id='LOCAL-TEST'",
    )
    .run();
  const member = await h.identity(),
    admin = await h.identity({ role: "admin" });
  server = await frontendServer();
  browser = await chromium.launch({ channel: "chrome" });
  async function surface(actor, { lostPut = false, lostCase = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }),
      page = await context.newPage(),
      requests = [],
      errors = [];
    let putLost = false,
      caseLost = false;
    if (actor)
      await context.addCookies([
        {
          name: "__Host-vp-session",
          value: actor.token,
          url: origin,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.hostname === "challenges.cloudflare.com")
        return route.fulfill({
          contentType: "text/javascript",
          body: "let i=0;const widgets=new Map();globalThis.turnstile={render(container,opts){const id=String(i++);widgets.set(id,opts);queueMicrotask(()=>opts.callback('synthetic-local'));return id;},reset(id){queueMicrotask(()=>widgets.get(id).callback('synthetic-local'));}};",
        });
      if (url.origin !== origin) {
        errors.push("Unexpected browser upstream: " + url.origin);
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) {
        const response = await context.request.get(server.base + url.pathname);
        return route.fulfill({ response });
      }
      const response = await l.runtime.dispatchFetch(request.url(), {
        method: request.method(),
        headers: request.headers(),
        ...(["GET", "HEAD"].includes(request.method()) ? {} : { body: request.postDataBuffer() }),
      });
      requests.push({
        path: url.pathname,
        status: response.status,
        body: request.postData(),
        key: request.headers()["idempotency-key"],
      });
      if (lostPut && !putLost && url.pathname.startsWith("/api/uploads/put/")) {
        putLost = true;
        assert.equal(response.status, 200);
        return route.abort();
      }
      if (lostCase && !caseLost && url.pathname === "/api/cases/direct") {
        caseLost = true;
        assert.equal(response.status, 201);
        return route.abort();
      }
      const headers = Object.fromEntries(response.headers),
        cookies = response.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies.join("\n");
      return route.fulfill({
        status: response.status,
        headers,
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    return { context, page, requests, errors };
  }
  async function submit(actor, direct, failures = {}) {
    const s = await surface(actor, failures),
      { page, requests } = s;
    await page.goto(origin + "/" + (direct ? "?upload-flow=direct" : "") + "#submit");
    await expect(page.locator("#submission-fields")).toBeEnabled();
    if (actor) await expect(page.locator("#submission-mode")).toHaveValue("member");
    await page
      .locator("#proof-images")
      .setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: png });
    await expect(page.locator("#image-list .image-item")).toHaveCount(1);
    await page.locator("#submit-button").click();
    if (failures.lostCase) {
      await expect(page.locator("#retry-note")).toBeVisible();
      await page.locator("#submit-button").click();
    }
    await expect(page.locator("#submission-success")).toBeVisible();
    const creates = requests.filter(
      (x) => x.path === (direct ? "/api/cases/direct" : "/api/cases"),
    );
    assert.equal(creates.length, failures.lostCase ? 2 : 1);
    assert.ok(creates.every((x) => x.status === 201));
    if (failures.lostCase) {
      assert.equal(creates[0].body, creates[1].body);
      assert.equal(creates[0].key, creates[1].key);
    }
    assert.equal(requests.filter((x) => x.path.startsWith("/api/uploads/put/")).length, 1);
    assert.equal(requests.filter((x) => x.path === "/api/uploads/complete").length, direct ? 0 : 1);
    const ref = JSON.parse(creates[0].body).upload_session;
    const row = await l.db
      .prepare(
        "SELECT case_id,member_id FROM cases WHERE " +
          (direct ? "upload_intent_id" : "upload_session_id") +
          "=?",
      )
      .bind(ref.session_id)
      .first();
    assert.ok(row);
    assert.equal(row.member_id, actor?.memberId ?? null);
    if (direct) {
      assert.equal(
        (
          await l.db
            .prepare("SELECT count(*) n FROM completed_uploads WHERE session_id=?")
            .bind(ref.session_id)
            .first()
        ).n,
        0,
      );
    }
    assert.deepEqual(s.errors, []);
    checks++;
    return { ...s, caseId: row.case_id };
  }
  const guest = await submit(undefined, true);
  await guest.context.close();
  const owned = await submit(member, true, { lostPut: true, lostCase: true });
  await owned.page.goto(origin + "/?upload-flow=direct#lookup");
  await owned.page.locator("#owned-cases button").first().click();
  await expect(owned.page.locator("#owned-case-detail")).toBeVisible();
  await owned.page.keyboard.press("Escape");
  await expect(owned.page.locator("#owned-case-detail")).not.toBeVisible();
  checks++;
  await owned.context.close();
  const legacy = await submit(undefined, false);
  await legacy.context.close();
  const s = await surface(admin),
    page = s.page;
  await page.goto(origin + "/#admin");
  const card = page.locator(`.admin-case-row[data-case-id="${owned.caseId}"]`);
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator(".album-photo img")).toBeVisible();
  await card.locator(".case-preview").click();
  await expect(card.locator(".inline-review .admin-proof-grid img")).toBeVisible();
  assert.equal(
    await card.locator(".inline-review").getByText("SHA-256", { exact: false }).count(),
    0,
  );
  await card.locator('.inline-review select[name="action"]').selectOption("approve");
  await card.locator('.inline-review button[type="submit"]').click();
  await expect(card.locator(".inline-review")).toHaveCount(0);
  assert.equal(
    (
      await l.db
        .prepare("SELECT points_awarded FROM cases WHERE case_id=?")
        .bind(owned.caseId)
        .first()
    ).points_awarded,
    10,
  );
  checks++;
  for (const theme of ["dark", "light"])
    for (const width of [320, 390, 430, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${theme}/${width} overflow`,
      );
    }
  checks++;
  assert.deepEqual(s.errors, []);
  assert.equal(l.unexpectedUpstreams.length, 0);
  await s.context.close();
  console.log(
    `Direct intent browser smoke: ${checks} scenarios PASS (guest/member/legacy, PUT+Case lost ACK, owned modal, Admin gallery/private image/review/points, 320/390/430/1440 dark+light). CPU NOT MEASURED; no cloud calls.`,
  );
} finally {
  await browser?.close();
  await server?.close();
  await l.runtime.dispose();
}
