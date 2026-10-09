-- Local B5C. Snapshots are derived; point_transactions remains authoritative.
CREATE TABLE leaderboards (
  leaderboard_id TEXT PRIMARY KEY NOT NULL CHECK(length(leaderboard_id) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  type TEXT NOT NULL CHECK(type IN ('all_time','campaign','custom')),
  campaign_id TEXT REFERENCES campaigns(campaign_id),
  start_date TEXT,
  end_date TEXT,
  vote_type TEXT CHECK(vote_type IS NULL OR vote_type IN ('Solo','團體')),
  top_n INTEGER NOT NULL CHECK(typeof(top_n) = 'integer' AND top_n BETWEEN 1 AND 100),
  is_public INTEGER NOT NULL CHECK(is_public IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('draft','active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(member_id),
  updated_by TEXT NOT NULL REFERENCES members(member_id),
  version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(version) = 'integer' AND version >= 0),
  last_mutation_id TEXT UNIQUE,
  current_run_id TEXT,
  FOREIGN KEY(current_run_id, leaderboard_id) REFERENCES leaderboard_runs(run_id, leaderboard_id),
  CHECK((type = 'all_time' AND campaign_id IS NULL AND start_date IS NULL AND end_date IS NULL)
    OR (type = 'campaign' AND campaign_id IS NOT NULL AND start_date IS NULL AND end_date IS NULL)
    OR (type = 'custom' AND start_date IS NOT NULL AND end_date IS NOT NULL
      AND length(start_date) = 10 AND length(end_date) = 10 AND start_date <= end_date))
);
CREATE INDEX idx_leaderboards_public ON leaderboards(status, is_public, leaderboard_id);
CREATE INDEX idx_leaderboards_admin ON leaderboards(created_at DESC, leaderboard_id DESC);
CREATE TABLE leaderboard_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  leaderboard_id TEXT NOT NULL REFERENCES leaderboards(leaderboard_id),
  generated_at TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK(definition_version >= 0),
  source_count INTEGER NOT NULL CHECK(source_count >= 0),
  source_last_transaction_id TEXT REFERENCES point_transactions(transaction_id),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK(status IN ('building','success')),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  integrity_errors INTEGER NOT NULL CHECK(integrity_errors = 0),
  UNIQUE(run_id, leaderboard_id)
);
CREATE INDEX idx_leaderboard_runs_history ON leaderboard_runs(leaderboard_id, generated_at DESC, run_id DESC);
CREATE TABLE leaderboard_results (
  run_id TEXT NOT NULL,
  leaderboard_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK(typeof(rank) = 'integer' AND rank BETWEEN 1 AND 100),
  member_id TEXT NOT NULL REFERENCES members(member_id),
  nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 1 AND 50),
  points INTEGER NOT NULL CHECK(typeof(points) = 'integer' AND points BETWEEN 1 AND 9007199254740991),
  proof_count INTEGER NOT NULL CHECK(typeof(proof_count) = 'integer' AND proof_count BETWEEN 0 AND 9007199254740991),
  reached_at TEXT NOT NULL,
  PRIMARY KEY(run_id, rank),
  UNIQUE(run_id, member_id),
  FOREIGN KEY(run_id, leaderboard_id) REFERENCES leaderboard_runs(run_id, leaderboard_id)
);
CREATE TRIGGER leaderboards_no_replace BEFORE INSERT ON leaderboards
WHEN EXISTS(SELECT 1 FROM leaderboards WHERE leaderboard_id = NEW.leaderboard_id)
BEGIN SELECT RAISE(ABORT, 'Leaderboard exists'); END;
CREATE TRIGGER leaderboards_no_delete BEFORE DELETE ON leaderboards
BEGIN SELECT RAISE(ABORT, 'Archive leaderboard instead'); END;
CREATE TRIGGER leaderboards_policy BEFORE UPDATE ON leaderboards
WHEN OLD.status = 'archived' OR NEW.leaderboard_id != OLD.leaderboard_id
  OR (NEW.status != OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status IN ('active','archived')) OR (OLD.status = 'active' AND NEW.status = 'archived')))
