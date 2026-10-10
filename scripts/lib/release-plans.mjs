// Offline release artifacts only. Never imported by the Worker.
import { randomUUID } from 'node:crypto';
import { campaignInput } from '../../src/lib/campaign-policy.js';
import { CASE_ID_PATTERN } from '../../src/lib/case-keys.js';

export const DATABASE = 'voteproof-cases';
export const DATABASE_ID = '9e2b885d-66e2-4e4d-b768-4bded261296a';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const member = /^M-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = () => { throw new Error('INVALID_RELEASE_PLAN'); };
const text = value => { if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) fail(); return value; };
export const literal = value => value === null ? 'NULL' : typeof value === 'number' && Number.isSafeInteger(value)
  ? String(value) : "'" + text(value).replaceAll("'", "''") + "'";
function reason(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 500 || /[\u0000-\u001f\u007f]/.test(value)) fail();
  return value.trim();
}
function actorMember(value) { if (typeof value !== 'string' || !member.test(value)) fail(); return value; }
const epoch = "CAST(strftime('%s','now') AS INTEGER)";
const timestamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const activeMfa = id => `EXISTS(SELECT 1 FROM members m JOIN member_credentials c USING(member_id)
 JOIN auth_identities i USING(member_id) JOIN auth_sessions s USING(member_id)
 WHERE m.member_id=${literal(id)} AND m.status='active' AND c.last_used_time_step>0
 AND s.revoked_at IS NULL AND s.expires_at>${epoch} AND s.elevated_until>${epoch}
 AND s.reauthenticated_until>${epoch}
 AND NOT EXISTS(SELECT 1 FROM auth_password_operations o WHERE o.member_id=m.member_id AND o.status='pending'))`;
