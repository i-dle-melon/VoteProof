-- Preserve every historical row. A non-null scope identifies writes that
-- could touch the isolated namespace. Multiple isolated keys fail closed.
ALTER TABLE prelaunch_reset_operations ADD COLUMN isolated_r2_key TEXT
 CHECK(isolated_r2_key IS NULL OR isolated_r2_key='*' OR isolated_r2_key LIKE 'proofs/final/isolated/%');

CREATE INDEX prelaunch_reset_isolated_r2_blockers ON prelaunch_reset_operations(isolated_r2_key)
 WHERE pending_r2>0 OR (state='unknown' AND r2_writes>0);
