// BUILD-ONLY synthetic DTOs. No real identities, credentials, query keys or proof.
import { PREVIEW } from "./preview.js";
import { previewState as state } from "./pages-preview-state.js";
export const identity = {
  member_id: "PREVIEW-MEMBER-001",
  nickname: "展示會員・假資料 P001",
  player_id: "PREVIEW-PLAYER-001",
  status: "active",
};
export const campaign = {
  campaign_id: "PREVIEW-CAMPAIGN",
  name: "展示回歸應援・假資料",
  category: "Solo",
  start_at: "2026-01-01T00:00:00Z",
  end_at: "2099-12-31T00:00:00Z",
  campaign_timezone: "Asia/Taipei",
  vote_start_date: "2026-01-01",
  vote_end_date: "2099-12-31",
  points_per_proof: 10,
  daily_limit: null,
  status: "active",
  version: 1,
  note: "UI PREVIEW 假資料",
};
const tierNames = ["普通", "青銅", "白銀", "黃金", "白金", "翡翠", "鑽石", "星耀"];
export const tiers = [
  "normal",
  "bronze",
  "silver",
  "gold",
  "platinum",
  "emerald",
  "diamond",
  "stellar",
].map((tier_id, i) => ({
  tier_id,
  name: tierNames[i],
  icon_key: tier_id,
  rank_order: i + 1,
  min_points: [0, 50, 150, 300, 600, 1000, 1600, 2400][i],
  status: "active",
  version: 1,
}));
const rankings = [
  "展示小宇 P002",
  "展示 Mina P003",
  "展示 ABC P004",
  identity.nickname,
  "展示 Sora P005",
].map((nickname, i) => ({
  rank: i + 1,
  nickname,
  member_id: i === 3 ? identity.member_id : "PREVIEW-PUBLIC-" + i,
  points: [580, 530, 490, 420, 120][i],
  proof_count: [58, 53, 49, 42, 12][i],
  tier: tiers[i === 3 ? 3 : 2],
  tier_configuration_ready: true,
}));
export const boards = [
  ["history", "歷史累計", "all_time", null],
  ["comeback", "本次回歸", "campaign", null],
  ["group", "團體排行", "all_time", "團體"],
  ["solo", "Solo排行", "all_time", "Solo"],
  ["custom-one", "展示生日應援榜", "custom", null],
  ["custom-two", "展示週末衝刺榜", "custom", null],
  ["custom-three", "展示特別活動榜", "custom", null],
].map(([leaderboard_id, name, type, vote_type]) => ({
  leaderboard_id: "PREVIEW-" + leaderboard_id,
  name,
  type,
  vote_type,
  campaign_id: type === "campaign" ? "PREVIEW-CAMPAIGN" : null,
  start_date: type === "custom" ? "2026-01-01" : null,
  end_date: type === "custom" ? "2099-12-31" : null,
  generated_at: "2026-10-14T04:00:00Z",
  rankings,
  top_n: 100,
  is_public: true,
  status: "active",
  version: 1,
}));
export const cases = ["pending", "approved", "rejected", "pending", "completed"].map(
  (status, i) => ({
    case_id: "VP-PREVIEW-00" + (i + 1),
    nickname: identity.nickname,
    player_id: identity.player_id,
    campaign_id: campaign.campaign_id,
    campaign_name: campaign.name,
    vote_type: i % 2 ? "團體" : "Solo",
    vote_date: "2026-10-14",
    created_at: "2026-10-14T03:00:00Z",
    status,
    status_reason: status === "rejected" ? "展示退件原因：投票日期不清楚（假資料）" : null,
    rejection_reason: status === "rejected" ? "展示退件原因：投票日期不清楚（假資料）" : null,
    points_awarded: ["approved", "completed"].includes(status) ? 10 : 0,
    version: 1,
    files: [{ file_id: "PREVIEW-IMAGE-" + i, content_type: "image/png", size: 4096 }],
    duplicate_evidence: {
      hash_state: "verified",
      analyses: [
        {
          state: ["pending", "processing", "clear", "exact_duplicate", "failed"][i],
          ...(i === 3
            ? { canonical_case_id: "VP-PREVIEW-001", canonical_file_id: "PREVIEW-IMAGE-0" }
            : {}),
        },
      ],
    },
  }),
);
const paged = (key, data) => ({ [key]: state.data === "empty" ? [] : data, next_cursor: null });
export async function fixtureResponse(path, { method = "GET" } = {}) {
  const reply = (data, status = 200) =>
    Response.json(
      { ok: status === 200, ...(status === 200 ? { data } : { error: { code: data } }) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  if (!PREVIEW || method !== "GET" || typeof path !== "string" || !path.startsWith("/api/"))
    return reply("UI_PREVIEW_ONLY", 403);
  const url = new URL(path, "https://preview.invalid"),
    p = url.pathname;
  if (p === "/api/auth/me")
    return state.identity === "guest"
      ? reply("AUTH_REQUIRED", 401)
      : reply({
          member: identity,
          elevated_until: state.identity === "admin" ? 4102444800 : undefined,
        });
  if (p === "/api/admin/me")
    return state.identity === "admin"
      ? reply({ member_id: identity.member_id, role: "admin" })
      : reply("ADMIN_FORBIDDEN", 403);
  if (p === "/api/auth/registration-status") return reply({ registration_available: false });
  if (p === "/api/submissions/status")
    return reply({
      submissions_enabled: state.gate === "on",
      submissions_message:
        state.gate === "on"
          ? "UI PREVIEW：展示開放狀態，實際不收件。"
          : "UI PREVIEW：展示暫停狀態。",
    });
  if (
    (p.startsWith("/api/me/") ||
      p === "/api/auth/login-security" ||
      p === "/api/auth/trusted-devices") &&
    state.identity === "guest"
  )
    return reply("AUTH_REQUIRED", 401);
  if (p.startsWith("/api/admin/") && state.identity !== "admin")
    return reply("ADMIN_FORBIDDEN", 403);
  if (state.data === "error") return reply("SERVICE_UNAVAILABLE", 503);
  if (p === "/api/campaigns") return reply(paged("campaigns", [campaign]));
  if (p === "/api/leaderboards") {
    const selected =
      state.data === "empty"
        ? []
        : boards.filter(
            (b) => !url.searchParams.has("id") || b.leaderboard_id === url.searchParams.get("id"),
          );
    return reply({
      generated_at: "2026-10-14T04:00:00Z",
      leaderboards: selected,
      custom_boards: selected
        .filter((b) => b.type === "custom")
        .map(({ leaderboard_id, name, type, campaign_id, vote_type }) => ({
          leaderboard_id,
          name,
          type,
          campaign_id,
          vote_type,
        })),
    });
  }
  if (p === "/api/me/points")
    return reply({
      total_points: state.data === "empty" ? 0 : 420,
      tier: tiers[state.data === "empty" ? 0 : 3],
      tier_configuration_ready: true,
      next_tier: tiers[state.data === "empty" ? 1 : 4],
    });
  if (p === "/api/auth/login-security")
    return reply({
      google: { connected: true, email: "展示帳號・無真實信箱" },
      password: { configured: true },
      authenticator: { configured: true },
      recovery: { remaining: 8 },
      current_method: "google",
      unlink_supported: false,
    });
  if (p === "/api/auth/trusted-devices")
    return reply(
      paged("devices", [
        { id: "PREVIEW-DEVICE", label: "展示手機・假資料", expires_at: 4102444800 },
      ]),
    );
  if (p === "/api/me/cases")
    return reply(paged("cases", cases.slice(0, Number(url.searchParams.get("limit") ?? 10))));
  if (p.startsWith("/api/me/cases/")) {
    const row = cases.find((c) => p.endsWith("/" + c.case_id));
    return row && state.data !== "empty" ? reply(row) : reply("CASE_NOT_FOUND", 404);
  }
  if (p === "/api/admin/cases")
    return reply(
      paged(
        "cases",
        cases.filter(
          (c) => !url.searchParams.get("status") || c.status === url.searchParams.get("status"),
        ),
      ),
    );
  if (p === "/api/admin/backups" || /^\/api\/admin\/cases\/VP-PREVIEW-\d+\/backups$/.test(p))
    return reply({
      enabled: false,
      ready: false,
      configured: false,
      transport: "apps_script_pull",
      counts: { pending: 0, processing: 0, confirmed: 0, failed: 0 },
      missing: 0,
      audit: [],
      backups: [],
    });
  if (p.startsWith("/api/admin/cases/")) {
    const row = cases.find((c) => p.endsWith("/" + c.case_id));
    return row && state.data !== "empty"
      ? reply({
          ...row,
          duplicate_evidence: {
            hash_state: "verified",
            analyses: [
              {
                state: state.analysis,
                ...(state.analysis === "exact_duplicate"
                  ? { canonical_case_id: "VP-PREVIEW-001", canonical_file_id: "PREVIEW-IMAGE-0" }
                  : {}),
              },
            ],
          },
        })
      : reply("CASE_NOT_FOUND", 404);
  }
  if (p === "/api/admin/campaigns") return reply(paged("campaigns", [campaign]));
  if (p === "/api/admin/leaderboards") return reply(paged("leaderboards", boards));
  if (/^\/api\/admin\/leaderboards\/PREVIEW-[a-z-]+\/results$/.test(p))
    return reply({
      leaderboards:
        state.data === "empty"
          ? []
          : [boards.find((b) => p.includes(b.leaderboard_id)) ?? boards[0]],
    });
  if (p === "/api/admin/member-tiers") return reply({ tiers, configuration_ready: true });
  if (p === "/api/admin/submissions")
    return reply({
      submissions_enabled: state.gate === "on",
      submissions_message: "UI PREVIEW・展示設定，不會保存",
      version: 1,
    });
  if (p === "/api/admin/audit-logs")
    return reply(
      paged("audit_logs", [
        {
          id: "PREVIEW-AUDIT",
          action: "leaderboard_update",
          created_at: "2026-10-14T03:00:00Z",
          admin_member_id: "PREVIEW-ADMIN",
          target_id: "PREVIEW-custom-one",
          reason: "展示操作紀錄・假資料",
        },
      ]),
    );
  return reply("UI_PREVIEW_ONLY", 403);
}
export async function previewPicture(index = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#18291c";
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = "#00cd3c";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText("UI PREVIEW", 48, 110);
  ctx.fillStyle = "#fff";
  ctx.font = "22px sans-serif";
  ctx.fillText("Synthetic image " + index, 48, 170);
  ctx.fillText("No real vote / private proof", 48, 220);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