function guardSql(id, condition) {
  return `INSERT INTO auth_atomic_guards(id,valid) VALUES(${literal(id)},CASE WHEN ${condition} THEN 1 ELSE 0 END);`;
}
export function adminBootstrapPlan(input) {
  if (!input || Object.keys(input).some(k=>!['member_id','role','reason'].includes(k))) fail();
  const id=actorMember(input.member_id), role=input.role, why=reason(input.reason);
  if (!['admin','super_admin'].includes(role)) fail(); // First administrative membership only.
  const membership=randomUUID(), audit=randomUUID(), guard=randomUUID();
  const sql=[
    guardSql(guard, `${activeMfa(id)} AND NOT EXISTS(SELECT 1 FROM admin_memberships)`),
    `INSERT INTO admin_memberships(id,member_id,role,status,created_at,created_by,updated_at)
 VALUES(${literal(membership)},${literal(id)},${literal(role)},'active',${timestamp},${literal(id)},${timestamp});`,
    `INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json,reason)
 VALUES(${literal(audit)},${timestamp},${literal(id)},${literal(role)},'bootstrap_membership','admin_membership',${literal(membership)},0,'{}',
 json_object('member_id',${literal(id)},'role',${literal(role)},'status','active'),${literal(why)});`,
    `DELETE FROM auth_atomic_guards WHERE id=${literal(guard)};`,
  ].join('\n');
  return {kind:'initial_admin', member_id:id, role, sql};
}
export function campaignBootstrapPlan(input) {
  if (!input || Object.keys(input).some(k=>!['actor_member_id','reason','campaign'].includes(k))) fail();
  const id=actorMember(input.actor_member_id), why=reason(input.reason);
  let c; try { c=campaignInput(input.campaign); } catch { fail(); }
  const guard=randomUUID(), marker=randomUUID();
  const columns=['campaign_id','name','category','start_at','end_at','campaign_timezone','vote_start_date','vote_end_date','points_per_proof','daily_limit','status','note'];
  const sql=[
    guardSql(guard, `${activeMfa(id)} AND EXISTS(SELECT 1 FROM admin_memberships WHERE member_id=${literal(id)} AND status='active' AND role IN('admin','super_admin'))
 AND NOT EXISTS(SELECT 1 FROM campaigns WHERE campaign_id=${literal(c.campaign_id)})`),
    `INSERT INTO campaigns(${columns.join(',')},created_at,updated_at,created_by,updated_by,last_mutation_id)
 VALUES(${columns.map(k=>literal(c[k])).join(',')},${timestamp},${timestamp},${literal(id)},${literal(id)},${literal(marker)});`,
    `INSERT INTO admin_audit_logs(id,created_at,admin_member_id,admin_role,action,target_type,target_id,target_version,before_json,after_json,reason)
 SELECT ${literal(marker)},${timestamp},${literal(id)},a.role,'campaign_create','campaign',c.campaign_id,c.version,'{}',
 json_object('campaign_id',c.campaign_id,'name',c.name,'category',c.category,'start_at',c.start_at,'end_at',c.end_at,
 'campaign_timezone',c.campaign_timezone,'points_per_proof',c.points_per_proof,'daily_limit',c.daily_limit,'status',c.status,'version',c.version),${literal(why)}
 FROM campaigns c JOIN admin_memberships a ON a.member_id=${literal(id)} WHERE c.last_mutation_id=${literal(marker)};`,
    `DELETE FROM auth_atomic_guards WHERE id=${literal(guard)};`,
  ].join('\n');
  return {kind:'campaign',campaign_id:c.campaign_id,status:c.status,sql};
}
export function legacyCleanupPlan(input) {
  // Input must be a private inventory tied to the original acceptance report,
  // not a filename/campaign/nickname guess or a wildcard deletion request.
  if (!input || input.case_id!==input.recorded_case_id || !CASE_ID_PATTERN.test(input.case_id??'') ||
      !uuid.test(input.id??'') || !uuid.test(input.upload_session_id??'') ||
      typeof input.campaign_id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.campaign_id) ||
      input.status!=='pending' || input.member_id!==null || input.points_awarded!==0 || input.total_cases!==1 ||
      input.acceptance_release!=='de6e15f25cf94c66df92d7d179bda589f2f848af' || input.files?.length!==1 || input.upload_files?.length!==1) fail();
  const f=input.files[0], u=input.upload_files[0];
  const extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[f.content_type];
  if (!uuid.test(f.id??'') || !['image/png','image/jpeg','image/webp'].includes(f.content_type) ||
      !Number.isSafeInteger(f.size) || f.size<=0 || f.size>5242880 || typeof f.etag!=='string' || !f.etag ||
      f.upload_object_key!==u.object_key || f.case_id!==input.id || u.session_id!==input.upload_session_id ||
      f.object_key!==`proofs/cases/${input.id}/${f.id}.${extension}` ||
      !new RegExp('^proofs/staging/\\d{4}/\\d{2}/\\d{2}/'+input.upload_session_id+'/[a-f0-9-]{36}\\.(png|jpg|webp)$','i').test(u.object_key??'')) fail();
  const sql=[
    'CREATE TABLE _vp_release_cleanup_guard(valid INTEGER NOT NULL CHECK(valid=1));',
    `INSERT INTO _vp_release_cleanup_guard VALUES(CASE WHEN (SELECT COUNT(*) FROM cases)=1 AND EXISTS(
 SELECT 1 FROM cases c JOIN completed_uploads u ON u.session_id=c.upload_session_id WHERE c.id=${literal(input.id)}
 AND c.case_id=${literal(input.case_id)} AND c.campaign_id=${literal(input.campaign_id)} AND c.status='pending'
 AND c.member_id IS NULL AND c.points_awarded=0 AND c.duplicate_flag=0 AND c.upload_session_id=${literal(input.upload_session_id)}
 AND u.consumed_case_id=c.id) AND (SELECT COUNT(*) FROM case_files WHERE case_id=${literal(input.id)})=1
 AND EXISTS(SELECT 1 FROM case_files WHERE id=${literal(f.id)} AND case_id=${literal(input.id)} AND object_key=${literal(f.object_key)}
 AND upload_object_key=${literal(u.object_key)} AND size=${literal(f.size)} AND etag=${literal(f.etag)} AND content_type=${literal(f.content_type)})
 AND (SELECT COUNT(*) FROM completed_upload_files WHERE session_id=${literal(input.upload_session_id)})=1
 AND EXISTS(SELECT 1 FROM completed_upload_files WHERE session_id=${literal(input.upload_session_id)} AND object_key=${literal(u.object_key)})
 THEN 1 ELSE 0 END);`,
    `DELETE FROM case_files WHERE case_id=${literal(input.id)};`,
    `DELETE FROM case_idempotency WHERE case_id=${literal(input.id)};`,
    `UPDATE completed_uploads SET consumed_case_id=NULL,consumed_at=NULL WHERE session_id=${literal(input.upload_session_id)};`,
    `DELETE FROM cases WHERE id=${literal(input.id)};`,
    `DELETE FROM completed_upload_files WHERE session_id=${literal(input.upload_session_id)};`,
    `DELETE FROM completed_uploads WHERE session_id=${literal(input.upload_session_id)};`,
    'DROP TABLE _vp_release_cleanup_guard;',
  ].join('\n');
  return {kind:'legacy_acceptance_cleanup',sql,r2_keys:[f.object_key,u.object_key]};
}
