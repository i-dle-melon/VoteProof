import { test, expect } from "./isolated-ui-fixture.mjs";
import { randomUUID, randomBytes } from "node:crypto";
import { adminFixture } from "./admin-fixture.mjs";
import { memberFixture, png } from "./member-fixture.mjs";
const preview = "http://127.0.0.1:4174/VoteProof/";
const openCampaign = async (page) => {
  await page.goto("/admin#admin");
  await page.locator("#admin-tabs").getByRole("button", { name: "活動管理", exact: true }).click();
  await page.getByRole("button", { name: "建立活動", exact: true }).click();
};
async function fillCampaign(page, id = "NEW") {
  for (const [key, value] of [
    ["campaign_id", id],
    ["name", "Component campaign"],
    ["start_at", "2026-09-10T23:00"],
    ["end_at", "2026-10-20T22:59"],
    ["points_per_proof", "10"],
  ])
    await page.locator("#admin-field-" + key).fill(value);
  await page.locator("#admin-field-daily_mode").selectOption("unlimited");
}
test("Admin dropdown loads five backend targets, requires Solo target and saves yuqi ID", async ({
  page,
}) => {
  const state = await adminFixture(page);
  await openCampaign(page);
  await fillCampaign(page);
  const target = page.locator("select#admin-field-solo_target");
  await expect(target.locator("option")).toHaveCount(6);
  await expect(target).toHaveJSProperty("required", true);
  await page.getByRole("button", { name: "保存活動", exact: true }).click();
  expect(state.calls.some((c) => c.path === "/api/admin/campaigns" && c.method === "POST")).toBe(
    false,
  );
  await target.selectOption("yuqi");
  await page.getByRole("button", { name: "保存活動", exact: true }).click();
  await expect(page.locator("#admin-panel")).toContainText("Component campaign");
  expect(
    state.calls.find((c) => c.path === "/api/admin/campaigns" && c.method === "POST").body
      .solo_target,
  ).toBe("yuqi");
});
test("Admin group saves null and inactive targets are omitted; new registry entries need no frontend change", async ({
  page,
}) => {
  const state = await adminFixture(page);
  state.soloTargets[1].active = false;
  state.soloTargets.push({
    target_id: "future_artist",
    display_name: "Future label",
    active: true,
    sort_order: 6,
  });
  await openCampaign(page);
  await fillCampaign(page, "GROUP");
  await expect(page.locator("#admin-field-solo_target option[value=minnie]")).toHaveCount(0);
  await expect(page.locator("#admin-field-solo_target option[value=future_artist]")).toHaveText(
    "Future label",
  );
  await page.locator("#admin-field-category").selectOption("團體");
  await expect(page.locator("#admin-field-solo_target")).toBeHidden();
  await expect(page.locator("#admin-field-solo_target")).toBeDisabled();
  await page.getByRole("button", { name: "保存活動", exact: true }).click();
  await expect(page.locator("#admin-panel")).toContainText("Component campaign");
  expect(
    state.calls.find((c) => c.path === "/api/admin/campaigns" && c.method === "POST").body
      .solo_target,
  ).toBeNull();
});
for (const category of ["Solo", "團體"])
  test("public Direct submission sends Campaign only: " + category, async ({ page }) => {
    const state = await memberFixture(page, { authenticated: true }),
      calls = [];
    await page.route("**/api/submissions/status", (route) =>
      route.fulfill({
        json: {
          ok: true,
          data: { submissions_enabled: true, submissions_message: null, upload_flow: "direct" },
        },
      }),
    );
    await page.route("**/api/campaigns", (route) =>
      route.fulfill({
        json: {
          ok: true,
          data: {
            campaigns: [
              {
                campaign_id: "LOCAL",
                name: "Campaign only",
                category,
                status: "active",
                start_at: "2000-01-01T00:00:00Z",
                end_at: "2100-01-01T00:00:00Z",
                vote_start_date: "2000-01-01",
                vote_end_date: "2099-12-31",
                campaign_timezone: "UTC",
                points_per_proof: 10,
                daily_limit: null,
              },
            ],
          },
        },
      }),
    );
    await page.route("**/api/uploads/prepare", (route) => {
      calls.push({ path: "/prepare", body: route.request().postDataJSON() });
      const s = randomUUID(),
        p = randomUUID();
      return route.fulfill({
        json: {
          ok: true,
          data: {
            session_id: s,
            completion_mode: "direct",
            expires_in: 300,
            uploads: [
              {
                key: `proofs/final/${s}/${p}.png`,
                method: "PUT",
                upload_url: `http://127.0.0.1:4173/api/uploads/put/${s}/${p}`,
                headers: {
                  "Content-Type": "image/png",
                  "X-Upload-Grant": randomBytes(48).toString("base64url"),
                },
              },
            ],
          },
        },
      });
    });
    await page.route("**/api/uploads/put/**", (route) => {
      calls.push({ path: "/put" });
      return route.fulfill({ json: { ok: true, data: { uploaded: true } } });
    });
    await page.route("**/api/cases/direct", (route) => {
      calls.push({ path: "/direct", body: route.request().postDataJSON() });
      return route.fulfill({
        status: 201,
        json: {
          ok: true,
          data: { case_id: state.caseId, query_key: state.query, status: "pending" },
        },
      });
    });
    await page.goto("/#submit");
    await expect(page.locator("#submission-fields")).toBeEnabled();
    await expect(
      page.locator(
        "#submission-form [name=vote_type], #submission-form [name=category], #submission-form [name=solo_target], #vote-type",
      ),
    ).toHaveCount(0);
    await page
      .locator("#proof-images")
      .setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: png });
    await page.locator("#submit-button").click();
    await expect(page.locator("#submission-success-message")).toContainText("我的案件");
    expect(calls.map((c) => c.path)).toEqual(["/prepare", "/put", "/direct"]);
    for (const field of ["vote_type", "category", "solo_target"])
      expect(calls.at(-1).body).not.toHaveProperty(field);
    expect(calls.at(-1).body.campaign_id).toBe("LOCAL");
    expect(state.calls.some((c) => c.path.endsWith("/complete"))).toBe(false);
  });
