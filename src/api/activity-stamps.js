import { adminHandler } from './admin-response.js';
import { readReviewJson } from './admin-validation.js';
import { jsonSuccess } from './response.js';
import { authDatabase, memberSession } from '../lib/auth-session.js';
import {
  AdminError, adminIdentity, adminCsrf, ELEVATED_ROLES, ELEVATED_AUTH_GUARD, actorBindings,
} from '../lib/admin-identity.js';
import { CAMPAIGN_ID } from '../lib/campaign-policy.js';
import { MAX_STAMP_ICON_LENGTH, decodeStampPng, validStampPng } from '../lib/activity-stamp-png.js';

const fields = ['campaign_id', 'name', 'description', 'min_proofs', 'min_days', 'opens_at', 'closes_at',
  'icon', 'color', 'status', 'sort_order', 'custom_color'];
const icons = ['spark', 'music', 'heart', 'chart', 'star', 'globe', 'mama', 'custom'];
const colors = ['blue', 'purple', 'pink', 'teal', 'gold', 'green', 'custom'];
const invalid = () => new AdminError(400, 'INVALID_STAMP_SETTING', '請核對集章設定。');
const conflict = () => new AdminError(409, 'STAMP_CONFLICT', '集章或操作權限已變更，請重新載入。');
const missing = () => new AdminError(404, 'STAMP_NOT_FOUND', '找不到集章圖案。');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const length = value => typeof value === 'string' ? Array.from(value.trim()).length : -1;
const adminColumns = 'stamp_id,version,' + fields.join(',');
const MAMA_CAMPAIGN_ID = '2026_MAMA_Fans_Choice_2nd';
const MAMA_DEFAULT_STAMP_ID = '2a38768c-c0cf-471d-81dd-68f55d3e36fb';
const adminIcon = row => ({
  ...row,
  ...(row.stamp_id === MAMA_DEFAULT_STAMP_ID ? { campaign_locked: true } : {}),
  custom_icon_url: row.icon === 'custom' ? '/api/admin/activity-stamps/' + row.stamp_id + '/icon/' + row.version : null,
});
const eligibleCampaign = "category IN ('團體','Solo') AND status IN ('draft','active','closed')";
const mamaDefaultSelect = `SELECT c.start_at,c.end_at
  FROM campaigns c
  WHERE c.campaign_id=? AND c.category IN ('團體','Solo')
    AND (c.status='closed' OR (c.status='active' AND julianday(c.end_at)<=julianday(?)))
    AND EXISTS(SELECT 1 FROM leaderboards b WHERE b.campaign_id=c.campaign_id AND b.type='campaign'
      AND b.status='active' AND b.is_public=1 AND (b.vote_type IS NULL OR b.vote_type=c.category))
    AND NOT EXISTS(SELECT 1 FROM activity_stamps s WHERE s.stamp_id=? OR (s.campaign_id=c.campaign_id AND s.replaces_legacy=1))`;
const mamaDefaultBindings = now => [MAMA_CAMPAIGN_ID, now, MAMA_DEFAULT_STAMP_ID];