BEGIN SELECT RAISE(ABORT, 'Immutable leaderboard or invalid transition'); END;
CREATE TRIGGER leaderboards_publish BEFORE UPDATE OF current_run_id ON leaderboards
WHEN NEW.current_run_id IS NOT OLD.current_run_id AND NEW.current_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM leaderboard_runs r
  WHERE r.run_id = NEW.current_run_id AND r.leaderboard_id = NEW.leaderboard_id AND r.status = 'success' AND r.definition_version = OLD.version)
BEGIN SELECT RAISE(ABORT, 'Invalid published run'); END;
CREATE TRIGGER leaderboard_runs_no_replace BEFORE INSERT ON leaderboard_runs
WHEN EXISTS(SELECT 1 FROM leaderboard_runs WHERE run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'Run exists'); END;
CREATE TRIGGER leaderboard_runs_no_delete BEFORE DELETE ON leaderboard_runs
BEGIN SELECT RAISE(ABORT, 'Run history is immutable'); END;
CREATE TRIGGER leaderboard_runs_update BEFORE UPDATE ON leaderboard_runs
WHEN OLD.status != 'building' OR NEW.status != 'success' OR NEW.run_id != OLD.run_id
  OR NEW.leaderboard_id != OLD.leaderboard_id OR NEW.generated_at != OLD.generated_at OR NEW.definition_version != OLD.definition_version
  OR NEW.source_count != OLD.source_count OR NEW.source_last_transaction_id IS NOT OLD.source_last_transaction_id
  OR NEW.definition_json != OLD.definition_json OR NEW.integrity_errors != OLD.integrity_errors OR NEW.row_count != (SELECT COUNT(*) FROM leaderboard_results WHERE run_id = OLD.run_id)
  OR (NEW.row_count > 0 AND NEW.row_count != (SELECT MAX(rank) FROM leaderboard_results WHERE run_id = OLD.run_id))
BEGIN SELECT RAISE(ABORT, 'Run is immutable or incomplete'); END;
CREATE TRIGGER leaderboard_results_no_update BEFORE UPDATE ON leaderboard_results
BEGIN SELECT RAISE(ABORT, 'Results are immutable'); END;
CREATE TRIGGER leaderboard_results_no_delete BEFORE DELETE ON leaderboard_results
BEGIN SELECT RAISE(ABORT, 'Results are immutable'); END;
CREATE TRIGGER leaderboard_results_insert BEFORE INSERT ON leaderboard_results
WHEN EXISTS(SELECT 1 FROM leaderboard_results WHERE run_id = NEW.run_id AND (rank = NEW.rank OR member_id = NEW.member_id))
  OR NOT EXISTS(SELECT 1 FROM leaderboard_runs r JOIN leaderboards b USING(leaderboard_id)
    WHERE r.run_id = NEW.run_id AND r.leaderboard_id = NEW.leaderboard_id AND r.status = 'building' AND NEW.rank <= b.top_n)
BEGIN SELECT RAISE(ABORT, 'Results require a building run'); END;
CREATE TABLE admin_audit_logs_next (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  admin_member_id TEXT NOT NULL REFERENCES members(member_id),
  admin_role TEXT NOT NULL CHECK (admin_role IN ('super_admin', 'admin', 'reviewer')),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'mark_duplicate', 'complete', 'revoke', 'bootstrap_membership', 'campaign_create', 'campaign_update', 'manual_adjustment', 'leaderboard_create', 'leaderboard_update', 'leaderboard_rebuild', 'leaderboard_archive')),
  target_type TEXT NOT NULL CHECK (target_type IN ('case', 'admin_membership', 'campaign', 'point_transaction', 'leaderboard')),
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
