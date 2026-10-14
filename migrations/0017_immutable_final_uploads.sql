-- Additive, local-first. Existing staging/completed rows retain V1 semantics.
CREATE TABLE proof_upload_intents (
  session_id TEXT PRIMARY KEY NOT NULL,
  proof_id TEXT UNIQUE NOT NULL,
  object_key TEXT UNIQUE NOT NULL,
  storage_version INTEGER NOT NULL DEFAULT 2 CHECK(storage_version=2),
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  member_id TEXT REFERENCES members(member_id),
  guest_capability_hash TEXT,
  content_type TEXT NOT NULL CHECK(content_type IN ('image/png','image/jpeg','image/webp')),
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 5242880),
  expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256)=64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grant_expires INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','uploaded','sealed','consumed','deleting','deleted')),
  write_token TEXT,
  uploaded_at TEXT,
  sealed_at TEXT,
  consumed_at TEXT,
  consumed_case_id TEXT UNIQUE REFERENCES cases(id),
  CHECK((member_id IS NOT NULL AND guest_capability_hash IS NULL) OR
    (member_id IS NULL AND guest_capability_hash IS NOT NULL AND length(guest_capability_hash)=64)),
  CHECK(state!='consumed' OR (consumed_case_id IS NOT NULL AND consumed_at IS NOT NULL)),
  CHECK(state NOT IN ('deleting','deleted') OR (write_token IS NULL AND consumed_case_id IS NULL))
);
CREATE INDEX idx_final_upload_cleanup ON proof_upload_intents(state,expires_at,session_id) WHERE consumed_case_id IS NULL AND write_token IS NULL;
CREATE TRIGGER final_intent_identity BEFORE UPDATE OF session_id,proof_id,object_key,storage_version,campaign_id,member_id,guest_capability_hash,content_type,size,expected_sha256,created_at,expires_at,grant_expires ON proof_upload_intents
BEGIN SELECT RAISE(ABORT,'Immutable upload identity'); END;
CREATE TRIGGER final_intent_no_replace BEFORE INSERT ON proof_upload_intents
WHEN EXISTS(SELECT 1 FROM proof_upload_intents WHERE session_id=NEW.session_id OR proof_id=NEW.proof_id OR object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'Immutable upload identity'); END;
CREATE TRIGGER final_intent_no_delete BEFORE DELETE ON proof_upload_intents
BEGIN SELECT RAISE(ABORT,'Upload tombstones must be retained'); END;
CREATE TRIGGER final_intent_state BEFORE UPDATE ON proof_upload_intents
WHEN (OLD.state!=NEW.state AND NOT (
  (OLD.state='prepared' AND NEW.state IN ('uploaded','sealed','deleting')) OR
  (OLD.state='uploaded' AND NEW.state IN ('sealed','deleting')) OR
  (OLD.state='sealed' AND NEW.state IN ('consumed','deleting')) OR
  (OLD.state='deleting' AND NEW.state='deleted')))
  OR (OLD.consumed_case_id IS NOT NULL AND NEW.consumed_case_id IS NOT OLD.consumed_case_id)
BEGIN SELECT RAISE(ABORT,'Invalid upload transition'); END;
-- Shared D1 serialization with cleanup: whichever commits first wins.
CREATE TRIGGER final_case_guard BEFORE INSERT ON cases
WHEN EXISTS(SELECT 1 FROM proof_upload_intents WHERE session_id=NEW.upload_session_id)
  AND NOT EXISTS(SELECT 1 FROM proof_upload_intents i WHERE i.session_id=NEW.upload_session_id
    AND i.state='sealed' AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND i.consumed_case_id IS NULL AND i.campaign_id=NEW.campaign_id AND i.member_id IS NEW.member_id)
BEGIN SELECT RAISE(ABORT,'Final proof is not consumable'); END;
CREATE TRIGGER final_case_consume AFTER INSERT ON cases
BEGIN UPDATE proof_upload_intents SET state='consumed',consumed_case_id=NEW.id,consumed_at=NEW.created_at
  WHERE session_id=NEW.upload_session_id AND state='sealed'; END;
CREATE TRIGGER final_case_file_guard BEFORE INSERT ON case_files
WHEN NEW.object_key LIKE 'proofs/final/%' AND NOT EXISTS(
  SELECT 1 FROM proof_upload_intents i JOIN cases c ON c.upload_session_id=i.session_id
  WHERE c.id=NEW.case_id AND i.consumed_case_id=c.id AND i.state='consumed'
    AND NEW.id=i.proof_id AND NEW.object_key=i.object_key AND NEW.upload_object_key=i.object_key
    AND NEW.size=i.size AND NEW.content_type=i.content_type)
BEGIN SELECT RAISE(ABORT,'Final proof linkage mismatch'); END;
