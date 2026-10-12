// UI PREVIEW ONLY: generated Pages marker + isolated host checked by preview.js.
// No real member, credentials, points, cases, votes or provider state.
import { PREVIEW } from "./preview.js";
const campaign = Object.freeze({ campaign_id: "UI-PREVIEW", name: "預覽活動（非正式資料）", category: "Solo",
  start_at: "2026-01-01T00:00:00Z", end_at: "2099-12-31T00:00:00Z", campaign_timezone: "Asia/Taipei",
  status: "active", vote_start_date: "2026-01-01", vote_end_date: "2099-12-31", points_per_proof: 10, daily_limit: null, version: 0, note: null });
export function fixtureResponse(path) {
  const reply = (data, status = 200) => new Response(JSON.stringify({ ok: status === 200, ...(status === 200 ? { data } : { error: { code: data } }) }),
    { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (!PREVIEW) return reply("UI_PREVIEW_ONLY", 403);
  const endpoint = path.split("?")[0];
  if (endpoint === "/api/submissions/status") return reply({ submissions_enabled: false, submissions_message: "UI 預覽不接受投稿。" });
  if (endpoint === "/api/campaigns") return reply({ campaigns: [campaign] });
  if (endpoint === "/api/leaderboards") return reply({ leaderboards: [] });
  if (endpoint === "/api/auth/registration-status") return reply({ registration_available: false });
  return reply("UI_PREVIEW_ONLY", 403);
}
