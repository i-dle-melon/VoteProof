-- Local/source only. No seeds, proof changes, points or Production activation.
CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  owner_member_id TEXT NOT NULL REFERENCES members(member_id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  filters_json TEXT NOT NULL CHECK(json_valid(filters_json)),
  from_utc TEXT NOT NULL,
  to_utc TEXT NOT NULL CHECK(from_utc < to_utc),
  campaign_name TEXT,
  image_count INTEGER NOT NULL DEFAULT 0 CHECK(image_count BETWEEN 0 AND 20000),
  total_bytes INTEGER NOT NULL DEFAULT 0,
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1))
);
CREATE TABLE export_job_items (
  job_id TEXT NOT NULL REFERENCES export_jobs(id),
  ordinal INTEGER NOT NULL,
  package_no INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  vote_type TEXT NOT NULL,
  source TEXT NOT NULL,
  review_status TEXT NOT NULL,
  review_stage TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size > 0 AND file_size <= 5242880),
  etag TEXT NOT NULL,
  sha256 TEXT,
  PRIMARY KEY(job_id, ordinal),
  UNIQUE(job_id, file_id)
);
CREATE TABLE export_packages (
  job_id TEXT NOT NULL REFERENCES export_jobs(id),
  number INTEGER NOT NULL,
  image_count INTEGER NOT NULL CHECK(image_count BETWEEN 1 AND 500),
  total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN 1 AND 536870912),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','failed')),
  attempt_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  PRIMARY KEY(job_id, number)
);
-- New-table indexes only: covered package seeks and latest owned jobs.
CREATE INDEX idx_export_items_package ON export_job_items(job_id, package_no, ordinal);
CREATE INDEX idx_export_jobs_owner ON export_jobs(owner_member_id, created_at DESC, id DESC);
CREATE TRIGGER export_items_no_update BEFORE UPDATE ON export_job_items
BEGIN SELECT RAISE(ABORT, 'Export snapshot is immutable'); END;
CREATE TRIGGER export_items_no_delete BEFORE DELETE ON export_job_items
BEGIN SELECT RAISE(ABORT, 'Export snapshot is immutable'); END;
CREATE TRIGGER export_items_no_replace BEFORE INSERT ON export_job_items
WHEN EXISTS (SELECT 1 FROM export_job_items WHERE job_id=NEW.job_id AND (ordinal=NEW.ordinal OR file_id=NEW.file_id))
BEGIN SELECT RAISE(ABORT, 'Export snapshot already exists'); END;
CREATE TRIGGER export_jobs_binding BEFORE UPDATE OF id,owner_member_id,filters_json,from_utc,to_utc,campaign_name,created_at,expires_at ON export_jobs
BEGIN SELECT RAISE(ABORT, 'Export query is immutable'); END;
CREATE TRIGGER export_packages_binding BEFORE UPDATE OF job_id,number,image_count,total_bytes ON export_packages
BEGIN SELECT RAISE(ABORT, 'Export package boundary is immutable'); END;
CREATE TRIGGER export_items_sealed BEFORE INSERT ON export_job_items
WHEN (SELECT sealed FROM export_jobs WHERE id=NEW.job_id)=1
BEGIN SELECT RAISE(ABORT, 'Export snapshot is sealed'); END;
CREATE TRIGGER export_packages_sealed BEFORE INSERT ON export_packages
WHEN (SELECT sealed FROM export_jobs WHERE id=NEW.job_id)=1
BEGIN SELECT RAISE(ABORT, 'Export package list is sealed'); END;
CREATE TRIGGER export_jobs_sealed BEFORE UPDATE ON export_jobs
WHEN OLD.sealed=1
BEGIN SELECT RAISE(ABORT, 'Export job is sealed'); END;
CREATE TRIGGER export_jobs_no_replace BEFORE INSERT ON export_jobs
WHEN EXISTS(SELECT 1 FROM export_jobs WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'Export job already exists'); END;
