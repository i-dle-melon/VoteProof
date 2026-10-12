import { tierArtwork } from "./tier-artwork.js";

// next_tier is selected by the backend from enabled, configured tiers.
// Artwork ordering is never a source of thresholds or upgrade eligibility.
export function memberTierProgress(data) {
  const current = data?.tier, next = data?.next_tier, total = data?.total_points;
  const unavailable = { state: "unavailable" };
  if (!tierArtwork(current?.tier_id) || !Number.isSafeInteger(total)) return unavailable;
  if (data.tier_configuration_ready === false) return { state: "unconfigured" };
  const threshold = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000000;
  const rank = value => Number.isSafeInteger(value) && value >= 1 && value <= 8;
  if (data.tier_configuration_ready !== true || !threshold(current.min_points) || !rank(current.rank_order) ||
      (current.status !== undefined && current.status !== "active") ||
      (total < current.min_points && current.tier_id !== "normal")) return unavailable;
  if (next === null) return { state: "highest" };
  const art = tierArtwork(next?.tier_id);
  if (!art || next.tier_id === current.tier_id || !rank(next.rank_order) || next.rank_order <= current.rank_order ||
      !threshold(next.min_points) || next.min_points <= current.min_points || total >= next.min_points ||
      (next.status !== undefined && next.status !== "active")) return unavailable;
  return {
    state: "next", nextName: art.name, totalPoints: total, requiredPoints: next.min_points,
    remainingPoints: Math.min(Number.MAX_SAFE_INTEGER, next.min_points - total),
    percent: Math.max(0, Math.min(100, Math.round((Math.max(0, total) - current.min_points) / (next.min_points - current.min_points) * 10000) / 100)),
  };
}
