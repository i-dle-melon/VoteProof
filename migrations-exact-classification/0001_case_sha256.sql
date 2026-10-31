-- Independent extension for 0028 + Reset Fence. Installation does not enable it.
CREATE TABLE case_sha256_control (
 id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)), version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO case_sha256_control(id,schema_version) VALUES(1,1);
CREATE INDEX idx_case_sha_consumed ON proof_upload_intents(member_id,campaign_id,expected_sha256,consumed_case_id)
 WHERE state='consumed' AND member_id IS NOT NULL AND consumed_case_id IS NOT NULL;
-- Direct history already has immutable, checksum-verified intent/file bindings.
-- Probe only older, potentially unverified history; do not scan all member cases.
CREATE INDEX idx_case_sha_legacy_scope ON cases(member_id,campaign_id)
 WHERE upload_intent_id IS NULL AND member_id IS NOT NULL;
CREATE VIEW case_verified_sha256_sources AS
 SELECT c.id AS case_internal_id,c.case_id,c.member_id,c.campaign_id,i.expected_sha256 AS sha256,c.status,c.version,c.created_at
 FROM proof_upload_intents i JOIN cases c ON c.id=i.consumed_case_id
 JOIN case_files f ON f.upload_intent_id=i.session_id AND f.id=i.proof_id AND f.object_key=i.object_key AND f.size=i.size
 WHERE i.state='consumed' AND i.member_id IS NOT NULL AND i.consumed_case_id IS NOT NULL
 AND c.member_id=i.member_id AND c.campaign_id=i.campaign_id AND f.etag IS NOT NULL
 UNION ALL
 SELECT c.id,c.case_id,j.member_id,j.campaign_id,h.sha256,c.status,c.version,c.created_at
 FROM proof_duplicate_jobs j JOIN proof_exact_hashes h ON h.file_id=j.file_id AND h.sha256=j.sha256
 JOIN case_files f ON f.id=h.file_id AND f.etag=h.source_etag AND f.size=h.source_size
 JOIN cases c ON c.id=f.case_id AND c.id=h.case_internal_id AND c.created_at=h.case_created_at
 WHERE j.member_id IS NOT NULL AND c.member_id=j.member_id AND c.campaign_id=j.campaign_id;
CREATE TABLE case_sha256_decisions (
 case_internal_id TEXT PRIMARY KEY REFERENCES cases(id) DEFERRABLE INITIALLY DEFERRED,
 intent_id TEXT NOT NULL REFERENCES proof_upload_intents(session_id),
 decision TEXT NOT NULL CHECK(decision IN('clear','pending_match','exact_duplicate','unknown')),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 reference_case_id TEXT REFERENCES cases(id), reference_version INTEGER,
 created_at TEXT NOT NULL,
 CHECK((decision IN('pending_match','exact_duplicate') AND reference_case_id IS NOT NULL AND reference_version IS NOT NULL)
 OR (decision IN('clear','unknown') AND reference_case_id IS NULL AND reference_version IS NULL))
) WITHOUT ROWID;
CREATE TRIGGER case_sha_decision_no_update BEFORE UPDATE ON case_sha256_decisions BEGIN SELECT RAISE(ABORT,'EXACT_DECISION_IMMUTABLE'); END;
CREATE TRIGGER case_sha_decision_no_delete BEFORE DELETE ON case_sha256_decisions BEGIN SELECT RAISE(ABORT,'EXACT_DECISION_IMMUTABLE'); END;
CREATE TRIGGER case_sha_decision_insert BEFORE INSERT ON case_sha256_decisions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM case_sha256_decisions WHERE case_internal_id=NEW.case_internal_id)
 THEN RAISE(ABORT,'EXACT_DECISION_IMMUTABLE') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_internal_id)
 THEN RAISE(ABORT,'EXACT_DECISION_SOURCE_INVALID') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND p.epoch=c.epoch
 JOIN prelaunch_reset_operations o ON o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'
 WHERE p.id=1 AND p.purpose='normal' AND c.mode='open') THEN RAISE(ABORT,'PRELAUNCH_WRITE_FENCED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM proof_upload_intents i WHERE i.session_id=NEW.intent_id
 AND i.member_id IS NOT NULL AND i.state='prepared' AND i.completion_mode='direct' AND i.consumed_case_id IS NULL
 AND i.expected_sha256=NEW.sha256) THEN RAISE(ABORT,'EXACT_DECISION_SOURCE_INVALID') END;
 SELECT CASE WHEN NEW.reference_case_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM proof_upload_intents i JOIN case_verified_sha256_sources v ON v.member_id=i.member_id
 AND v.campaign_id=i.campaign_id AND v.sha256=NEW.sha256
 WHERE i.session_id=NEW.intent_id AND v.case_internal_id=NEW.reference_case_id AND v.version=NEW.reference_version
 AND ((NEW.decision='exact_duplicate' AND v.status IN('approved','completed')) OR (NEW.decision='pending_match' AND v.status='pending')))
 THEN RAISE(ABORT,'EXACT_DECISION_SOURCE_CHANGED') END;
