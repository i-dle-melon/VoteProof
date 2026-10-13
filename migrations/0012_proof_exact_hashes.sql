-- LOCAL candidate only. Do not apply to Production before separate release approval.
CREATE TABLE proof_exact_hashes (
  file_id TEXT PRIMARY KEY NOT NULL REFERENCES case_files(id),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  algorithm TEXT NOT NULL DEFAULT 'sha256' CHECK(algorithm='sha256'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version=1),
  verified_at TEXT NOT NULL,
  source_etag TEXT NOT NULL CHECK(length(source_etag)>0),
  source_size INTEGER NOT NULL CHECK(typeof(source_size)='integer' AND source_size BETWEEN 1 AND 5242880)
);
-- Intentionally non-unique: identical files remain independent reviewable proofs.
CREATE INDEX idx_proof_exact_hash_lookup ON proof_exact_hashes(sha256,file_id);
CREATE TRIGGER proof_exact_hash_source BEFORE INSERT ON proof_exact_hashes
WHEN NOT EXISTS(SELECT 1 FROM case_files f WHERE f.id=NEW.file_id AND f.etag=NEW.source_etag AND f.size=NEW.source_size)
BEGIN SELECT RAISE(ABORT,'Proof hash source mismatch'); END;
CREATE TRIGGER proof_exact_hash_no_update BEFORE UPDATE ON proof_exact_hashes
BEGIN SELECT RAISE(ABORT,'Verified proof hashes are immutable'); END;
