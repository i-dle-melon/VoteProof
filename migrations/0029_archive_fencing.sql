-- Additive, default PAUSED. Never clears an existing deleting pin or audit.
CREATE TABLE storage_archive_control (
 id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>0),
 mode TEXT NOT NULL DEFAULT 'paused' CHECK(mode IN('paused','running','draining')),
 writer_policy TEXT, evidence_hash TEXT, verified_until INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO storage_archive_control(id) VALUES(1);
ALTER TABLE cold_proofs ADD COLUMN archive_epoch INTEGER;
CREATE TABLE storage_archive_dispatches (
 token TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES case_files(id), epoch INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN('reserved','ambiguous','completed')),
 created_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE UNIQUE INDEX archive_dispatch_pending_file ON storage_archive_dispatches(file_id) WHERE state!='completed';
CREATE INDEX archive_dispatch_pending ON storage_archive_dispatches(state,file_id) WHERE state!='completed';
CREATE TRIGGER archive_dispatch_identity BEFORE UPDATE ON storage_archive_dispatches
WHEN NEW.token IS NOT OLD.token OR NEW.file_id IS NOT OLD.file_id OR NEW.epoch IS NOT OLD.epoch OR NEW.created_at IS NOT OLD.created_at
 OR OLD.state='completed' OR (OLD.state='ambiguous' AND NEW.state='reserved')
BEGIN SELECT RAISE(ABORT,'ARCHIVE_DISPATCH_IMMUTABLE'); END;
CREATE TRIGGER archive_dispatch_no_delete BEFORE DELETE ON storage_archive_dispatches
BEGIN SELECT RAISE(ABORT,'ARCHIVE_DISPATCH_IMMUTABLE'); END;
CREATE TRIGGER archive_dispatch_no_replace BEFORE INSERT ON storage_archive_dispatches
WHEN EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE token=NEW.token)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_DISPATCH_IMMUTABLE'); END;
-- Expired reservations are STILL unresolved. Do not reclaim by elapsed time.
CREATE TRIGGER archive_dispatch_admission BEFORE INSERT ON storage_archive_dispatches
WHEN NEW.state!='reserved' OR NOT EXISTS(SELECT 1 FROM storage_archive_control WHERE id=1 AND mode='running'
 AND epoch=NEW.epoch AND writer_policy='create_only_v1' AND length(evidence_hash)=64
 AND verified_until>CAST(strftime('%s','now') AS INTEGER))
 OR NOT EXISTS(SELECT 1 FROM cold_proofs WHERE file_id=NEW.file_id AND state='deleting' AND lease_token=NEW.token AND archive_epoch=NEW.epoch)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_FENCED'); END;
CREATE TRIGGER archive_control_identity BEFORE UPDATE ON storage_archive_control
WHEN NEW.id!=OLD.id OR NEW.epoch<OLD.epoch
 OR (NEW.mode!=OLD.mode AND NEW.epoch<=OLD.epoch)
 OR (NEW.mode='running' AND (NEW.writer_policy IS NOT 'create_only_v1' OR NEW.evidence_hash IS NULL OR length(NEW.evidence_hash)!=64
 OR NEW.verified_until<=CAST(strftime('%s','now') AS INTEGER)
 OR EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed')
 OR EXISTS(SELECT 1 FROM cold_proofs WHERE state='deleting')))
 OR (NEW.mode='paused' AND (EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed')
 OR EXISTS(SELECT 1 FROM cold_proofs WHERE state='deleting')))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CONTROL_CONFLICT'); END;
CREATE TRIGGER archive_control_no_delete BEFORE DELETE ON storage_archive_control
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CONTROL_IMMUTABLE'); END;
CREATE TRIGGER archive_control_no_replace BEFORE INSERT ON storage_archive_control
WHEN EXISTS(SELECT 1 FROM storage_archive_control WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CONTROL_IMMUTABLE'); END;
