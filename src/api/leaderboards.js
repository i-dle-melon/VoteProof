import { jsonError, jsonSuccess } from "./response.js";

const UPSTREAM_TIMEOUT_MS = 8000;

export async function getLeaderboards(env, requestUrl) {
  const configuredUrl = env.GOOGLE_PUBLIC_API_URL;
  if (typeof configuredUrl !== "string" || !configuredUrl.trim()) {
    return jsonError(503, "UPSTREAM_NOT_CONFIGURED", "Leaderboard service is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstreamUrl = new URL(configuredUrl);
    if (!["https:", "http:"].includes(upstreamUrl.protocol) || upstreamUrl.username || upstreamUrl.password) {
      throw new Error("Invalid upstream configuration");
    }
    upstreamUrl.searchParams.set("action", "leaderboards");
    // Forward only the supported filter, never arbitrary client query parameters.
    const id = requestUrl.searchParams.get("id");
    upstreamUrl.searchParams.delete("id");
    if (id !== null) upstreamUrl.searchParams.set("id", id);

    const response = await fetch(upstreamUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Upstream HTTP error");
    // HTML error pages, invalid JSON and unexpected schemas all become JSON 502 errors.
    const payload = await response.json();
    if (payload?.ok !== true || typeof payload.generated_at !== "string" || !Array.isArray(payload.leaderboards)) {
      throw new Error("Invalid upstream response");
    }
    const leaderboards = payload.leaderboards.map(normalizeLeaderboard);
    return jsonSuccess({
      generated_at: payload.generated_at,
      leaderboards: id === null ? leaderboards : leaderboards.filter(board => board.leaderboard_id === id),
    }, "public, max-age=30");
  } catch {
    return jsonError(502, "UPSTREAM_ERROR", "Leaderboard service is unavailable");
  } finally {
    // The timeout covers fetching AND reading/parsing the response body.
    clearTimeout(timeout);
  }
}

function normalizeLeaderboard(board) {
  if (!board || typeof board.leaderboard_id !== "string" || typeof board.name !== "string" ||
      typeof board.generated_at !== "string" || !Array.isArray(board.rankings)) {
    throw new Error("Invalid leaderboard");
  }
  return {
    leaderboard_id: board.leaderboard_id,
    name: board.name,
    generated_at: board.generated_at,
    rankings: board.rankings.map(row => {
      if (!row || typeof row.member_id !== "string" || typeof row.nickname !== "string" ||
          (row.reached_at !== null && typeof row.reached_at !== "string")) {
        throw new Error("Invalid ranking");
      }
      // Whitelist public fields; do not proxy arbitrary upstream metadata.
      return {
        rank: numericField(row.rank, true, 1),
        member_id: row.member_id,
        nickname: row.nickname,
        points: numericField(row.points, false, -Infinity),
        proof_count: numericField(row.proof_count, true, 0),
        reached_at: row.reached_at,
      };
    }),
  };
}

function numericField(value, integer, minimum) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) {
    throw new Error("Invalid numeric field");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || (integer && !Number.isSafeInteger(number))) {
    throw new Error("Invalid numeric field");
  }
  return number;
}
