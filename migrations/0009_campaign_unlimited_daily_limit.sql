-- Rebuild inside the migration transaction; retain child FK references/data.
-- NULL = unlimited; 0 = no awards; 1..1000 = daily scored approval cap.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE campaigns_next (
  campaign_id TEXT PRIMARY KEY NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 50),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL CHECK (start_at < end_at),
  campaign_timezone TEXT NOT NULL,
  vote_start_date TEXT NOT NULL,
  vote_end_date TEXT NOT NULL CHECK (vote_start_date <= vote_end_date),
  points_per_proof INTEGER NOT NULL CHECK (typeof(points_per_proof) = 'integer' AND points_per_proof BETWEEN 0 AND 1000000),
  daily_limit INTEGER CHECK (daily_limit IS NULL OR (typeof(daily_limit) = 'integer' AND daily_limit BETWEEN 0 AND 1000)),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'closed', 'archived')),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT REFERENCES members(member_id),
  updated_by TEXT REFERENCES members(member_id),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_mutation_id TEXT UNIQUE
);
INSERT INTO campaigns_next (campaign_id,name,category,start_at,end_at,campaign_timezone,
 vote_start_date,vote_end_date,points_per_proof,daily_limit,status,note,
 created_at,updated_at,created_by,updated_by,version,last_mutation_id)
SELECT campaign_id,name,category,start_at,end_at,campaign_timezone,
 vote_start_date,vote_end_date,points_per_proof,daily_limit,status,note,
 created_at,updated_at,created_by,updated_by,version,last_mutation_id FROM campaigns;
DROP TRIGGER campaigns_immutable_id;
DROP TRIGGER campaigns_no_delete;
DROP TRIGGER campaigns_no_replace;
DROP TRIGGER campaigns_update_policy;
DROP TABLE campaigns;
ALTER TABLE campaigns_next RENAME TO campaigns;
CREATE INDEX idx_campaigns_public ON campaigns(status, start_at, campaign_id);
CREATE INDEX idx_campaigns_admin ON campaigns(created_at DESC, campaign_id DESC);
CREATE TRIGGER campaigns_immutable_id BEFORE UPDATE OF campaign_id ON campaigns
WHEN NEW.campaign_id != OLD.campaign_id
BEGIN SELECT RAISE(ABORT, 'Campaign identity is immutable'); END;
CREATE TRIGGER campaigns_no_delete BEFORE DELETE ON campaigns
BEGIN SELECT RAISE(ABORT, 'Archive campaigns instead of deleting'); END;
CREATE TRIGGER campaigns_no_replace BEFORE INSERT ON campaigns
WHEN EXISTS (SELECT 1 FROM campaigns WHERE campaign_id = NEW.campaign_id)
BEGIN SELECT RAISE(ABORT, 'Campaign identity already exists'); END;
CREATE TRIGGER campaigns_update_policy BEFORE UPDATE ON campaigns
WHEN OLD.status = 'archived'
  OR (OLD.status != NEW.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('active', 'archived')) OR
    (OLD.status = 'active' AND NEW.status = 'closed') OR
    (OLD.status = 'closed' AND NEW.status = 'archived')))
  OR (OLD.status != 'draft' AND (OLD.start_at != NEW.start_at OR OLD.end_at != NEW.end_at
    OR OLD.campaign_timezone != NEW.campaign_timezone OR OLD.vote_start_date != NEW.vote_start_date OR OLD.vote_end_date != NEW.vote_end_date))
BEGIN SELECT RAISE(ABORT, 'Invalid campaign transition or window change'); END;


-- SQLite parent-table rebuilds can retain deferred DROP bookkeeping even after
-- restoring the parent. Validate the actual complete FK graph BEFORE resetting
-- that bookkeeping; any violation aborts the entire migration transaction.
CREATE TABLE campaign_migration_guard (valid INTEGER NOT NULL CHECK(valid = 1));
INSERT INTO campaign_migration_guard(valid)
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
DROP TABLE campaign_migration_guard;
PRAGMA defer_foreign_keys = OFF;
