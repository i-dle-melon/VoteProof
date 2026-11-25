CREATE INDEX idx_cases_auto_completion_due ON cases(julianday(COALESCE(status_updated_at, reviewed_at)), id)
WHERE status = 'approved' AND COALESCE(status_updated_at, reviewed_at) GLOB '????-??-??*';

CREATE TABLE case_auto_completion_audit (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  approved_version INTEGER NOT NULL,
  completed_version INTEGER NOT NULL CHECK (completed_version = approved_version + 1),
  approval_review_id TEXT,
  UNIQUE (case_id, completed_version)
);

CREATE TRIGGER case_auto_completion_audit_no_replace BEFORE INSERT ON case_auto_completion_audit
WHEN EXISTS (SELECT 1 FROM case_auto_completion_audit a WHERE a.id = NEW.id
  OR (a.case_id = NEW.case_id AND a.completed_version = NEW.completed_version))
BEGIN SELECT RAISE(ABORT, 'Automatic completion audit is immutable'); END;
CREATE TRIGGER case_auto_completion_audit_no_update BEFORE UPDATE ON case_auto_completion_audit
BEGIN SELECT RAISE(ABORT, 'Automatic completion audit is immutable'); END;
CREATE TRIGGER case_auto_completion_audit_no_delete BEFORE DELETE ON case_auto_completion_audit
BEGIN SELECT RAISE(ABORT, 'Automatic completion audit is immutable'); END;
