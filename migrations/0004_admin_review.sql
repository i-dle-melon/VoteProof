-- Local-only B5A. No default memberships or Production bootstrap data.
CREATE TABLE admin_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL UNIQUE REFERENCES members(member_id),
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'reviewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES members(member_id),
  updated_at TEXT NOT NULL
);

ALTER TABLE cases ADD COLUMN status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 500);
ALTER TABLE cases ADD COLUMN status_updated_at TEXT;
ALTER TABLE cases ADD COLUMN status_updated_by TEXT REFERENCES members(member_id);
ALTER TABLE cases ADD COLUMN duplicate_of_case_id TEXT REFERENCES cases(id);
ALTER TABLE cases ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);
ALTER TABLE cases ADD COLUMN last_review_id TEXT;
CREATE UNIQUE INDEX idx_cases_last_review ON cases(last_review_id) WHERE last_review_id IS NOT NULL;
CREATE INDEX idx_cases_admin_queue ON cases((CASE WHEN status = 'pending' THEN 0 ELSE 1 END), created_at DESC, id DESC);
CREATE INDEX idx_cases_duplicate_target ON cases(duplicate_of_case_id) WHERE duplicate_of_case_id IS NOT NULL;

CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  admin_member_id TEXT NOT NULL REFERENCES members(member_id),
  admin_role TEXT NOT NULL CHECK (admin_role IN ('super_admin', 'admin', 'reviewer')),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'mark_duplicate', 'complete', 'revoke', 'bootstrap_membership')),
  target_type TEXT NOT NULL CHECK (target_type IN ('case', 'admin_membership')),
  target_id TEXT NOT NULL,
  target_version INTEGER,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  UNIQUE (target_type, target_id, target_version)
);
CREATE INDEX idx_admin_audit_cursor ON admin_audit_logs(created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_target ON admin_audit_logs(target_type, target_id, created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_actor ON admin_audit_logs(admin_member_id, created_at DESC, id DESC);

-- SQLite REPLACE can bypass DELETE triggers when recursive_triggers is off.
-- Reject conflicting INSERTs before conflict resolution can remove old rows.
CREATE TRIGGER admin_audit_no_replace BEFORE INSERT ON admin_audit_logs
WHEN EXISTS (SELECT 1 FROM admin_audit_logs a WHERE a.id = NEW.id
  OR (a.target_type = NEW.target_type AND a.target_id = NEW.target_id AND a.target_version = NEW.target_version))
BEGIN
  SELECT RAISE(ABORT, 'Audit records are immutable');
END;
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Audit records are immutable');
END;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Audit records are immutable');
END;

-- Enforce consistency even if a future writer omits API validation.
CREATE TRIGGER cases_duplicate_insert BEFORE INSERT ON cases
WHEN (NEW.status = 'duplicate' AND (NEW.duplicate_flag != 1 OR NEW.duplicate_of_case_id IS NULL OR NEW.duplicate_of_case_id = NEW.id))
  OR (NEW.status != 'duplicate' AND (NEW.duplicate_flag != 0 OR NEW.duplicate_of_case_id IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'Invalid duplicate reference');
END;
CREATE TRIGGER cases_duplicate_update BEFORE UPDATE ON cases
WHEN (NEW.status = 'duplicate' AND (NEW.duplicate_flag != 1 OR NEW.duplicate_of_case_id IS NULL OR NEW.duplicate_of_case_id = NEW.id))
  OR (NEW.status != 'duplicate' AND (NEW.duplicate_flag != 0 OR NEW.duplicate_of_case_id IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'Invalid duplicate reference');
END;
