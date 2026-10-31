-- Independent opt-in extension. Never rewrite 0001-0028 or the Reset Schema.
-- Installing this extension alone preserves the existing admission policy.
ALTER TABLE storage_capacity ADD COLUMN upload_policy TEXT NOT NULL DEFAULT 'enforced'
 CHECK(upload_policy IN('enforced','observe'));
ALTER TABLE storage_capacity ADD COLUMN inventory_dirty INTEGER NOT NULL DEFAULT 0 CHECK(inventory_dirty IN(0,1));

DROP TRIGGER storage_reserve_guard;
CREATE TRIGGER storage_reserve_guard BEFORE INSERT ON storage_reservations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND anomaly IS NULL
 AND used_bytes>=0 AND reserved_bytes>=0 AND used_bytes+reserved_bytes+NEW.bytes<=9007199254740991
 AND (upload_policy='observe' OR (upload_policy='enforced' AND blocked=0 AND inventory_id IS NULL
 AND trusted_until>CAST(strftime('%s','now') AS INTEGER)
 AND used_bytes+reserved_bytes+NEW.bytes<9500000000))) THEN RAISE(ABORT,'R2_STORAGE_CAPACITY_EXCEEDED') END;
END;

-- Account for every reservation as before. A concurrent write invalidates the
-- scan, never its pin/cursor or any UNKNOWN; no mixed-time snapshot may finalize.
DROP TRIGGER storage_reserve_count;
CREATE TRIGGER storage_reserve_count AFTER INSERT ON storage_reservations BEGIN
 UPDATE storage_capacity SET reserved_bytes=reserved_bytes+NEW.bytes,
 trusted_until=CASE WHEN inventory_id IS NOT NULL THEN 0 ELSE trusted_until END,
 inventory_dirty=CASE WHEN inventory_id IS NOT NULL THEN 1 ELSE inventory_dirty END,
 inventory_version=inventory_version+CASE WHEN inventory_id IS NOT NULL THEN 1 ELSE 0 END WHERE id=1;
END;
DROP TRIGGER storage_commit_count;
CREATE TRIGGER storage_commit_count AFTER UPDATE OF state ON storage_reservations WHEN OLD.state='reserved' AND NEW.state='committed' BEGIN
 UPDATE storage_capacity SET used_bytes=used_bytes+NEW.bytes,reserved_bytes=reserved_bytes-NEW.bytes,
 trusted_until=CASE WHEN inventory_id IS NOT NULL THEN 0 ELSE trusted_until END,
 inventory_dirty=CASE WHEN inventory_id IS NOT NULL THEN 1 ELSE inventory_dirty END,
 inventory_version=inventory_version+CASE WHEN inventory_id IS NOT NULL THEN 1 ELSE 0 END WHERE id=1;
END;
DROP TRIGGER storage_cancel_count;
CREATE TRIGGER storage_cancel_count AFTER UPDATE OF state ON storage_reservations WHEN OLD.state='reserved' AND NEW.state='cancelled' BEGIN
 UPDATE storage_capacity SET reserved_bytes=reserved_bytes-NEW.bytes,
 trusted_until=CASE WHEN inventory_id IS NOT NULL THEN 0 ELSE trusted_until END,
 inventory_dirty=CASE WHEN inventory_id IS NOT NULL THEN 1 ELSE inventory_dirty END,
 inventory_version=inventory_version+CASE WHEN inventory_id IS NOT NULL THEN 1 ELSE 0 END WHERE id=1;
END;

-- Also fence old Runtime instances: they do not know inventory_dirty. They
-- cannot publish or silently discard a mixed-time scan after a concurrent IO.
CREATE TRIGGER storage_inventory_publish_guard BEFORE UPDATE OF used_bytes,trusted_until,inventory_id ON storage_capacity
WHEN OLD.inventory_id IS NOT NULL AND OLD.inventory_dirty=1
 AND (NEW.trusted_until>0 OR NEW.inventory_id IS NULL)
BEGIN SELECT RAISE(ABORT,'STORAGE_INVENTORY_INVALIDATED'); END;
