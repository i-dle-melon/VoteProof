-- LOCAL POC ONLY. Do not apply remotely. Legacy IDs/data/readers remain intact.

-- Controlled parent-table rebuild; no legacy upload/evidence tables are dropped.

PRAGMA defer_foreign_keys = ON;

DROP TRIGGER cases_campaign_type_insert;

DROP TRIGGER cases_duplicate_insert;

DROP TRIGGER cases_duplicate_update;

DROP TRIGGER cases_fixed_identity_type;

DROP TRIGGER cases_guest_points_insert;

DROP TRIGGER cases_guest_points_update;

DROP TRIGGER cases_review_stage_policy;

DROP TRIGGER duplicate_enqueue;

DROP TRIGGER duplicate_source_insert;

DROP TRIGGER final_case_consume;

DROP TRIGGER final_case_file_guard;

DROP TRIGGER final_case_guard;

DROP TRIGGER points_case_binding;

DROP TRIGGER proof_exact_hash_source;

DROP TRIGGER submissions_cases_insert;

CREATE TABLE cases_next (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  member_id TEXT,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 50),
  player_id TEXT NOT NULL CHECK (length(player_id) BETWEEN 1 AND 100),
  campaign_id TEXT NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 100),
  vote_type TEXT NOT NULL CHECK (vote_type IN ('Solo', '團體')),
  vote_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'completed', 'rejected', 'duplicate', 'revoked')),
  query_key_hash TEXT NOT NULL CHECK (length(query_key_hash) = 64),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  source TEXT NOT NULL DEFAULT 'guest',
  duplicate_flag INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_flag IN (0, 1)),
  reviewed_at TEXT,
  reviewer_id TEXT,
  points_awarded INTEGER NOT NULL DEFAULT 0 CHECK (points_awarded >= 0),
  point_status TEXT,
  upload_session_id TEXT UNIQUE REFERENCES completed_uploads(session_id),
  status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  status_updated_at TEXT,
  status_updated_by TEXT REFERENCES members(member_id),
  duplicate_of_case_id TEXT REFERENCES cases(id),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_review_id TEXT,
  point_transaction_id TEXT REFERENCES point_transactions(transaction_id),
  review_stage TEXT NOT NULL DEFAULT 'initial' CHECK(review_stage IN ('initial','detailed')),
  review_risk_reason TEXT CHECK(review_risk_reason IS NULL OR
    (length(review_risk_reason) BETWEEN 1 AND 64 AND review_risk_reason NOT GLOB '*[^a-z_]*')),
  upload_intent_id TEXT UNIQUE REFERENCES proof_upload_intents(session_id),
  CHECK((upload_session_id IS NOT NULL) != (upload_intent_id IS NOT NULL)),
  FOREIGN KEY(upload_intent_id) REFERENCES case_files_next(upload_intent_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE case_files_next (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES cases(id),
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 5242880),
  etag TEXT,
  created_at TEXT NOT NULL,
  upload_object_key TEXT UNIQUE REFERENCES completed_upload_files(object_key),
  upload_intent_id TEXT UNIQUE REFERENCES proof_upload_intents(session_id),
  CHECK((upload_object_key IS NOT NULL) != (upload_intent_id IS NOT NULL))
);

INSERT INTO cases_next SELECT *,NULL FROM cases;

INSERT INTO case_files_next SELECT *,NULL FROM case_files;

DROP TABLE case_files;

DROP TABLE cases;

ALTER TABLE cases_next RENAME TO cases;

ALTER TABLE case_files_next RENAME TO case_files;

CREATE INDEX idx_case_files_case_id ON case_files(case_id);

CREATE INDEX idx_cases_admin_queue ON cases((CASE WHEN status = 'pending' THEN 0 ELSE 1 END), created_at DESC, id DESC);

CREATE INDEX idx_cases_campaign_id ON cases(campaign_id);

CREATE INDEX idx_cases_created_at ON cases(created_at);

CREATE INDEX idx_cases_duplicate_target ON cases(duplicate_of_case_id) WHERE duplicate_of_case_id IS NOT NULL;

CREATE INDEX idx_cases_guest_lookup ON cases(case_id, query_key_hash);

CREATE UNIQUE INDEX idx_cases_last_review ON cases(last_review_id) WHERE last_review_id IS NOT NULL;

CREATE INDEX idx_cases_member_cursor ON cases(member_id,created_at DESC,id DESC);

CREATE INDEX idx_cases_review_queue ON cases(review_stage,status,created_at DESC,id DESC);

CREATE INDEX idx_cases_status ON cases(status);

