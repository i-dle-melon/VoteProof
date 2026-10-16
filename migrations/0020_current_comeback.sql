-- Additive only. Existing boards deliberately remain unselected.
ALTER TABLE leaderboards ADD COLUMN is_current_comeback INTEGER NOT NULL DEFAULT 0
  CHECK(is_current_comeback IN (0,1));
CREATE UNIQUE INDEX idx_leaderboards_one_current_comeback
  ON leaderboards(is_current_comeback) WHERE is_current_comeback = 1;
CREATE TRIGGER leaderboards_current_comeback_insert BEFORE INSERT ON leaderboards
WHEN NEW.is_current_comeback = 1 AND (NEW.type != 'campaign' OR NEW.status = 'archived')
BEGIN SELECT RAISE(ABORT, 'Current comeback requires a non-archived campaign board'); END;
CREATE TRIGGER leaderboards_current_comeback_update BEFORE UPDATE ON leaderboards
WHEN NEW.is_current_comeback = 1 AND (NEW.type != 'campaign' OR NEW.status = 'archived')
BEGIN SELECT RAISE(ABORT, 'Current comeback requires a non-archived campaign board'); END;
