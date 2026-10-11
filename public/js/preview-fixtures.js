// UI PREVIEW ONLY: generated Pages marker + isolated host checked by preview.js.
// No real member, credentials, points, cases, votes or provider state.
import { PREVIEW } from "./preview.js";
const tiers = ["normal", "bronze", "silver", "gold", "platinum", "emerald", "diamond", "stellar"];
const names = ["普通", "青銅", "白銀", "黃金", "白金", "翡翠", "鑽石", "星耀"];
const campaign = Object.freeze({ campaign_id: "UI-PREVIEW", name: "預覽活動（非正式資料）", category: "Solo",
  start_at: "2026-01-01T00:00:00Z", end_at: "2099-12-31T00:00:00Z", campaign_timezone: "Asia/Taipei",
  status: "active", vote_start_date: "2026-01-01", vote_end_date: "2099-12-31", points_per_proof: 10, daily_limit: null, version: 0, note: null });
export function fixtureResponse(path) {
  const reply = (data, status = 200) => new Response(JSON.stringify({ ok: status === 200, ...(status === 200 ? { data } : { error: { code: data } }) }),
    { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (!PREVIEW) return reply("UI_PREVIEW_ONLY", 403);
  const scene = new URL(location.href).searchParams.get("ui"), memberScene = ["member", "admin"].includes(scene);
  const member = { member_id: "UI-PREVIEW-MEMBER", nickname: "預覽會員", player_id: "", status: "active" };
  const endpoint = path.split("?")[0];
  if (endpoint === "/api/submissions/status") return reply({ submissions_enabled: false, submissions_message: "UI 預覽不接受投稿。" });
  if (endpoint === "/api/campaigns") return reply({ campaigns: [campaign] });
  if (endpoint === "/api/leaderboards") return reply({ leaderboards: [] });
  if (endpoint === "/api/auth/registration-status") return reply({ registration_available: false });
  if (endpoint === "/api/auth/me") return memberScene ? reply({ member, csrf_token: "0".repeat(64), expires_in: 600, elevated_until: Date.now() / 1000 + 600 }) : reply("AUTH_REQUIRED", 401);
  if (!memberScene) return reply("AUTH_REQUIRED", 401);
  if (endpoint === "/api/me/points") return reply({ total_points: 0, tier: { tier_id: "normal", name: "普通", min_points: 0 }, next_tier: null,
    tier_configuration_ready: false, tier_progress: 0, points_to_next_tier: 0 });
  if (endpoint === "/api/me/cases") return reply({ cases: [], next_cursor: null });
  if (endpoint === "/api/auth/login-security") return reply({ google: { connected: true, email: "" }, password: { configured: false }, authenticator: { configured: false }, current_method: "google" });
  if (endpoint === "/api/auth/trusted-devices") return reply({ devices: [] });
  if (scene !== "admin") return reply("ADMIN_FORBIDDEN", 403);
  if (endpoint === "/api/admin/me") return reply({ member_id: member.member_id, role: "super_admin" });
  if (endpoint === "/api/admin/cases") return reply({ cases: [], next_cursor: null });
  if (endpoint === "/api/admin/campaigns") return reply({ campaigns: [campaign], next_cursor: null });
  if (endpoint === "/api/admin/leaderboards") return reply({ leaderboards: [], next_cursor: null });
  if (endpoint === "/api/admin/member-tiers") return reply({ tiers: tiers.map((id, index) => ({ tier_id: id, name: names[index], min_points: index ? null : 0, status: index ? "disabled" : "active", version: 0 })), configuration_ready: false });
  if (endpoint === "/api/admin/submissions") return reply({ submissions_enabled: false, submissions_message: "UI 預覽不接受投稿。", version: 0 });
  if (endpoint === "/api/admin/audit-logs") return reply({ logs: [], next_cursor: null });
  return reply("UI_PREVIEW_ONLY", 403);
}
