-- Local candidate only. 0012 remains unchanged; Wrangler's migration registry
-- applies this once. No hash backfill or R2 access is performed by this migration.
CREATE TABLE proof_duplicate_jobs (
  file_id TEXT PRIMARY KEY NOT NULL REFERENCES proof_exact_hashes(file_id) ON DELETE CASCADE,
  member_id TEXT REFERENCES members(member_id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  case_internal_id TEXT NOT NULL REFERENCES cases(id),
  case_created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('pending','processing','clear','exact_duplicate','failed','not_applicable')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  next_attempt_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  claimed_at INTEGER,
  analyzed_canonical_file_id TEXT,
  canonical_file_id TEXT REFERENCES proof_duplicate_jobs(file_id),
  canonical_case_id TEXT REFERENCES cases(id),
  last_error TEXT CHECK(last_error IS NULL OR last_error IN('PROCESSOR_UNAVAILABLE','SOURCE_CHANGED','ATTEMPTS_EXHAUSTED')),
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK((state='processing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR state!='processing'),
  CHECK((state='exact_duplicate' AND canonical_file_id IS NOT NULL AND canonical_case_id IS NOT NULL AND canonical_file_id!=file_id)
    OR (state!='exact_duplicate' AND canonical_file_id IS NULL AND canonical_case_id IS NULL)),
  CHECK(member_id IS NOT NULL OR state='not_applicable')
);
CREATE INDEX idx_duplicate_scope ON proof_duplicate_jobs(member_id,campaign_id,sha256,case_created_at,case_internal_id,file_id);
CREATE INDEX idx_duplicate_ready ON proof_duplicate_jobs(state,next_attempt_at,file_id);
CREATE INDEX idx_duplicate_lease ON proof_duplicate_jobs(state,lease_until,file_id);
CREATE TABLE proof_duplicate_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  file_id TEXT NOT NULL REFERENCES proof_duplicate_jobs(file_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_duplicate_request_file ON proof_duplicate_requests(file_id);
CREATE TABLE proof_duplicate_groups (
  member_id TEXT NOT NULL REFERENCES members(member_id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  sha256 TEXT NOT NULL,
  canonical_file_id TEXT NOT NULL REFERENCES proof_duplicate_jobs(file_id) ON DELETE CASCADE,
  case_created_at TEXT NOT NULL,
  case_internal_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 0 CHECK(dirty IN(0,1)),
  after_file_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(member_id,campaign_id,sha256)
);
CREATE INDEX idx_duplicate_reconcile ON proof_duplicate_groups(dirty,member_id,campaign_id,sha256);
CREATE INDEX idx_duplicate_scope_file ON proof_duplicate_jobs(member_id,campaign_id,sha256,file_id);
CREATE TRIGGER duplicate_source_insert BEFORE INSERT ON proof_duplicate_jobs
WHEN NOT EXISTS(SELECT 1 FROM proof_exact_hashes h JOIN case_files f ON f.id=h.file_id JOIN cases c ON c.id=f.case_id
  WHERE h.file_id=NEW.file_id AND h.sha256=NEW.sha256 AND h.source_etag=f.etag AND h.source_size=f.size
  AND c.id=NEW.case_internal_id AND c.created_at=NEW.case_created_at AND c.member_id IS NEW.member_id AND c.campaign_id=NEW.campaign_id)
BEGIN SELECT RAISE(ABORT,'Duplicate source mismatch'); END;
CREATE TRIGGER duplicate_source_immutable BEFORE UPDATE OF file_id,member_id,campaign_id,sha256,case_internal_id,case_created_at ON proof_duplicate_jobs
BEGIN SELECT RAISE(ABORT,'Duplicate source is immutable'); END;
CREATE TRIGGER duplicate_canonical_scope BEFORE UPDATE OF canonical_file_id,canonical_case_id,state ON proof_duplicate_jobs
WHEN NEW.state='exact_duplicate' AND NOT EXISTS(SELECT 1 FROM proof_duplicate_jobs p
  WHERE p.file_id=NEW.canonical_file_id AND p.case_internal_id=NEW.canonical_case_id
  AND p.member_id=NEW.member_id AND p.campaign_id=NEW.campaign_id AND p.sha256=NEW.sha256
  AND (p.case_created_at,p.case_internal_id,p.file_id)<(NEW.case_created_at,NEW.case_internal_id,NEW.file_id))
BEGIN SELECT RAISE(ABORT,'Duplicate canonical scope mismatch'); END;
CREATE TRIGGER duplicate_enqueue AFTER INSERT ON proof_exact_hashes
BEGIN
  INSERT INTO proof_duplicate_jobs(file_id,member_id,campaign_id,sha256,case_internal_id,case_created_at,state,next_attempt_at,updated_at)
    SELECT NEW.file_id,c.member_id,c.campaign_id,NEW.sha256,c.id,c.created_at,
      CASE WHEN c.member_id IS NULL THEN 'not_applicable' ELSE 'pending' END,
      CASE WHEN c.member_id IS NULL THEN NULL ELSE 0 END,NEW.verified_at
    FROM case_files f JOIN cases c ON c.id=f.case_id WHERE f.id=NEW.file_id;
  -- Only one scoped group changes synchronously. Existing stale results are
  -- logically pending immediately; bounded background reconciliation resets them.
  -- A scoped minimum metadata register is updated by one PK UPSERT. There is
  -- no SELECT of matching/prior proofs and no classification on this path.
  INSERT INTO proof_duplicate_groups(member_id,campaign_id,sha256,canonical_file_id,case_created_at,case_internal_id,dirty,after_file_id)
    SELECT member_id,campaign_id,sha256,file_id,case_created_at,case_internal_id,0,''
    FROM proof_duplicate_jobs WHERE file_id=NEW.file_id AND member_id IS NOT NULL
    ON CONFLICT(member_id,campaign_id,sha256) DO UPDATE SET canonical_file_id=excluded.canonical_file_id,
      case_created_at=excluded.case_created_at,case_internal_id=excluded.case_internal_id,
      dirty=1,after_file_id='',generation=generation+1
      WHERE (excluded.case_created_at,excluded.case_internal_id,excluded.canonical_file_id)
        <(proof_duplicate_groups.case_created_at,proof_duplicate_groups.case_internal_id,proof_duplicate_groups.canonical_file_id);
END;
-- Convert only already verified 0012 metadata to pending; never calculate hashes
-- or classify historical proofs. New uploads are enqueued by the trigger above.
INSERT INTO proof_duplicate_jobs(file_id,member_id,campaign_id,sha256,case_internal_id,case_created_at,state,next_attempt_at,updated_at)
  SELECT h.file_id,c.member_id,c.campaign_id,h.sha256,c.id,c.created_at,
    CASE WHEN c.member_id IS NULL THEN 'not_applicable' ELSE 'pending' END,
    CASE WHEN c.member_id IS NULL THEN NULL ELSE 0 END,h.verified_at
  FROM proof_exact_hashes h JOIN case_files f ON f.id=h.file_id JOIN cases c ON c.id=f.case_id;
INSERT INTO proof_duplicate_groups(member_id,campaign_id,sha256,canonical_file_id,case_created_at,case_internal_id)
  SELECT member_id,campaign_id,sha256,file_id,case_created_at,case_internal_id FROM (
    SELECT j.*,ROW_NUMBER() OVER(PARTITION BY member_id,campaign_id,sha256 ORDER BY case_created_at,case_internal_id,file_id) ordinal
    FROM proof_duplicate_jobs j WHERE member_id IS NOT NULL
  ) WHERE ordinal=1;
-- Retire the obsolete global business lookup. Hash storage/backfill uses file_id.
DROP INDEX idx_proof_exact_hash_lookup;
