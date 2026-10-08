import { jsonSuccess } from "./response.js";
import { authHandler } from "./auth.js";
import { AuthError, AUTH_LIMITS, readAuthJson, profileInput, suspended } from "./auth-validation.js";
import { memberSession, memberCsrf, publicMember, authDatabase } from "../lib/auth-session.js";
import { CASE_ID_PATTERN } from "../lib/case-keys.js";
import { guestFiles } from "../lib/case-store.js";

export const updateProfile = authHandler(async (env, _url, request) => {
  const member = await memberSession(request, env);
  await memberCsrf(request, env, member);
  const input = profileInput(await readAuthJson(request)), db = authDatabase(env);
  const result = await db.prepare(`UPDATE members SET nickname = COALESCE(?, nickname), player_id = COALESCE(?, player_id), updated_at = ?
    WHERE member_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM auth_sessions
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CAST(strftime('%s', 'now') AS INTEGER))`)
    .bind(input.nickname ?? null, input.player_id ?? null, new Date().toISOString(), member.member_id, member.tokenHash).run();
  if (result.meta.changes !== 1) { await memberSession(request, env); throw suspended(); }
  return jsonSuccess({ member: publicMember(await memberSession(request, env)) });
});

const columns = "id, case_id, created_at, nickname, campaign_id, vote_type, vote_date, status, points_awarded";
const notFound = () => new AuthError(404, "CASE_NOT_FOUND", "Case not found");
function pageInput(url) {
  const invalid = () => { throw new AuthError(400, "INVALID_PAGINATION", "Invalid case pagination"); };
  if ([...url.searchParams.keys()].some(k => !["limit", "cursor"].includes(k)) || url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1) invalid();
  const raw = url.searchParams.get("limit");
  if (raw !== null && !/^[1-9]\d?$/.test(raw)) invalid();
  const limit = raw === null ? AUTH_LIMITS.defaultPage : Number(raw);
  if (limit > AUTH_LIMITS.maxPage) invalid();
  let cursor;
  const encoded = url.searchParams.get("cursor");
  if (encoded !== null) {
    try {
      if (encoded.length > 200 || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
      cursor = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")));
      if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor[0]) ||
          !Number.isFinite(Date.parse(cursor[0])) || !/^[0-9a-f-]{36}$/.test(cursor[1])) invalid();
    } catch { invalid(); }
  }
  return { limit, cursor };
}

export const listMemberCases = authHandler(async (env, url, request) => {
  const member = await memberSession(request, env), { limit, cursor } = pageInput(url), db = authDatabase(env);
  const params = cursor ? [member.member_id, cursor[0], cursor[0], cursor[1], limit + 1] : [member.member_id, limit + 1];
  const result = (await db.prepare(`SELECT ${columns} FROM cases WHERE member_id = ?
    ${cursor ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...params).all()).results;
  const rows = result.slice(0, limit), last = rows.at(-1);
  // Two bounded prepared queries rather than one query per case.
  const files = rows.length ? (await db.prepare(`SELECT f.case_id, f.content_type, f.size FROM case_files f
    JOIN cases c ON c.id = f.case_id WHERE c.member_id = ? AND f.case_id IN (${rows.map(() => "?").join(",")}) ORDER BY f.id`)
    .bind(member.member_id, ...rows.map(row => row.id)).all()).results : [];
  return jsonSuccess({ cases: rows.map(({ id, ...row }) => ({ ...row, files: files.filter(f => f.case_id === id).map(({ content_type, size }) => ({ content_type, size })) })),
    next_cursor: result.length > limit ? btoa(JSON.stringify([last.created_at, last.id])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : null });
});

export const getMemberCase = authHandler(async (env, url, request) => {
  const member = await memberSession(request, env), caseId = url.pathname.split("/").at(-1);
  if (!CASE_ID_PATTERN.test(caseId)) throw notFound();
  const row = await authDatabase(env).prepare(`SELECT ${columns} FROM cases WHERE case_id = ? AND member_id = ?`).bind(caseId, member.member_id).first();
  if (!row) throw notFound();
  const { id, ...data } = row;
  return jsonSuccess({ ...data, files: await guestFiles(authDatabase(env), id) });
});
