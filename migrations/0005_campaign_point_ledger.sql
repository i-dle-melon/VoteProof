-- Local-only B5B. No Campaign seeds, point backfill or Production bootstrap.
CREATE TABLE campaigns (
  campaign_id TEXT PRIMARY KEY NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 50),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL CHECK (start_at < end_at),
  campaign_timezone TEXT NOT NULL,
  vote_start_date TEXT NOT NULL,
  vote_end_date TEXT NOT NULL CHECK (vote_start_date <= vote_end_date),
  points_per_proof INTEGER NOT NULL CHECK (typeof(points_per_proof) = 'integer' AND points_per_proof BETWEEN 0 AND 1000000),
  daily_limit INTEGER NOT NULL CHECK (typeof(daily_limit) = 'integer' AND daily_limit BETWEEN 0 AND 1000),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'closed', 'archived')),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT REFERENCES members(member_id),
  updated_by TEXT REFERENCES members(member_id),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_mutation_id TEXT UNIQUE
);
CREATE INDEX idx_campaigns_public ON campaigns(status, start_at, campaign_id);
CREATE INDEX idx_campaigns_admin ON campaigns(created_at DESC, campaign_id DESC);
CREATE TRIGGER campaigns_immutable_id BEFORE UPDATE OF campaign_id ON campaigns
WHEN NEW.campaign_id != OLD.campaign_id
BEGIN SELECT RAISE(ABORT, 'Campaign identity is immutable'); END;
CREATE TRIGGER campaigns_no_delete BEFORE DELETE ON campaigns
BEGIN SELECT RAISE(ABORT, 'Archive campaigns instead of deleting'); END;
CREATE TRIGGER campaigns_no_replace BEFORE INSERT ON campaigns
WHEN EXISTS (SELECT 1 FROM campaigns WHERE campaign_id = NEW.campaign_id)
BEGIN SELECT RAISE(ABORT, 'Campaign identity already exists'); END;
CREATE TRIGGER campaigns_update_policy BEFORE UPDATE ON campaigns
WHEN OLD.status = 'archived'
  OR (OLD.status != NEW.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('active', 'archived')) OR
    (OLD.status = 'active' AND NEW.status = 'closed') OR
    (OLD.status = 'closed' AND NEW.status = 'archived')))
  OR (OLD.status != 'draft' AND (OLD.start_at != NEW.start_at OR OLD.end_at != NEW.end_at
    OR OLD.campaign_timezone != NEW.campaign_timezone OR OLD.vote_start_date != NEW.vote_start_date OR OLD.vote_end_date != NEW.vote_end_date))
BEGIN SELECT RAISE(ABORT, 'Invalid campaign transition or window change'); END;