CREATE TRIGGER cases_campaign_type_insert BEFORE INSERT ON cases
WHEN NOT EXISTS(SELECT 1 FROM campaigns p WHERE p.campaign_id=NEW.campaign_id AND p.category=NEW.vote_type
 AND (p.category='團體' OR (p.category='Solo' AND p.solo_target IS NOT NULL)))
BEGIN SELECT RAISE(ABORT, 'CAMPAIGN_TYPE_MISMATCH'); END;

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

CREATE TRIGGER cases_fixed_identity_type BEFORE UPDATE OF campaign_id,vote_type,member_id,source ON cases
WHEN NEW.campaign_id!=OLD.campaign_id OR NEW.vote_type!=OLD.vote_type OR NEW.member_id IS NOT OLD.member_id OR NEW.source!=OLD.source
BEGIN SELECT RAISE(ABORT, 'Case identity and campaign type are immutable'); END;

CREATE TRIGGER cases_guest_points_insert BEFORE INSERT ON cases
WHEN NEW.member_id IS NULL AND NEW.points_awarded != 0
BEGIN SELECT RAISE(ABORT, 'Guests cannot earn member points'); END;

CREATE TRIGGER cases_guest_points_update BEFORE UPDATE ON cases
WHEN NEW.member_id IS NULL AND NEW.points_awarded != 0
BEGIN SELECT RAISE(ABORT, 'Guests cannot earn member points'); END;

CREATE TRIGGER cases_review_stage_policy BEFORE UPDATE OF review_stage,review_risk_reason ON cases
WHEN (NEW.review_stage IS NOT OLD.review_stage OR NEW.review_risk_reason IS NOT OLD.review_risk_reason) AND (OLD.status!='pending' OR NEW.status!='pending' OR NEW.review_stage!='detailed' OR NEW.review_risk_reason IS NULL OR NEW.version!=OLD.version+1)
BEGIN SELECT RAISE(ABORT,'Invalid detailed review transition'); END;

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

CREATE TRIGGER duplicate_source_insert BEFORE INSERT ON proof_duplicate_jobs
WHEN NOT EXISTS(SELECT 1 FROM proof_exact_hashes h JOIN case_files f ON f.id=h.file_id JOIN cases c ON c.id=f.case_id
  WHERE h.file_id=NEW.file_id AND h.sha256=NEW.sha256 AND h.source_etag=f.etag AND h.source_size=f.size
  AND c.id=NEW.case_internal_id AND c.created_at=NEW.case_created_at AND c.member_id IS NEW.member_id AND c.campaign_id=NEW.campaign_id)
BEGIN SELECT RAISE(ABORT,'Duplicate source mismatch'); END;

CREATE TRIGGER points_case_binding BEFORE INSERT ON point_transactions
WHEN NEW.case_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.id = NEW.case_id
  AND c.member_id = NEW.member_id AND c.campaign_id = NEW.campaign_id AND c.vote_type = NEW.vote_type AND c.vote_date = NEW.vote_date
  AND ((NEW.category IN ('proof_approved', 'proof_reapproved') AND c.status = 'approved') OR (NEW.category = 'proof_revoked' AND c.status = 'revoked')))
BEGIN SELECT RAISE(ABORT, 'Point transaction does not match case'); END;

CREATE TRIGGER proof_exact_hash_source BEFORE INSERT ON proof_exact_hashes
WHEN NOT EXISTS(SELECT 1 FROM case_files f JOIN cases c ON c.id=f.case_id
  WHERE f.id=NEW.file_id AND f.etag=NEW.source_etag AND f.size=NEW.source_size
  AND c.id=NEW.case_internal_id AND c.created_at=NEW.case_created_at)
BEGIN SELECT RAISE(ABORT,'Proof hash source mismatch'); END;

CREATE TRIGGER submissions_cases_insert BEFORE INSERT ON cases
WHEN NOT EXISTS(SELECT 1 FROM submission_settings WHERE id=1 AND submissions_enabled=1)
BEGIN SELECT RAISE(ABORT,'Submissions disabled'); END;