test("Preview Solo total has member rows only across responsive themes", async ({ page }) => {
  for (const width of [320, 390, 430, 1024, 1440])
    for (const theme of ["dark", "light"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(preview + "?preview_theme=" + theme + "#leaderboards");
      await expect(page.locator("html")).toHaveAttribute("data-preview-ready", "true");
      await page.locator("#board-categories button").nth(3).click();
      await expect(page.locator("#board-name")).toHaveText("Solo 總排行");
      await expect(page.locator("#board-results tr")).toHaveCount(5);
      await expect(page.locator("#solo-artists,#solo-target-wrap,#solo-target-filter,[data-target-id],.solo-artist-row")).toHaveCount(0);
      await expect(page.locator("#view-leaderboards")).not.toContainText(
        /所有藝人 Solo 排行|MIYEON|MINNIE|SOYEON|YUQI|SHUHUA/,
      );
      await expect(page.getByRole("button", { name: "查看粉絲排行" })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
});
test("public Solo total renders one member with 60 points and never requests artist rankings", async ({
  page,
}) => {
  const state = await memberFixture(page, { authenticated: true }),
    requests = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) requests.push(r.url());
  });
  await page.route("**/api/leaderboards*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          leaderboards: [
            {
              leaderboard_id: "system-solo",
              name: "Solo 總排行",
              type: "all_time",
              system_fixed: true,
              vote_type: "Solo",
              rankings: [
                {
                  rank: 1,
                  member_id: state.member.member_id,
                  nickname: state.member.nickname,
                  fan_id: "local_fan",
                  points: 60,
                  proof_count: 3,
                },
              ],
            },
          ],
          custom_boards: [],
        },
      },
    }),
  );
  await page.goto("/#leaderboards");
  await page.locator("#board-categories button").nth(3).click();
  await expect(page.locator("#board-name")).toHaveText("Solo 總排行");
  await expect(page.locator("#board-results tr")).toHaveCount(1);
  await expect(page.locator("#board-results")).toContainText(state.member.nickname);
  await expect(page.locator("#board-results .points")).toHaveText("60 點");
  await expect(page.locator("#solo-artists,#solo-target-wrap,#solo-target-filter,[data-target-id]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看粉絲排行" })).toHaveCount(0);
  expect(
    requests.some(
      (url) =>
        url.includes("/leaderboards/solo-targets") || new URL(url).searchParams.has("solo_target"),
    ),
  ).toBe(false);
});

test("Preview Admin can save registry choice locally and public form has no target controls", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(preview + "?preview_identity=admin#admin");
  await expect(page.locator("html")).toHaveAttribute("data-preview-ready", "true");
  await page.locator("#admin-tabs").getByRole("button", { name: "活動管理", exact: true }).click();
  await page.getByRole("button", { name: "建立活動", exact: true }).click();
  await fillCampaign(page, "PREVIEW-REGISTRY");
  await page.locator("#admin-field-solo_target").selectOption("yuqi");
  await page.getByRole("button", { name: "保存活動", exact: true }).click();
  await expect(page.locator("#admin-panel")).toContainText("Component campaign");
  await page.goto(preview + "?preview_identity=guest#submit");
  await expect(page.locator("html")).toHaveAttribute("data-preview-ready", "true");
  await expect(page.locator("#vote-type, #submission-form [name=solo_target]")).toHaveCount(0);
});
