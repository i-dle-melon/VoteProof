-- Additive; unknown capacity blocks writes. No retention approval or activation.
CREATE TABLE storage_capacity (
 id INTEGER PRIMARY KEY CHECK(id=1), used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
 reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0), trusted_until INTEGER NOT NULL DEFAULT 0,
 blocked INTEGER NOT NULL DEFAULT 1 CHECK(blocked IN(0,1)), episode INTEGER NOT NULL DEFAULT 1,
 inventory_id TEXT, inventory_cursor TEXT, inventory_bytes INTEGER NOT NULL DEFAULT 0,
 inventory_count INTEGER NOT NULL DEFAULT 0, inventory_staging INTEGER NOT NULL DEFAULT 0,
 inventory_other INTEGER NOT NULL DEFAULT 0, inventory_version INTEGER NOT NULL DEFAULT 0,
 anomaly TEXT, observed_at INTEGER, cleanup_requested INTEGER NOT NULL DEFAULT 0
);
INSERT INTO storage_capacity(id) VALUES(1);
CREATE TABLE storage_reservations (
 id TEXT PRIMARY KEY, object_key TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>0),
 state TEXT NOT NULL CHECK(state IN('reserved','committed','cancelled')), created_at INTEGER NOT NULL, etag TEXT, object_version TEXT
);
CREATE INDEX storage_object_writers ON storage_reservations(object_key,state);
CREATE TRIGGER storage_reserve_guard BEFORE INSERT ON storage_reservations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND blocked=0 AND anomaly IS NULL
 AND inventory_id IS NULL AND trusted_until>CAST(strftime('%s','now') AS INTEGER)
 AND used_bytes+reserved_bytes+NEW.bytes<9500000000) THEN RAISE(ABORT,'R2_STORAGE_CAPACITY_EXCEEDED') END;
END;
CREATE TRIGGER storage_reserve_count AFTER INSERT ON storage_reservations BEGIN
 UPDATE storage_capacity SET reserved_bytes=reserved_bytes+NEW.bytes WHERE id=1;
END;
CREATE TRIGGER storage_commit_count AFTER UPDATE OF state ON storage_reservations WHEN OLD.state='reserved' AND NEW.state='committed' BEGIN
 UPDATE storage_capacity SET used_bytes=used_bytes+NEW.bytes,reserved_bytes=reserved_bytes-NEW.bytes WHERE id=1;
END;
CREATE TABLE storage_history (
 id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL,
 object_count INTEGER NOT NULL, staging_bytes INTEGER NOT NULL, other_bytes INTEGER NOT NULL, anomaly TEXT
);
CREATE TABLE storage_audit (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TRIGGER storage_audit_no_update BEFORE UPDATE ON storage_audit BEGIN SELECT RAISE(ABORT,'Storage audit is immutable'); END;
CREATE TRIGGER storage_audit_no_delete BEFORE DELETE ON storage_audit BEGIN SELECT RAISE(ABORT,'Storage audit is immutable'); END;
CREATE TRIGGER storage_audit_no_replace BEFORE INSERT ON storage_audit WHEN EXISTS(SELECT 1 FROM storage_audit WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Storage audit is immutable'); END;
CREATE TABLE cold_proofs (
 file_id TEXT PRIMARY KEY REFERENCES case_files(id), state TEXT NOT NULL CHECK(state IN('verifying','dry_run','blocked','deleting','cold')),
 lease_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT,
 backup_version INTEGER, case_version INTEGER, sha256 TEXT, r2_version TEXT, etag TEXT, size INTEGER,
 verified_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE drive_quota_snapshots (
 id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
 total_bytes INTEGER, used_bytes INTEGER, state TEXT NOT NULL CHECK(state IN('known','unlimited','unknown','error')),
 CHECK(total_bytes IS NULL OR total_bytes>=0), CHECK(used_bytes IS NULL OR used_bytes>=0)
);
CREATE TABLE storage_alerts (
 id TEXT PRIMARY KEY, episode INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN('90','95','cleanup_failed','recovered')),
 created_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','claimed','sent','ambiguous','disabled')),
 UNIQUE(episode,kind)
);
CREATE TABLE storage_alert_deliveries (
 id TEXT PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES storage_alerts(id), recipient_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN('reserved','sent','ambiguous','rejected')),
 UNIQUE(alert_id,recipient_hash)
);

CREATE INDEX storage_delivery_quota ON storage_alert_deliveries(created_at);
CREATE INDEX storage_history_time ON storage_history(created_at DESC);
CREATE INDEX storage_quota_time ON drive_quota_snapshots(received_at DESC);
CREATE INDEX idx_cases_storage_closed ON cases(status,coalesce(status_updated_at,updated_at),id);
CREATE INDEX storage_cleanup_queue ON cold_proofs(state,lease_until);

CREATE TRIGGER storage_cancel_count AFTER UPDATE OF state ON storage_reservations WHEN OLD.state='reserved' AND NEW.state='cancelled' BEGIN
 UPDATE storage_capacity SET reserved_bytes=reserved_bytes-NEW.bytes WHERE id=1;
END;

-- New export snapshots cannot race R2 archival or silently omit a cold proof.
CREATE TRIGGER archive_export_insert_guard BEFORE INSERT ON export_job_items
WHEN EXISTS(SELECT 1 FROM cold_proofs p WHERE p.file_id=NEW.file_id AND p.state IN('verifying','deleting','cold'))
BEGIN SELECT RAISE(ABORT,'EXPORT_ARCHIVED_PROOF'); END;
-- A cold proof must be restored under a separate capacity-controlled operation before reopening.
CREATE TRIGGER archive_case_reopen_guard BEFORE UPDATE OF status ON cases
WHEN NEW.status NOT IN('completed','rejected','revoked') AND EXISTS(
 SELECT 1 FROM case_files f JOIN cold_proofs p ON p.file_id=f.id WHERE f.case_id=NEW.id AND p.state='cold')
BEGIN SELECT RAISE(ABORT,'ARCHIVED_PROOF_REQUIRES_RESTORE'); END;
