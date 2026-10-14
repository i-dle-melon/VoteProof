-- Local/source only. Existing IDs are preserved. A normalization collision
-- aborts CREATE UNIQUE INDEX (and the migration transaction); resolve manually.
CREATE UNIQUE INDEX members_fan_id_unique ON members(lower(trim(player_id))) WHERE player_id IS NOT NULL;
CREATE INDEX members_nickname_warning ON members(nickname);
CREATE TRIGGER members_fan_id_no_replace BEFORE INSERT ON members
WHEN NEW.player_id IS NOT NULL AND EXISTS(SELECT 1 FROM members WHERE lower(trim(player_id))=lower(trim(NEW.player_id)))
BEGIN SELECT RAISE(ABORT, 'FAN_ID_TAKEN'); END;
CREATE TRIGGER members_fan_id_immutable BEFORE UPDATE OF player_id ON members
WHEN OLD.player_id IS NOT NULL AND NEW.player_id IS NOT OLD.player_id
BEGIN SELECT RAISE(ABORT, 'FAN_ID_IMMUTABLE'); END;
CREATE TRIGGER members_no_replace_identity BEFORE INSERT ON members
WHEN EXISTS(SELECT 1 FROM members WHERE member_id=NEW.member_id OR id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'Member identity already exists'); END;

-- Stable Solo key shared across campaigns. No inferred keys or data backfill.
ALTER TABLE campaigns ADD COLUMN solo_target TEXT CHECK(solo_target IS NULL OR (length(solo_target) BETWEEN 1 AND 100 AND solo_target NOT GLOB '*[^A-Za-z0-9_-]*'));
CREATE TRIGGER campaigns_fixed_type_insert BEFORE INSERT ON campaigns
WHEN NEW.category NOT IN ('Solo','團體') OR (NEW.category='Solo' AND NEW.solo_target IS NULL) OR (NEW.category='團體' AND NEW.solo_target IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'CAMPAIGN_TYPE_INVALID'); END;
CREATE TRIGGER campaigns_fixed_type_update BEFORE UPDATE OF category,solo_target ON campaigns
WHEN NEW.category NOT IN ('Solo','團體') OR (NEW.category='Solo' AND NEW.solo_target IS NULL) OR (NEW.category='團體' AND NEW.solo_target IS NOT NULL)
 OR (OLD.status!='draft' AND NEW.category!=OLD.category)
 OR (OLD.solo_target IS NOT NULL AND NEW.solo_target IS NOT OLD.solo_target)
BEGIN SELECT RAISE(ABORT, 'CAMPAIGN_TYPE_IMMUTABLE_OR_INVALID'); END;
CREATE TRIGGER cases_campaign_type_insert BEFORE INSERT ON cases
WHEN NOT EXISTS(SELECT 1 FROM campaigns p WHERE p.campaign_id=NEW.campaign_id AND p.category=NEW.vote_type
 AND (p.category='團體' OR (p.category='Solo' AND p.solo_target IS NOT NULL)))
BEGIN SELECT RAISE(ABORT, 'CAMPAIGN_TYPE_MISMATCH'); END;
CREATE TRIGGER cases_fixed_identity_type BEFORE UPDATE OF campaign_id,vote_type,member_id,source ON cases
WHEN NEW.campaign_id!=OLD.campaign_id OR NEW.vote_type!=OLD.vote_type OR NEW.member_id IS NOT OLD.member_id OR NEW.source!=OLD.source
BEGIN SELECT RAISE(ABORT, 'Case identity and campaign type are immutable'); END;
-- Historical all_time snapshots are retained for audit, never served or rebuilt.
CREATE TRIGGER boards_fixed_no_update BEFORE UPDATE ON leaderboards WHEN OLD.type='all_time' OR NEW.type='all_time'
BEGIN SELECT RAISE(ABORT, 'SYSTEM_LEADERBOARD_IMMUTABLE'); END;
CREATE TRIGGER boards_fixed_no_insert BEFORE INSERT ON leaderboards WHEN NEW.type='all_time'
BEGIN SELECT RAISE(ABORT, 'SYSTEM_LEADERBOARD_IMMUTABLE'); END;
CREATE TRIGGER boards_fixed_no_run BEFORE INSERT ON leaderboard_runs
WHEN EXISTS(SELECT 1 FROM leaderboards WHERE leaderboard_id=NEW.leaderboard_id AND type='all_time')
BEGIN SELECT RAISE(ABORT, 'SYSTEM_LEADERBOARD_NO_REBUILD'); END;
