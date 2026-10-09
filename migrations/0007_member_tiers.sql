-- Fixed identities only. Unapproved thresholds are NULL, never test values.
CREATE TABLE member_tiers (
  tier_id TEXT PRIMARY KEY NOT NULL CHECK(tier_id IN ('normal','bronze','silver','gold','platinum','emerald','diamond','stellar')),
  name TEXT NOT NULL CHECK(name = CASE tier_id WHEN 'normal' THEN '普通' WHEN 'bronze' THEN '青銅' WHEN 'silver' THEN '白銀'
    WHEN 'gold' THEN '黃金' WHEN 'platinum' THEN '白金' WHEN 'emerald' THEN '翡翠' WHEN 'diamond' THEN '鑽石' WHEN 'stellar' THEN '星耀' END),
  rank_order INTEGER NOT NULL UNIQUE CHECK(rank_order = CASE tier_id WHEN 'normal' THEN 1 WHEN 'bronze' THEN 2 WHEN 'silver' THEN 3
    WHEN 'gold' THEN 4 WHEN 'platinum' THEN 5 WHEN 'emerald' THEN 6 WHEN 'diamond' THEN 7 WHEN 'stellar' THEN 8 END),
  min_points INTEGER UNIQUE CHECK(min_points IS NULL OR (typeof(min_points) = 'integer' AND min_points BETWEEN 0 AND 1000000000)),
  icon_key TEXT NOT NULL CHECK(icon_key = tier_id),
  status TEXT NOT NULL CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT REFERENCES members(member_id),
  updated_by TEXT REFERENCES members(member_id),
  version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(version) = 'integer' AND version >= 0),
  last_mutation_id TEXT UNIQUE,
  CHECK((tier_id = 'normal' AND min_points = 0 AND status = 'active') OR tier_id != 'normal'),
  CHECK(status != 'active' OR min_points IS NOT NULL)
);
CREATE TRIGGER member_tiers_identity BEFORE UPDATE ON member_tiers
WHEN NEW.tier_id != OLD.tier_id OR NEW.name != OLD.name OR NEW.rank_order != OLD.rank_order OR NEW.icon_key != OLD.icon_key
BEGIN SELECT RAISE(ABORT, 'Tier identity is immutable'); END;
CREATE TRIGGER member_tiers_no_delete BEFORE DELETE ON member_tiers
BEGIN SELECT RAISE(ABORT, 'Fixed tiers cannot be deleted'); END;
CREATE TRIGGER member_tiers_no_replace BEFORE INSERT ON member_tiers
WHEN EXISTS(SELECT 1 FROM member_tiers WHERE tier_id = NEW.tier_id)
BEGIN SELECT RAISE(ABORT, 'Tier identity exists'); END;
CREATE TRIGGER member_tiers_order_insert BEFORE INSERT ON member_tiers
WHEN NEW.min_points IS NOT NULL AND EXISTS(SELECT 1 FROM member_tiers t WHERE t.min_points IS NOT NULL
  AND ((t.rank_order < NEW.rank_order AND t.min_points >= NEW.min_points) OR (t.rank_order > NEW.rank_order AND t.min_points <= NEW.min_points)))
BEGIN SELECT RAISE(ABORT, 'Tier thresholds must increase'); END;
CREATE TRIGGER member_tiers_order_update BEFORE UPDATE OF min_points ON member_tiers
WHEN NEW.min_points IS NOT NULL AND EXISTS(SELECT 1 FROM member_tiers t WHERE t.tier_id != OLD.tier_id AND t.min_points IS NOT NULL
  AND ((t.rank_order < NEW.rank_order AND t.min_points >= NEW.min_points) OR (t.rank_order > NEW.rank_order AND t.min_points <= NEW.min_points)))
BEGIN SELECT RAISE(ABORT, 'Tier thresholds must increase'); END;
INSERT INTO member_tiers(tier_id,name,rank_order,min_points,icon_key,status,created_at,updated_at)
VALUES
 ('normal','普通',1,0,'normal','active',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('bronze','青銅',2,NULL,'bronze','disabled',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('silver','白銀',3,NULL,'silver','disabled',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gold','黃金',4,NULL,'gold','disabled',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('platinum','白金',5,NULL,'platinum','disabled',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('emerald','翡翠',6,NULL,'emerald','disabled',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('diamond','鑽石',7,NULL,'diamond','disabled',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('stellar','星耀',8,NULL,'stellar','disabled',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE admin_audit_logs_next (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  admin_member_id TEXT NOT NULL REFERENCES members(member_id),
  admin_role TEXT NOT NULL CHECK (admin_role IN ('super_admin', 'admin', 'reviewer')),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'mark_duplicate', 'complete', 'revoke', 'bootstrap_membership', 'campaign_create', 'campaign_update', 'manual_adjustment', 'leaderboard_create', 'leaderboard_update', 'leaderboard_rebuild', 'leaderboard_archive', 'member_tier_update')),
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
