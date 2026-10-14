-- Local/source only. Generic manual review routing; no image heuristics or scores.
ALTER TABLE cases ADD COLUMN review_stage TEXT NOT NULL DEFAULT 'initial' CHECK(review_stage IN ('initial','detailed'));
ALTER TABLE cases ADD COLUMN review_risk_reason TEXT CHECK(review_risk_reason IS NULL OR (length(review_risk_reason) BETWEEN 1 AND 64 AND review_risk_reason NOT GLOB '*[^a-z_]*'));
CREATE INDEX idx_cases_review_queue ON cases(review_stage,status,created_at DESC,id DESC);
CREATE TRIGGER cases_review_stage_policy BEFORE UPDATE OF review_stage,review_risk_reason ON cases
WHEN (NEW.review_stage IS NOT OLD.review_stage OR NEW.review_risk_reason IS NOT OLD.review_risk_reason) AND (OLD.status!='pending' OR NEW.status!='pending' OR NEW.review_stage!='detailed' OR NEW.review_risk_reason IS NULL OR NEW.version!=OLD.version+1)
BEGIN SELECT RAISE(ABORT,'Invalid detailed review transition'); END;
CREATE TABLE admin_audit_logs_next (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  admin_member_id TEXT NOT NULL REFERENCES members(member_id),
  admin_role TEXT NOT NULL CHECK (admin_role IN ('super_admin', 'admin', 'reviewer')),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'mark_duplicate', 'complete', 'revoke', 'bootstrap_membership', 'campaign_create', 'campaign_update', 'manual_adjustment', 'leaderboard_create', 'leaderboard_update', 'leaderboard_rebuild', 'leaderboard_archive', 'member_tier_update', 'flag_detailed')),
  target_type TEXT NOT NULL CHECK (target_type IN ('case', 'admin_membership', 'campaign', 'point_transaction', 'leaderboard', 'member_tier')),
  target_id TEXT NOT NULL,
  target_version INTEGER,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  UNIQUE (target_type, target_id, target_version)
);
INSERT INTO admin_audit_logs_next SELECT * FROM admin_audit_logs;
DROP TRIGGER admin_audit_no_replace;
DROP TRIGGER admin_audit_no_update;
DROP TRIGGER admin_audit_no_delete;
DROP TABLE admin_audit_logs;
ALTER TABLE admin_audit_logs_next RENAME TO admin_audit_logs;
CREATE INDEX idx_admin_audit_cursor ON admin_audit_logs(created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_target ON admin_audit_logs(target_type, target_id, created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_actor ON admin_audit_logs(admin_member_id, created_at DESC, id DESC);
CREATE TRIGGER admin_audit_no_replace BEFORE INSERT ON admin_audit_logs
WHEN EXISTS (SELECT 1 FROM admin_audit_logs a WHERE a.id = NEW.id
  OR (a.target_type = NEW.target_type AND a.target_id = NEW.target_id AND a.target_version = NEW.target_version))
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit_logs
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit_logs
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
