-- Independent global gate. Bootstrap must explicitly enable submissions.
CREATE TABLE submission_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id = 1),
  submissions_enabled INTEGER NOT NULL DEFAULT 0 CHECK(submissions_enabled IN(0,1)),
  submissions_message TEXT CHECK(submissions_message IS NULL OR length(submissions_message) <= 500),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES members(member_id),
  last_mutation_id TEXT UNIQUE
);
INSERT INTO submission_settings(id, submissions_enabled, submissions_message, updated_at)
VALUES(1, 0, '投稿暫停開放，請稍後再試。', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE submission_settings_audit (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  admin_member_id TEXT NOT NULL REFERENCES members(member_id),
  admin_role TEXT NOT NULL CHECK(admin_role IN('admin','super_admin')),
  version INTEGER NOT NULL UNIQUE CHECK(version > 0),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json))
);
CREATE TRIGGER submission_audit_no_update BEFORE UPDATE ON submission_settings_audit
BEGIN SELECT RAISE(ABORT,'Submission audit is immutable'); END;
CREATE TRIGGER submission_audit_no_delete BEFORE DELETE ON submission_settings_audit
BEGIN SELECT RAISE(ABORT,'Submission audit is immutable'); END;
CREATE TRIGGER submission_audit_no_replace BEFORE INSERT ON submission_settings_audit
WHEN EXISTS(SELECT 1 FROM submission_settings_audit WHERE id=NEW.id OR version=NEW.version)
BEGIN SELECT RAISE(ABORT,'Submission audit is immutable'); END;
-- Revalidate inside D1 writes, including requests already in flight at OFF.
CREATE TRIGGER submissions_cases_insert BEFORE INSERT ON cases
WHEN NOT EXISTS(SELECT 1 FROM submission_settings WHERE id=1 AND submissions_enabled=1)
BEGIN SELECT RAISE(ABORT,'Submissions disabled'); END;
CREATE TRIGGER submissions_uploads_insert BEFORE INSERT ON completed_uploads
WHEN NOT EXISTS(SELECT 1 FROM submission_settings WHERE id=1 AND submissions_enabled=1)
BEGIN SELECT RAISE(ABORT,'Submissions disabled'); END;
CREATE TRIGGER submissions_upload_files_insert BEFORE INSERT ON completed_upload_files
WHEN NOT EXISTS(SELECT 1 FROM submission_settings WHERE id=1 AND submissions_enabled=1)
BEGIN SELECT RAISE(ABORT,'Submissions disabled'); END;
