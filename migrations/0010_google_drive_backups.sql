-- Additive only. No backfill, seed data, storage deletion or automatic activation.
CREATE TABLE proof_backups (
  id TEXT PRIMARY KEY NOT NULL,
  file_id TEXT NOT NULL REFERENCES case_files(id),
  provider TEXT NOT NULL CHECK(provider = 'google_drive'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','confirmed','failed')),
  source_object_key TEXT NOT NULL,
  source_size INTEGER NOT NULL CHECK(source_size > 0 AND source_size <= 5242880),
  source_mime TEXT NOT NULL CHECK(source_mime IN ('image/png','image/jpeg','image/webp')),
  source_etag TEXT NOT NULL,
  drive_file_id TEXT UNIQUE,
  drive_folder_id TEXT,
  root_folder_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  last_error_code TEXT CHECK(last_error_code IS NULL OR last_error_code IN (
    'NETWORK','RATE_LIMIT','GOOGLE_UNAVAILABLE','OAUTH_REVOKED','OAUTH_CONFIG',
    'DRIVE_ACCESS_DENIED','DRIVE_FULL','ROOT_INACCESSIBLE','SOURCE_MISSING',
    'SOURCE_CHANGED','VERIFY_FAILED','UPLOAD_INCOMPLETE','INVALID_SOURCE','CONFIG_MISSING','INTERNAL')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  UNIQUE(file_id, provider),
  CHECK(status != 'confirmed' OR (drive_file_id IS NOT NULL AND drive_folder_id IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX idx_proof_backups_due ON proof_backups(status, next_attempt_at, lease_until);

-- IDs are durably reserved BEFORE remote creation, for folders as well as files.
CREATE TABLE drive_backup_folders (
  root_folder_id TEXT NOT NULL,
  folder_key TEXT NOT NULL,
  drive_folder_id TEXT NOT NULL UNIQUE,
  parent_folder_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(root_folder_id, folder_key)
);
CREATE TABLE backup_processor_lock (
  id INTEGER PRIMARY KEY CHECK(id=1),
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  blocked_error_code TEXT CHECK(blocked_error_code IS NULL OR blocked_error_code IN (
    'CONFIG_MISSING','OAUTH_REVOKED','OAUTH_CONFIG','ROOT_INACCESSIBLE','DRIVE_ACCESS_DENIED','DRIVE_FULL'))
);
CREATE TABLE backup_admin_audit (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  admin_member_id TEXT NOT NULL REFERENCES members(member_id),
  action TEXT NOT NULL CHECK(action IN ('retry','backfill')),
  target_id TEXT NOT NULL,
  affected_count INTEGER NOT NULL CHECK(affected_count >= 0)
);
CREATE TRIGGER backup_audit_no_update BEFORE UPDATE ON backup_admin_audit
BEGIN SELECT RAISE(ABORT, 'Backup audit is immutable'); END;
CREATE TRIGGER backup_audit_no_delete BEFORE DELETE ON backup_admin_audit
BEGIN SELECT RAISE(ABORT, 'Backup audit is immutable'); END;
CREATE TRIGGER backup_audit_no_replace BEFORE INSERT ON backup_admin_audit
WHEN EXISTS(SELECT 1 FROM backup_admin_audit WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'Backup audit is immutable'); END;