CREATE TABLE point_transactions (
  transaction_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  case_id TEXT REFERENCES cases(id),
  campaign_id TEXT REFERENCES campaigns(campaign_id),
  category TEXT NOT NULL CHECK (category IN ('proof_approved', 'proof_revoked', 'manual_adjustment', 'proof_reapproved')),
  vote_type TEXT CHECK (vote_type IS NULL OR vote_type IN ('Solo', '團體')),
  vote_date TEXT,
  points INTEGER NOT NULL CHECK (typeof(points) = 'integer' AND points != 0 AND points BETWEEN -1000000 AND 1000000),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by TEXT NOT NULL REFERENCES members(member_id),
  reference_transaction_id TEXT REFERENCES point_transactions(transaction_id),
  metadata_json TEXT CHECK (metadata_json IS NULL OR (json_valid(metadata_json) AND length(metadata_json) <= 2048)),
  idempotency_hash TEXT UNIQUE CHECK (idempotency_hash IS NULL OR length(idempotency_hash) = 64),
  request_hash TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64),
  CHECK ((category = 'manual_adjustment' AND case_id IS NULL AND campaign_id IS NULL AND vote_type IS NULL AND vote_date IS NULL
      AND reference_transaction_id IS NULL AND idempotency_hash IS NOT NULL AND request_hash IS NOT NULL)
    OR (category != 'manual_adjustment' AND case_id IS NOT NULL AND campaign_id IS NOT NULL AND vote_type IS NOT NULL AND vote_date IS NOT NULL
      AND idempotency_hash IS NULL AND request_hash IS NULL
      AND ((category = 'proof_revoked' AND points < 0 AND reference_transaction_id IS NOT NULL)
        OR (category IN ('proof_approved', 'proof_reapproved') AND points > 0 AND reference_transaction_id IS NULL))))
);
CREATE UNIQUE INDEX idx_points_case_award ON point_transactions(case_id) WHERE category = 'proof_approved';
CREATE UNIQUE INDEX idx_points_reversal ON point_transactions(reference_transaction_id) WHERE category = 'proof_revoked';
CREATE INDEX idx_points_member_date ON point_transactions(member_id, created_at DESC, transaction_id DESC);
CREATE INDEX idx_points_daily ON point_transactions(member_id, campaign_id, vote_date, category);
CREATE INDEX idx_points_case ON point_transactions(case_id);
CREATE TRIGGER points_no_update BEFORE UPDATE ON point_transactions
BEGIN SELECT RAISE(ABORT, 'Point ledger is immutable'); END;
CREATE TRIGGER points_no_delete BEFORE DELETE ON point_transactions
BEGIN SELECT RAISE(ABORT, 'Point ledger is immutable'); END;
CREATE TRIGGER points_no_replace BEFORE INSERT ON point_transactions
WHEN EXISTS (SELECT 1 FROM point_transactions p WHERE p.transaction_id = NEW.transaction_id
  OR (NEW.idempotency_hash IS NOT NULL AND p.idempotency_hash = NEW.idempotency_hash)
  OR (NEW.category = 'proof_approved' AND p.category = 'proof_approved' AND p.case_id = NEW.case_id)
  OR (NEW.category = 'proof_revoked' AND p.category = 'proof_revoked' AND p.reference_transaction_id = NEW.reference_transaction_id))
BEGIN SELECT RAISE(ABORT, 'Point ledger conflict'); END;
CREATE TRIGGER points_case_binding BEFORE INSERT ON point_transactions
WHEN NEW.case_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.id = NEW.case_id
  AND c.member_id = NEW.member_id AND c.campaign_id = NEW.campaign_id AND c.vote_type = NEW.vote_type AND c.vote_date = NEW.vote_date
  AND ((NEW.category IN ('proof_approved', 'proof_reapproved') AND c.status = 'approved') OR (NEW.category = 'proof_revoked' AND c.status = 'revoked')))
BEGIN SELECT RAISE(ABORT, 'Point transaction does not match case'); END;
CREATE TRIGGER points_exact_reversal BEFORE INSERT ON point_transactions
WHEN NEW.category = 'proof_revoked' AND NOT EXISTS (SELECT 1 FROM point_transactions p WHERE p.transaction_id = NEW.reference_transaction_id
  AND p.category IN ('proof_approved', 'proof_reapproved') AND p.case_id = NEW.case_id AND p.member_id = NEW.member_id
  AND p.campaign_id = NEW.campaign_id AND p.vote_type = NEW.vote_type AND p.vote_date = NEW.vote_date AND NEW.points = -p.points)
BEGIN SELECT RAISE(ABORT, 'Invalid point reversal'); END;

ALTER TABLE cases ADD COLUMN point_transaction_id TEXT REFERENCES point_transactions(transaction_id);
CREATE TRIGGER cases_guest_points_insert BEFORE INSERT ON cases
WHEN NEW.member_id IS NULL AND NEW.points_awarded != 0
BEGIN SELECT RAISE(ABORT, 'Guests cannot earn member points'); END;
CREATE TRIGGER cases_guest_points_update BEFORE UPDATE ON cases
WHEN NEW.member_id IS NULL AND NEW.points_awarded != 0
BEGIN SELECT RAISE(ABORT, 'Guests cannot earn member points'); END;

-- Expand B5A audit enums while preserving every existing record. Migration
-- history is unchanged; the rebuild executes inside the migration transaction.
CREATE TABLE admin_audit_logs_next (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  admin_member_id TEXT NOT NULL REFERENCES members(member_id),
  admin_role TEXT NOT NULL CHECK (admin_role IN ('super_admin', 'admin', 'reviewer')),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'mark_duplicate', 'complete', 'revoke', 'bootstrap_membership', 'campaign_create', 'campaign_update', 'manual_adjustment')),
  target_type TEXT NOT NULL CHECK (target_type IN ('case', 'admin_membership', 'campaign', 'point_transaction')),
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
