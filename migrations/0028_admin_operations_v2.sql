-- Additive admin operations only; no seeds, image writes, points or activation.
CREATE INDEX idx_cases_initial_review ON cases(created_at,id,updated_at,case_id,version)
 WHERE status='pending' AND review_stage='initial' AND review_risk_reason IS NULL;
CREATE INDEX idx_backup_status_created ON proof_backups(provider,status,created_at,id);
CREATE INDEX idx_export_jobs_shared ON export_jobs(created_at DESC,id DESC);
ALTER TABLE export_packages ADD COLUMN claim_member_id TEXT REFERENCES members(member_id);
ALTER TABLE export_packages ADD COLUMN lease_until INTEGER;
CREATE TABLE export_scope_locks (
  scope_key TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES export_jobs(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE export_file_claims (
  file_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  package_no INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  lease_until INTEGER NOT NULL,
  FOREIGN KEY(job_id,package_no) REFERENCES export_packages(job_id,number)
);
CREATE INDEX idx_export_file_claim_package ON export_file_claims(job_id,package_no,attempt_id);
CREATE TABLE export_completed_files (
  file_id TEXT NOT NULL,
  etag TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  job_id TEXT NOT NULL,
  package_no INTEGER NOT NULL,
  confirmed_by TEXT NOT NULL REFERENCES members(member_id),
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY(file_id,etag,file_size,content_type)
);
CREATE TABLE export_operation_audit (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  job_id TEXT NOT NULL,
  package_no INTEGER,
  action TEXT NOT NULL CHECK(action IN ('snapshot','reuse','start','redownload','completed','failed')),
  attempt_id TEXT
);
CREATE INDEX idx_export_operation_history ON export_operation_audit(created_at DESC,id DESC);
CREATE INDEX idx_export_operation_attempt ON export_operation_audit(job_id,package_no,member_id,attempt_id,action);
-- Preserve existing authoritative completion acknowledgements. Merely planned,
-- failed or in-progress jobs never become global completed-file records.
INSERT INTO export_completed_files
 SELECT file_id,etag,file_size,content_type,job_id,package_no,owner_member_id,completed_at FROM (
  SELECT i.*,j.owner_member_id,p.completed_at,ROW_NUMBER() OVER (
   PARTITION BY i.file_id,i.etag,i.file_size,i.content_type ORDER BY p.completed_at,i.job_id,i.package_no) AS n
  FROM export_job_items i JOIN export_jobs j ON j.id=i.job_id
  JOIN export_packages p ON p.job_id=i.job_id AND p.number=i.package_no
  JOIN case_files f ON f.id=i.file_id AND f.etag=i.etag AND f.size=i.file_size AND f.content_type=i.content_type
  WHERE p.status='completed' AND p.completed_at IS NOT NULL
 ) WHERE n=1;
CREATE TRIGGER export_completed_no_update BEFORE UPDATE ON export_completed_files BEGIN SELECT RAISE(ABORT,'Export completion is immutable'); END;
CREATE TRIGGER export_completed_no_delete BEFORE DELETE ON export_completed_files BEGIN SELECT RAISE(ABORT,'Export completion is immutable'); END;
CREATE TRIGGER export_completed_no_replace BEFORE INSERT ON export_completed_files
WHEN EXISTS(SELECT 1 FROM export_completed_files WHERE file_id=NEW.file_id AND etag=NEW.etag AND file_size=NEW.file_size AND content_type=NEW.content_type)
BEGIN SELECT RAISE(ABORT,'Export completion already exists'); END;
CREATE TRIGGER export_operation_no_update BEFORE UPDATE ON export_operation_audit BEGIN SELECT RAISE(ABORT,'Export audit is immutable'); END;
CREATE TRIGGER export_operation_no_delete BEFORE DELETE ON export_operation_audit BEGIN SELECT RAISE(ABORT,'Export audit is immutable'); END;
CREATE TRIGGER export_operation_no_replace BEFORE INSERT ON export_operation_audit
WHEN EXISTS(SELECT 1 FROM export_operation_audit WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Export audit already exists'); END;
