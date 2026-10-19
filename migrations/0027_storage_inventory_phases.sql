-- Additive, local/isolated validation only. NULL preserves legacy scans.
-- Old callers cannot finalize a segmented scan or reuse its ready cursor.
ALTER TABLE storage_capacity ADD COLUMN inventory_phase TEXT
 CHECK(inventory_phase IS NULL OR
  (inventory_id IS NOT NULL AND
   (inventory_phase='scan' OR (inventory_phase='ready' AND inventory_cursor IS NULL))));