export async function activityStampSchemaReady(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'
    AND name IN ('activity_stamps','activity_stamp_audit')`).first();
  return row?.n === 2;
}

async function editInput(body, updating) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !fields.includes(key) && key !== 'custom_icon' && !(updating && key === 'expected_version')) ||
      typeof body.campaign_id !== 'string' || !CAMPAIGN_ID.test(body.campaign_id) ||
      length(body.name) < 1 || length(body.name) > 60 || length(body.description) < 0 || length(body.description) > 160 ||
      !integer(body.min_proofs, 1, 10000) || !integer(body.min_days, 1, 3650) ||
      !integer(body.sort_order, 0, 9999) || !iso(body.opens_at) || !iso(body.closes_at) || body.opens_at >= body.closes_at ||
      !icons.includes(body.icon) || !colors.includes(body.color) || !['draft', 'published', 'hidden'].includes(body.status) ||
      (updating && !integer(body.expected_version, 0, Number.MAX_SAFE_INTEGER - 1))) throw invalid();
  const customColor = body.color === 'custom' && typeof body.custom_color === 'string' &&
    /^#?[0-9a-f]{6}$/i.test(body.custom_color) ? '#' + body.custom_color.replace(/^#/, '').toLowerCase() : null;
  if (body.color === 'custom' ? !customColor : body.custom_color != null) throw invalid();
  const artwork = body.custom_icon ?? null;
  if (body.icon === 'custom') {
    if (!(artwork === null && updating) && !await validStampPng(artwork)) throw invalid();
  } else if (artwork !== null) throw invalid();
  return {
    ...body, name: body.name.trim(), description: body.description.trim(), custom_color: customColor, custom_icon: artwork,
  };
}

async function saveStamp(db, actor, body, id, action, adoptMama = false) {
  const marker = crypto.randomUUID(), now = new Date().toISOString();
  const updateGuard = `stamp_id=? AND version=? AND status<>'deleted' AND ${ELEVATED_AUTH_GUARD}`;
  const actorArgs = actorBindings(actor);
  let change;
  if (action === 'delete') {
    if (!body || Object.keys(body).length !== 1 || !integer(body.expected_version, 0, Number.MAX_SAFE_INTEGER - 1)) throw invalid();
    change = db.prepare(`UPDATE activity_stamps SET status='deleted',custom_icon=NULL,replaces_legacy=MAX(replaces_legacy,?),
      version=version+1,updated_at=?,updated_by=?,last_mutation_id=? WHERE ${updateGuard}`)
      .bind(Number(id === MAMA_DEFAULT_STAMP_ID), now, actor.member.member_id, marker, id, body.expected_version, ...actorArgs);
  } else {
    const input = await editInput(body, action === 'update');
    if ((adoptMama || id === MAMA_DEFAULT_STAMP_ID) && input.campaign_id !== MAMA_CAMPAIGN_ID) throw invalid();
    const campaign = await db.prepare(`SELECT campaign_id FROM campaigns WHERE campaign_id=? AND ${eligibleCampaign}`)
      .bind(input.campaign_id).first();
    if (!campaign) throw invalid();
    const values = fields.map(key => input[key]);
    if (action === 'create') {
      id = adoptMama ? MAMA_DEFAULT_STAMP_ID : crypto.randomUUID();
      const columns = [...fields, 'stamp_id', 'custom_icon', 'replaces_legacy', 'updated_at', 'updated_by', 'last_mutation_id'];
      change = db.prepare(`INSERT INTO activity_stamps(${columns.join(',')})
        SELECT ${columns.map(() => '?').join(',')} WHERE ${ELEVATED_AUTH_GUARD}
        AND EXISTS(${adoptMama ? mamaDefaultSelect : `SELECT 1 FROM campaigns WHERE campaign_id=? AND ${eligibleCampaign}`})`)
        .bind(...values, id, input.custom_icon, Number(input.status !== 'draft'), now, actor.member.member_id,
          marker, ...actorArgs, ...(adoptMama ? mamaDefaultBindings(now) : [input.campaign_id]));
    } else {
      change = db.prepare(`UPDATE activity_stamps SET ${fields.map(key => key + '=?').join(',')},
        custom_icon=CASE WHEN ?<>'custom' THEN NULL ELSE COALESCE(?,custom_icon) END,
        replaces_legacy=MAX(replaces_legacy,?),version=version+1,updated_at=?,updated_by=?,last_mutation_id=?
        WHERE ${updateGuard} AND (?<>'custom' OR ? IS NOT NULL OR custom_icon IS NOT NULL)
        AND EXISTS(SELECT 1 FROM campaigns WHERE campaign_id=? AND ${eligibleCampaign})`)
        .bind(...values, input.icon, input.custom_icon, Number(input.status !== 'draft'), now, actor.member.member_id, marker,
          id, input.expected_version, ...actorArgs, input.icon, input.custom_icon, input.campaign_id);
    }
  }
  const result = await db.batch([
    change,
    db.prepare(`INSERT INTO activity_stamp_audit(mutation_id,stamp_id,version,action,actor_member_id,occurred_at)
      SELECT last_mutation_id,stamp_id,version,?,updated_by,updated_at FROM activity_stamps
      WHERE stamp_id=? AND last_mutation_id=?`).bind(action, id, marker),
    db.prepare(`SELECT ${adminColumns} FROM activity_stamps WHERE stamp_id=? AND last_mutation_id=?`).bind(id, marker),
  ]);
  if (result[0].meta.changes !== 1) throw conflict();
  return action === 'delete' ? { removed: true } : { stamp: adminIcon(result[2].results[0]) };
}

const admin = adminHandler(async (env, url, request) => {
  if (url.search) throw invalid();
  const actor = await adminIdentity(request, env, ELEVATED_ROLES);
  if (request.method === 'POST') await adminCsrf(request, env, actor);
  const db = authDatabase(env);
  if (!await activityStampSchemaReady(db)) throw new AdminError(503, 'STAMP_SCHEMA_REQUIRED', '活動集章的資料庫尚未安裝。');
  const [, , , , id, action] = url.pathname.split('/');
  if (request.method === 'POST') {
    const input = await readReviewJson(request, action === 'delete' ? undefined : MAX_STAMP_ICON_LENGTH + 6000);
    const adoptMama = id === 'mama-default';
    return jsonSuccess(await saveStamp(db, actor, input, id, action ?? 'create', adoptMama));
  }
  if (action === 'icon') return stampIcon(db, url, true);
  const [stamps, campaigns, inherited] = await db.batch([
    db.prepare(`SELECT ${adminColumns} FROM activity_stamps WHERE status<>'deleted' ORDER BY sort_order,stamp_id`),
    db.prepare(`SELECT campaign_id,name,category,start_at,end_at FROM campaigns WHERE ${eligibleCampaign}
      ORDER BY start_at DESC,campaign_id`),
    db.prepare(mamaDefaultSelect).bind(...mamaDefaultBindings(new Date().toISOString())),
  ]);
  const records = stamps.results.map(adminIcon);
  const mama = inherited.results[0];
  if (mama) records.unshift({
    stamp_id: MAMA_DEFAULT_STAMP_ID, campaign_id: MAMA_CAMPAIGN_ID, name: 'MAMA 第二輪', description: '',
    min_proofs: 1, min_days: 1, opens_at: mama.start_at, closes_at: mama.end_at,
    icon: 'mama', color: 'blue', status: 'published', sort_order: 0, inherited: true, campaign_locked: true,
  });
  return jsonSuccess({ stamps: records, campaigns: campaigns.results });
});

async function stampIcon(db, url, isAdmin) {
  const id = url.pathname.split('/').at(-3), version = Number(url.pathname.split('/').at(-1));
  if (!integer(version, 0, Number.MAX_SAFE_INTEGER)) throw missing();
  const scope = isAdmin ? "s.status<>'deleted'" : "s.status='published' AND s.opens_at<=? AND c.category IN ('團體','Solo') AND c.status IN ('active','closed')";
  const artwork = await db.prepare(`SELECT s.custom_icon FROM activity_stamps s JOIN campaigns c ON c.campaign_id=s.campaign_id
    WHERE s.stamp_id=? AND s.version=? AND s.icon='custom' AND ${scope}`)
    .bind(id, version, ...(isAdmin ? [] : [new Date().toISOString()])).first('custom_icon');
  if (!artwork) throw missing();
  return new Response(decodeStampPng(artwork), { headers: {
    'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store',
  }});
}

const memberArtwork = adminHandler(async (env, url, request) => {
  if (url.search) throw missing();
  await memberSession(request, env);
  return stampIcon(authDatabase(env), url, false);
});

export function activityStampRoute(path, method) {
  if (path === '/api/admin/activity-stamps') return { method: method === 'POST' ? 'POST' : 'GET', allow: 'GET, POST', handler: admin };
  if (path === '/api/admin/activity-stamps/mama-default') return { method: 'POST', handler: admin };
  if (/^\/api\/admin\/activity-stamps\/[a-f0-9-]{36}\/(update|delete)$/.test(path)) return { method: 'POST', handler: admin };
  if (/^\/api\/admin\/activity-stamps\/[a-f0-9-]{36}\/icon\/[0-9]{1,16}$/.test(path)) return { method: 'GET', handler: admin };
  if (/^\/api\/me\/activity-stamps\/[a-f0-9-]{36}\/icon\/[0-9]{1,16}$/.test(path)) return { method: 'GET', handler: memberArtwork };
}