END;
CREATE TRIGGER case_sha_control_update BEFORE UPDATE ON case_sha256_control BEGIN
 SELECT CASE WHEN NEW.schema_version<>OLD.schema_version OR NEW.id<>OLD.id OR NEW.version<>OLD.version+1
 THEN RAISE(ABORT,'EXACT_POLICY_CAS_REQUIRED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND p.epoch=c.epoch
 JOIN prelaunch_reset_operations o ON o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'
 WHERE p.id=1 AND p.purpose='normal' AND c.mode='open') THEN RAISE(ABORT,'PRELAUNCH_WRITE_FENCED') END;
END;
CREATE TRIGGER case_sha_control_no_delete BEFORE DELETE ON case_sha256_control BEGIN SELECT RAISE(ABORT,'EXACT_POLICY_IMMUTABLE'); END;
CREATE TRIGGER case_sha_control_no_replace BEFORE INSERT ON case_sha256_control WHEN EXISTS(SELECT 1 FROM case_sha256_control WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'EXACT_POLICY_IMMUTABLE'); END;
-- Old writers cannot create unclassified Direct member cases while enabled.
CREATE TRIGGER case_sha_required BEFORE INSERT ON cases
 WHEN NEW.member_id IS NOT NULL AND NEW.upload_intent_id IS NOT NULL AND (SELECT enabled FROM case_sha256_control WHERE id=1)=1
 AND NOT EXISTS(SELECT 1 FROM case_sha256_decisions d WHERE d.case_internal_id=NEW.id AND d.intent_id=NEW.upload_intent_id
 AND d.created_at=NEW.created_at
 AND ((d.decision='exact_duplicate' AND NEW.status='duplicate' AND NEW.duplicate_flag=1 AND NEW.duplicate_of_case_id=d.reference_case_id)
 OR (d.decision<>'exact_duplicate' AND NEW.status='pending' AND NEW.duplicate_flag=0 AND NEW.duplicate_of_case_id IS NULL)))
 BEGIN SELECT RAISE(ABORT,'EXACT_CLASSIFICATION_REQUIRED'); END;
CREATE TRIGGER case_sha_file_binding AFTER INSERT ON case_files
 WHEN EXISTS(SELECT 1 FROM case_sha256_decisions d WHERE d.case_internal_id=NEW.case_id)
 AND NOT EXISTS(SELECT 1 FROM case_sha256_decisions d JOIN proof_upload_intents i ON i.session_id=d.intent_id
 WHERE d.case_internal_id=NEW.case_id AND i.consumed_case_id=NEW.case_id AND i.state='consumed'
 AND d.sha256=i.expected_sha256 AND NEW.upload_intent_id=i.session_id AND NEW.id=i.proof_id
 AND NEW.object_key=i.object_key AND NEW.size=i.size AND NEW.etag IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'EXACT_DECISION_SOURCE_INVALID'); END;
-- Serialize approvals, including legacy Runtime reviewers, under the same D1 transaction.
CREATE TRIGGER case_sha_approval_guard BEFORE UPDATE OF status ON cases
 WHEN NEW.status='approved' AND OLD.status='pending' AND NEW.member_id IS NOT NULL
 AND (SELECT enabled FROM case_sha256_control WHERE id=1)=1
 AND EXISTS(SELECT 1 FROM case_verified_sha256_sources own JOIN case_verified_sha256_sources other
 ON other.member_id=own.member_id AND other.campaign_id=own.campaign_id AND other.sha256=own.sha256
 WHERE own.case_internal_id=NEW.id AND other.case_internal_id<>NEW.id AND other.status IN('approved','completed'))
 BEGIN SELECT RAISE(ABORT,'EXACT_DUPLICATE_APPROVAL_BLOCKED'); END;
