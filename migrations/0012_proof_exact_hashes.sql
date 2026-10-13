-- LOCAL candidate only. Do not apply to Production before separate release approval.
-- New uploads require R2-verified checksums. Existing completed metadata remains
-- unchanged; pre-0012 staging sessions must prepare again after a future rollout.
CREATE TABLE proof_upload_checksums (
  object_key TEXT PRIMARY KEY NOT NULL REFERENCES completed_upload_files(object_key),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  source_etag TEXT NOT NULL CHECK(length(source_etag)>0),
  source_size INTEGER NOT NULL CHECK(typeof(source_size)='integer' AND source_size BETWEEN 1 AND 5242880)
);
CREATE TRIGGER proof_upload_checksum_source BEFORE INSERT ON proof_upload_checksums
WHEN NOT EXISTS(SELECT 1 FROM completed_upload_files f WHERE f.object_key=NEW.object_key
  AND f.etag=NEW.source_etag AND f.size=NEW.source_size)
BEGIN SELECT RAISE(ABORT,'Upload checksum source mismatch'); END;
CREATE TRIGGER proof_upload_checksum_no_update BEFORE UPDATE ON proof_upload_checksums
BEGIN SELECT RAISE(ABORT,'Verified upload checksums are immutable'); END;
CREATE TABLE proof_exact_hashes (
  file_id TEXT PRIMARY KEY NOT NULL REFERENCES case_files(id),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  algorithm TEXT NOT NULL DEFAULT 'sha256' CHECK(algorithm='sha256'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version=1),
  verified_at TEXT NOT NULL,
  source_etag TEXT NOT NULL CHECK(length(source_etag)>0),
  source_size INTEGER NOT NULL CHECK(typeof(source_size)='integer' AND source_size BETWEEN 1 AND 5242880),
  case_created_at TEXT NOT NULL,
  case_internal_id TEXT NOT NULL REFERENCES cases(id)
);
-- Intentionally non-unique: identical files remain independent reviewable proofs.
CREATE INDEX idx_proof_exact_hash_lookup ON proof_exact_hashes(sha256,case_created_at DESC,case_internal_id DESC,file_id);
CREATE TRIGGER proof_exact_hash_source BEFORE INSERT ON proof_exact_hashes
WHEN NOT EXISTS(SELECT 1 FROM case_files f JOIN cases c ON c.id=f.case_id
  WHERE f.id=NEW.file_id AND f.etag=NEW.source_etag AND f.size=NEW.source_size
  AND c.id=NEW.case_internal_id AND c.created_at=NEW.case_created_at)
BEGIN SELECT RAISE(ABORT,'Proof hash source mismatch'); END;
CREATE TRIGGER proof_exact_hash_no_update BEFORE UPDATE ON proof_exact_hashes
BEGIN SELECT RAISE(ABORT,'Verified proof hashes are immutable'); END;
