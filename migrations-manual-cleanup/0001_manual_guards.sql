-- Additive, opt-in manual cleanup guards. No seeds, deletes or auto activation.
-- Existing cold_proofs, immutable storage_audit and their FK/Fence are reused.
CREATE TRIGGER manual_cleanup_cold_owner BEFORE UPDATE ON cold_proofs
WHEN CASE WHEN json_valid(OLD.verification_context) THEN json_extract(OLD.verification_context,'$.manual') ELSE 0 END=1
 AND OLD.state IN('verifying','deleting','cold')
 AND NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p WHERE p.id=1 AND p.purpose='normal'
 AND (NEW.lease_token=p.operation_id OR (OLD.lease_token=p.operation_id AND NEW.lease_token IS NULL)))
BEGIN SELECT RAISE(ABORT,'MANUAL_CLEANUP_OWNER_REQUIRED'); END;
CREATE TRIGGER manual_cleanup_backup_pin BEFORE UPDATE ON proof_backups
WHEN EXISTS(SELECT 1 FROM cold_proofs p WHERE p.file_id=OLD.file_id AND p.state IN('verifying','deleting','cold')
 AND CASE WHEN json_valid(p.verification_context) THEN json_extract(p.verification_context,'$.manual') ELSE 0 END=1)
BEGIN SELECT RAISE(ABORT,'MANUAL_CLEANUP_SOURCE_PINNED'); END;
CREATE TRIGGER manual_cleanup_file_pin BEFORE UPDATE ON case_files
WHEN EXISTS(SELECT 1 FROM cold_proofs p WHERE p.file_id=OLD.id AND p.state IN('verifying','deleting','cold')
 AND CASE WHEN json_valid(p.verification_context) THEN json_extract(p.verification_context,'$.manual') ELSE 0 END=1)
BEGIN SELECT RAISE(ABORT,'MANUAL_CLEANUP_SOURCE_PINNED'); END;
CREATE TRIGGER manual_cleanup_inventory_pin BEFORE UPDATE OF inventory_id ON storage_capacity
WHEN NEW.inventory_id IS NOT NULL AND OLD.inventory_id IS NULL AND EXISTS(SELECT 1 FROM cold_proofs p
 WHERE p.state IN('verifying','deleting') AND CASE WHEN json_valid(p.verification_context) THEN json_extract(p.verification_context,'$.manual') ELSE 0 END=1)
BEGIN SELECT RAISE(ABORT,'MANUAL_CLEANUP_IN_PROGRESS'); END;
CREATE TRIGGER manual_cleanup_export_claim_insert BEFORE INSERT ON export_file_claims
WHEN EXISTS(SELECT 1 FROM cold_proofs p WHERE p.file_id=NEW.file_id AND p.state IN('verifying','deleting','cold'))
BEGIN SELECT RAISE(ABORT,'EXPORT_ARCHIVED_PROOF'); END;
CREATE TRIGGER manual_cleanup_export_claim_update BEFORE UPDATE ON export_file_claims
WHEN EXISTS(SELECT 1 FROM cold_proofs p WHERE p.file_id=NEW.file_id AND p.state IN('verifying','deleting','cold'))
BEGIN SELECT RAISE(ABORT,'EXPORT_ARCHIVED_PROOF'); END;
CREATE TRIGGER manual_cleanup_dispatch_guard BEFORE INSERT ON storage_audit WHEN NEW.action='manual_cleanup_dispatch'
BEGIN
 SELECT CASE WHEN NEW.id<>'manual-cleanup:dispatch:'||NEW.target OR NOT EXISTS(
 SELECT 1 FROM cold_proofs c JOIN prelaunch_reset_permit p ON p.id=1 AND p.purpose='normal' AND p.operation_id=c.lease_token
 WHERE c.file_id=NEW.target AND c.state='deleting' AND json_extract(c.verification_context,'$.manual')=1)
 THEN RAISE(ABORT,'MANUAL_CLEANUP_DISPATCH_INVALID') END;
END;
CREATE TRIGGER manual_cleanup_terminal_guard BEFORE UPDATE OF state ON cold_proofs
WHEN NEW.state='cold' AND CASE WHEN json_valid(OLD.verification_context) THEN json_extract(OLD.verification_context,'$.manual') ELSE 0 END=1
 AND (OLD.state<>'deleting' OR NOT EXISTS(SELECT 1 FROM storage_audit a WHERE a.id='manual-cleanup:deleted:'||OLD.file_id AND a.action='manual_cleanup_deleted'))
BEGIN SELECT RAISE(ABORT,'MANUAL_CLEANUP_RECEIPT_REQUIRED'); END;
