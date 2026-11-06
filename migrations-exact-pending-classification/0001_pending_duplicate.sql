-- Independent policy upgrade; install in ONE atomic batch after exact v1, before new Worker.
-- Preserve immutable history and old Worker pending_match compatibility. No backfill/index/toggle.
DROP TRIGGER case_sha_decision_insert;
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
 AND ((NEW.decision='exact_duplicate' AND v.status IN('approved','completed','pending')) OR (NEW.decision='pending_match' AND v.status='pending')))
 THEN RAISE(ABORT,'EXACT_DECISION_SOURCE_CHANGED') END;
END;
