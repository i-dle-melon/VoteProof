import { systemBoards,isSystemBoard,rejectSystemMutation,liveSystemBoards } from './system-leaderboards.js';
import { AdminError, ELEVATED_AUTH_GUARD, actorBindings, adminDenied } from './admin-identity.js';
import { boardConflict, boardMissing } from './leaderboard-policy.js';
import { LEDGER_CTE, INTEGRITY_SQL } from './leaderboard-ranking.js';
import { CAMPAIGN_ID } from './campaign-policy.js';
import { resolveMemberTier } from './member-tier.js';
import { encodeCursor } from '../api/admin-validation.js';

const definitionFields = ['name','type','campaign_id','start_date','end_date','vote_type','top_n','is_public','status'];
const scopeFields = ['type','campaign_id','start_date','end_date','vote_type'];
const safeBoard = row => { const { last_mutation_id, ...safe } = row; return { ...safe, is_public: Boolean(safe.is_public) }; };
export const boardRow = (db, id) => db.prepare('SELECT * FROM leaderboards WHERE leaderboard_id = ?').bind(id).first();
export async function getBoard(db, id) {
  const fixed=systemBoards.find(b=>b.leaderboard_id===id); if(fixed)return fixed;
  if (typeof id !== 'string' || !CAMPAIGN_ID.test(id)) throw boardMissing();
  const row = await boardRow(db, id); if (!row) throw boardMissing(); return safeBoard(row);
}
export async function listBoards(db, url) {
  const invalid = () => { throw new AdminError(400, 'INVALID_ADMIN_QUERY', 'Invalid leaderboard pagination'); };
  for (const k of url.searchParams.keys()) if (!['limit','cursor','status'].includes(k) || url.searchParams.getAll(k).length !== 1) invalid();
  const status = url.searchParams.get('status'), raw = url.searchParams.get('limit'), limit = raw === null ? 20 : Number(raw);
  if (status !== null && !['draft','active','archived'].includes(status) || raw !== null && !/^[1-9]\d?$/.test(raw) || limit > 50) invalid();
  const where = ["type!='all_time'"], args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  const encoded = url.searchParams.get('cursor');
  if (encoded !== null) {
    try {
      if (encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
      const c = JSON.parse(atob(encoded.replaceAll('-','+').replaceAll('_','/')));
      if (!Array.isArray(c) || c.length !== 3 || c[0] !== status || typeof c[1] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(c[1]) || !Number.isFinite(Date.parse(c[1])) || typeof c[2] !== 'string' || !CAMPAIGN_ID.test(c[2])) invalid();
      where.push('(created_at < ? OR (created_at = ? AND leaderboard_id < ?))'); args.push(c[1],c[1],c[2]);
    } catch { invalid(); }
  }
  const rows = (await db.prepare(`SELECT * FROM leaderboards ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY created_at DESC, leaderboard_id DESC LIMIT ?`).bind(...args,limit+1).all()).results;
  const selected = rows.slice(0,limit), last = selected.at(-1);
  return { leaderboards: selected.map(safeBoard), system_boards:encoded===null && (!status || status==="active")?systemBoards:[], next_cursor: rows.length > limit ? encodeCursor([status,last.created_at,last.leaderboard_id]) : null };
}
export async function saveBoard(db, actor, input, existing = null) {
  rejectSystemMutation(existing);rejectSystemMutation(input);
  if (existing && (existing.status === 'archived' || existing.version !== input.expected_version ||
      !({ draft:['draft','active','archived'], active:['active','archived'] }[existing.status]?.includes(input.status)))) throw boardConflict();
  const archiving = Boolean(existing && input.status === 'archived');
  if (archiving && definitionFields.filter(k => k !== 'status').some(k => existing[k] !== input[k])) throw boardConflict();
  if (input.campaign_id !== null) {
    const campaign = await db.prepare('SELECT status FROM campaigns WHERE campaign_id = ?').bind(input.campaign_id).first();
    if (!campaign) throw new AdminError(400,'INVALID_CAMPAIGN','Campaign does not exist');
    if (campaign.status === 'archived' && (!existing || scopeFields.some(k => existing[k] !== input[k]))) throw boardConflict();
  }
  if (existing?.campaign_id && (await db.prepare('SELECT status FROM campaigns WHERE campaign_id = ?').bind(existing.campaign_id).first())?.status === 'archived' && scopeFields.some(k => existing[k] !== input[k])) throw boardConflict();
  const id = existing?.leaderboard_id ?? input.leaderboard_id, marker = crypto.randomUUID(), now = new Date().toISOString();
  const values = definitionFields.map(k => k === 'is_public' ? Number(input[k]) : input[k]);
  // Revalidate Campaign archive/scope policy inside the same write transaction.
  const campaignGuard = `(? IS NULL OR EXISTS(SELECT 1 FROM campaigns WHERE campaign_id = ? AND (status != 'archived' OR ? = 1)))
    AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM campaigns WHERE campaign_id = ? AND status = 'archived') OR ? = 1)`;
  const sameScope = existing && scopeFields.every(k => existing[k] === input[k]) ? 1 : 0;
  const guardArgs = [input.campaign_id,input.campaign_id,sameScope,existing?.campaign_id ?? null,existing?.campaign_id ?? null,sameScope];
  const statement = existing ? db.prepare(`UPDATE leaderboards SET ${definitionFields.map(k => k+' = ?').join(', ')}, updated_at = ?, updated_by = ?,
    version = version + 1, current_run_id = ?, last_mutation_id = ? WHERE leaderboard_id = ? AND version = ? AND status = ?
    AND ${ELEVATED_AUTH_GUARD} AND ${campaignGuard}`)
    .bind(...values,now,actor.member.member_id,archiving ? existing.current_run_id : null,marker,id,input.expected_version,existing.status,...actorBindings(actor),...guardArgs)
    : db.prepare(`INSERT INTO leaderboards (${definitionFields.join(', ')}, leaderboard_id, created_at, updated_at, created_by, updated_by, last_mutation_id)
      SELECT ${Array(15).fill('?').join(', ')} WHERE ${ELEVATED_AUTH_GUARD} AND ${campaignGuard}`)
      .bind(...values,id,now,now,actor.member.member_id,actor.member.member_id,marker,...actorBindings(actor),...guardArgs);
  const action = existing ? input.status === 'archived' ? 'leaderboard_archive' : 'leaderboard_update' : 'leaderboard_create';
  let result;
  try {
    result = await db.batch([statement,
      db.prepare(`INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json)
        SELECT ?,?,?,?,?, 'leaderboard',leaderboard_id,version,?,json_object('leaderboard_id',leaderboard_id,'version',version,'status',status,'run_id',current_run_id)
        FROM leaderboards WHERE leaderboard_id = ? AND last_mutation_id = ?`)
        .bind(marker,now,actor.member.member_id,actor.role,action,JSON.stringify(existing ? { version:existing.version,status:existing.status,run_id:existing.current_run_id } : {}),id,marker),
      db.prepare('SELECT * FROM leaderboards WHERE leaderboard_id = ? AND last_mutation_id = ?').bind(id,marker)]);
  } catch {
    const stored = await boardRow(db,id); if (stored?.last_mutation_id === marker) return safeBoard(stored);
    if (!existing && stored) throw new AdminError(409,'LEADERBOARD_EXISTS','Leaderboard already exists');
    throw new AdminError(503,'LEADERBOARD_SERVICE_UNAVAILABLE','Leaderboard service is unavailable');
  }
  if (result[0].meta.changes !== 1) { if (existing) throw boardConflict(); throw adminDenied(); }
  return safeBoard(result[2].results[0]);
}
export async function rebuildBoard(db, actor, board, expectedVersion) {
  rejectSystemMutation(board);
  if (board.status === 'archived' || board.version !== expectedVersion) throw boardConflict();
  const run = crypto.randomUUID(), now = new Date().toISOString();
  let result;
  try {
    result = await db.batch([
      db.prepare(`${LEDGER_CTE} INSERT INTO leaderboard_runs(run_id,leaderboard_id,generated_at,definition_version,source_count,source_last_transaction_id,status,integrity_errors,definition_json)
        SELECT ?,b.leaderboard_id,?,b.version,(SELECT COUNT(*) FROM point_transactions),
          (SELECT transaction_id FROM point_transactions ORDER BY rowid DESC LIMIT 1),'building',${INTEGRITY_SQL},
          json_object('name',b.name,'type',b.type,'campaign_id',b.campaign_id,'start_date',b.start_date,'end_date',b.end_date,'vote_type',b.vote_type,'top_n',b.top_n)
        FROM leaderboards b WHERE b.leaderboard_id = ? AND b.version = ? AND b.status != 'archived' AND ${ELEVATED_AUTH_GUARD}`)
        .bind(board.leaderboard_id,run,now,board.leaderboard_id,expectedVersion,...actorBindings(actor)),
      db.prepare(`${LEDGER_CTE} INSERT INTO leaderboard_results(run_id,leaderboard_id,rank,member_id,nickname,points,proof_count,reached_at)
        SELECT ?,?,rank,member_id,nickname,points,proof_count,reached_at FROM ranked
        WHERE rank <= (SELECT top_n FROM leaderboards WHERE leaderboard_id = ?) AND EXISTS(SELECT 1 FROM leaderboard_runs WHERE run_id = ? AND status = 'building')`)
        .bind(board.leaderboard_id,run,board.leaderboard_id,board.leaderboard_id,run),
      db.prepare(`UPDATE leaderboard_runs SET status = 'success', row_count = (SELECT COUNT(*) FROM leaderboard_results WHERE run_id = ?)
        WHERE run_id = ? AND status = 'building'`).bind(run,run),
      db.prepare(`UPDATE leaderboards SET current_run_id = ?,version = version + 1,updated_at = ?,updated_by = ?,last_mutation_id = ?
        WHERE leaderboard_id = ? AND version = ? AND EXISTS(SELECT 1 FROM leaderboard_runs WHERE run_id = ? AND status = 'success')`)
        .bind(run,now,actor.member.member_id,run,board.leaderboard_id,expectedVersion,run),
      db.prepare(`INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json)
        SELECT ?,?,?,?,?, 'leaderboard',b.leaderboard_id,b.version,?,json_object('leaderboard_id',b.leaderboard_id,'run_id',r.run_id,'row_count',r.row_count,'generated_at',r.generated_at)
        FROM leaderboards b JOIN leaderboard_runs r ON r.run_id = b.current_run_id WHERE b.leaderboard_id = ? AND b.last_mutation_id = ?`)
        .bind(run,now,actor.member.member_id,actor.role,'leaderboard_rebuild',JSON.stringify({ run_id:board.current_run_id,version:board.version }),board.leaderboard_id,run),
      db.prepare('SELECT run_id,generated_at,row_count,source_count FROM leaderboard_runs WHERE run_id = ?').bind(run),
    ]);
  } catch {
    const stored = await db.prepare("SELECT run_id,generated_at,row_count,source_count FROM leaderboard_runs WHERE run_id = ? AND status = 'success'").bind(run).first();
    if (stored) return { ...stored, version:expectedVersion+1 };
    throw new AdminError(503,'LEADERBOARD_REBUILD_FAILED','Leaderboard rebuild failed');
  }
  if (result[0].meta.changes !== 1 || result[3].meta.changes !== 1) throw boardConflict();
  return { ...result[5].results[0], version:expectedVersion+1 };
}
// One joined query per response: a concurrent publish cannot mix runs/rows.
export async function publishedBoards(db, id = null, admin = false) {
  const rows = (await db.prepare(`SELECT b.leaderboard_id,b.name,b.type,b.campaign_id,b.vote_type,r.run_id,r.generated_at,
      x.rank,x.member_id,x.nickname,m.player_id fan_id,x.points,x.proof_count,x.reached_at
    FROM leaderboards b JOIN leaderboard_runs r ON r.run_id = b.current_run_id AND r.status = 'success'
    LEFT JOIN leaderboard_results x ON x.run_id = r.run_id LEFT JOIN members m ON m.member_id=x.member_id
    WHERE b.type!='all_time' AND (? IS NULL OR b.leaderboard_id = ?) ${admin ? '' : "AND b.is_public = 1 AND b.status = 'active'"}
    ORDER BY b.leaderboard_id,x.rank`).bind(id,id).all()).results;
  const boards = await liveSystemBoards(db,id);
  for (const row of rows) {
    let board = boards.at(-1);
    if (!board || board.leaderboard_id !== row.leaderboard_id) { board = { leaderboard_id:row.leaderboard_id,name:row.name,type:row.type,campaign_id:row.campaign_id,vote_type:row.vote_type,generated_at:row.generated_at,rankings:[] }; boards.push(board); }
    if (row.rank !== null) board.rankings.push(Object.fromEntries(['rank','member_id','nickname','fan_id','points','proof_count','reached_at'].map(k => [k,row[k]])));
  }
  const members=[...new Set(boards.flatMap(b=>b.rankings.map(r=>r.member_id)))];
  if(members.length){
    // Read-only enrichment. Published ranks/points remain the original snapshot;
    // current Tier uses the same centralized policy as the member point summary.
    const [totals,configuration]=await db.batch([
      db.prepare(`SELECT member_id,COALESCE(SUM(points),0) total_points FROM point_transactions WHERE member_id IN (
        SELECT x.member_id FROM leaderboard_results x JOIN leaderboard_runs r ON r.run_id=x.run_id AND r.status='success'
        JOIN leaderboards b ON b.current_run_id=r.run_id
        WHERE (? IS NULL OR b.leaderboard_id=?) ${admin?'':"AND b.is_public=1 AND b.status='active'"}
      ) GROUP BY member_id`).bind(id,id),
      db.prepare('SELECT tier_id,name,icon_key,rank_order,min_points,status FROM member_tiers ORDER BY rank_order'),
    ]);
    const balances=new Map(totals.results.map(r=>[r.member_id,r.total_points]));
    for(const board of boards.filter(b=>!b.system_fixed))for(const row of board.rankings){
      const resolved=resolveMemberTier(balances.get(row.member_id)??0,configuration.results);
      const {tier_id,name,icon_key}=resolved.tier;
      row.tier={tier_id,name,icon_key};row.tier_configuration_ready=resolved.tier_configuration_ready;
    }
  }
  // Enabled custom navigation is safe definition metadata, independent of the
  // publication of scores. Never fabricate a run or change snapshot eligibility.
  const custom_boards=admin?[]:(await db.prepare(`SELECT leaderboard_id,name,type,campaign_id,vote_type FROM leaderboards
    WHERE type='custom' AND is_public=1 AND status='active' AND (? IS NULL OR leaderboard_id=?)
    ORDER BY created_at,leaderboard_id`).bind(id,id).all()).results;
  return { generated_at: boards.reduce((latest,b) => b.generated_at > latest ? b.generated_at : latest,'' ) || null, leaderboards:boards, custom_boards };
}