-- Source-only experimental issuance marker, not a new upload version/receipt.
ALTER TABLE proof_upload_intents ADD COLUMN completion_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(completion_mode IN ('legacy','direct'));
CREATE TRIGGER final_intent_mode_identity BEFORE UPDATE OF completion_mode ON proof_upload_intents
BEGIN SELECT RAISE(ABORT,'Immutable upload completion mode'); END;
DROP TRIGGER final_intent_state;
CREATE TRIGGER final_intent_state BEFORE UPDATE ON proof_upload_intents
WHEN (OLD.state!=NEW.state AND NOT (
 (OLD.state='prepared' AND NEW.state IN ('uploaded','sealed','deleting')) OR
 (OLD.state='uploaded' AND NEW.state IN ('sealed','deleting')) OR
 (OLD.state='sealed' AND NEW.state IN ('consumed','deleting')) OR
 (OLD.completion_mode='direct' AND OLD.state='prepared' AND NEW.state='consumed') OR
 (OLD.state='deleting' AND NEW.state='deleted')))
 OR (OLD.consumed_case_id IS NOT NULL AND NEW.consumed_case_id IS NOT OLD.consumed_case_id)
 OR (NEW.completion_mode='direct' AND NEW.state IN ('uploaded','sealed'))
BEGIN SELECT RAISE(ABORT,'Invalid upload transition'); END;
CREATE TRIGGER final_intent_direct_insert BEFORE INSERT ON proof_upload_intents
WHEN NEW.completion_mode='direct' AND NEW.state!='prepared'
BEGIN SELECT RAISE(ABORT,'Direct intent must start prepared'); END;
CREATE TRIGGER final_case_guard BEFORE INSERT ON cases
WHEN (NEW.upload_intent_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM proof_upload_intents i WHERE i.session_id=NEW.upload_intent_id AND i.completion_mode='direct'
 AND i.state='prepared' AND i.consumed_case_id IS NULL AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND i.campaign_id=NEW.campaign_id AND i.member_id IS NEW.member_id))
 OR (EXISTS(SELECT 1 FROM proof_upload_intents WHERE session_id=NEW.upload_session_id) AND NOT EXISTS(
 SELECT 1 FROM proof_upload_intents i WHERE i.session_id=NEW.upload_session_id AND i.completion_mode='legacy'
 AND i.state='sealed' AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND i.consumed_case_id IS NULL
 AND i.campaign_id=NEW.campaign_id AND i.member_id IS NEW.member_id))
BEGIN SELECT RAISE(ABORT,'Final proof is not consumable'); END;
CREATE TRIGGER final_case_consume AFTER INSERT ON cases
BEGIN
 UPDATE proof_upload_intents SET state='consumed',consumed_case_id=NEW.id,consumed_at=NEW.created_at
 WHERE (session_id=NEW.upload_session_id AND completion_mode='legacy' AND state='sealed')
 OR (session_id=NEW.upload_intent_id AND completion_mode='direct' AND state='prepared');
 SELECT CASE WHEN NEW.upload_intent_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM proof_upload_intents WHERE session_id=NEW.upload_intent_id AND state='consumed' AND consumed_case_id=NEW.id)
 THEN RAISE(ABORT,'Direct intent consumption failed') END;
END;
CREATE TRIGGER final_case_file_guard BEFORE INSERT ON case_files
WHEN (NEW.object_key LIKE 'proofs/final/%' OR NEW.upload_intent_id IS NOT NULL) AND NOT EXISTS(
 SELECT 1 FROM proof_upload_intents i JOIN cases c ON coalesce(c.upload_intent_id,c.upload_session_id)=i.session_id
 WHERE c.id=NEW.case_id AND i.consumed_case_id=c.id AND i.state='consumed'
 AND NEW.id=i.proof_id AND NEW.object_key=i.object_key AND NEW.size=i.size AND NEW.content_type=i.content_type
 AND NEW.etag IS NOT NULL AND length(NEW.etag)>0
 AND ((i.completion_mode='legacy' AND NEW.upload_object_key=i.object_key AND NEW.upload_intent_id IS NULL)
 OR (i.completion_mode='direct' AND NEW.upload_intent_id=i.session_id AND NEW.upload_object_key IS NULL)))
BEGIN SELECT RAISE(ABORT,'Final proof linkage mismatch'); END;
CREATE TRIGGER cases_upload_binding BEFORE UPDATE OF upload_session_id,upload_intent_id ON cases
WHEN NEW.upload_session_id IS NOT OLD.upload_session_id OR NEW.upload_intent_id IS NOT OLD.upload_intent_id
BEGIN SELECT RAISE(ABORT,'Case upload binding is immutable'); END;
CREATE TRIGGER direct_file_binding BEFORE UPDATE ON case_files
WHEN OLD.upload_intent_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'Direct proof metadata is immutable'); END;


-- Validate the full restored FK graph before clearing deferred DROP bookkeeping.

CREATE TABLE direct_intent_migration_guard(valid INTEGER NOT NULL CHECK(valid=1));

INSERT INTO direct_intent_migration_guard SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;

DROP TABLE direct_intent_migration_guard;

PRAGMA defer_foreign_keys = OFF;
