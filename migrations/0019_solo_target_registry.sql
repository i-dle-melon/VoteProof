-- Additive registry only. Existing Campaign keys and ledger rows stay intact,
-- including unknown historical targets; no FK/backfill/rename is imposed.
CREATE TABLE solo_targets (
  target_id TEXT PRIMARY KEY NOT NULL CHECK(length(target_id) BETWEEN 1 AND 100 AND substr(target_id,1,1) GLOB '[A-Za-z0-9]' AND target_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 100),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0)
);
CREATE TRIGGER solo_targets_stable_identity BEFORE UPDATE OF target_id ON solo_targets
WHEN NEW.target_id IS NOT OLD.target_id
BEGIN SELECT RAISE(ABORT, 'SOLO_TARGET_IMMUTABLE'); END;
INSERT INTO solo_targets(target_id,display_name,active,sort_order) VALUES
  ('miyeon','MIYEON',1,1),
  ('minnie','MINNIE',1,2),
  ('soyeon','SOYEON',1,3),
  ('yuqi','YUQI',1,4),
  ('shuhua','SHUHUA',1,5);
