-- Install after the reset fence and isolated R2 scope extension.
-- This keeps sampled capacity apart
-- from the ledger that controls admission and manual cleanup.
CREATE TABLE r2_safety_inventory (
 id INTEGER PRIMARY KEY CHECK (id=1),
 scan_id TEXT,
 scan_epoch INTEGER,
 scan_control_version INTEGER,
 cursor TEXT,
 scan_bytes INTEGER NOT NULL DEFAULT 0 CHECK(scan_bytes>=0),
 scan_objects INTEGER NOT NULL DEFAULT 0 CHECK(scan_objects>=0),
 invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN(0,1)),
 latest TEXT CHECK(latest IS NULL OR json_valid(latest))
);
INSERT INTO r2_safety_inventory(id) VALUES(1);

-- One invalidation per active scan. With no scan, ordinary R2 operations
-- keep their existing write count. This catches native I/O before dispatch.
CREATE TRIGGER r2_safety_inventory_invalidate
AFTER UPDATE OF pending_r2,r2_writes ON prelaunch_reset_operations
WHEN (NEW.pending_r2<>OLD.pending_r2 OR NEW.r2_writes<>OLD.r2_writes)
 AND EXISTS(SELECT 1 FROM r2_safety_inventory WHERE id=1 AND scan_id IS NOT NULL AND invalidated=0)
BEGIN
 UPDATE r2_safety_inventory SET invalidated=1 WHERE id=1;
END;

CREATE TRIGGER r2_safety_inventory_receipt
AFTER UPDATE OF latest ON r2_safety_inventory
WHEN NEW.latest IS NOT NULL AND NEW.latest IS NOT OLD.latest
BEGIN
 INSERT INTO storage_audit(id,created_at,action,target,detail)
 VALUES(json_extract(NEW.latest,'$.id'),json_extract(NEW.latest,'$.observed_at'),
        'safety_inventory',json_extract(NEW.latest,'$.id'),NEW.latest);
END;
