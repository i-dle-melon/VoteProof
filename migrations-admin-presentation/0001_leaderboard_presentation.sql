-- Independent display-only extension. Original all_time guards remain intact.
CREATE TABLE admin_leaderboard_presentations(
 leaderboard_id TEXT PRIMARY KEY CHECK(leaderboard_id IN('system-history','system-group','system-solo')),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),top_n INTEGER NOT NULL CHECK(top_n BETWEEN 1 AND 100),
 is_public INTEGER NOT NULL CHECK(is_public IN(0,1)),version INTEGER NOT NULL CHECK(version>=1),
 updated_at TEXT NOT NULL,updated_by TEXT NOT NULL REFERENCES members(member_id),last_mutation_id TEXT NOT NULL
) WITHOUT ROWID;
CREATE TRIGGER admin_board_presentation_insert BEFORE INSERT ON admin_leaderboard_presentations BEGIN
 SELECT CASE WHEN NEW.version<>1 OR NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON p.epoch=c.epoch AND c.id=1
 JOIN prelaunch_reset_operations o ON o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'
 WHERE p.id=1 AND p.purpose='normal' AND c.mode='open') THEN RAISE(ABORT,'PRELAUNCH_WRITE_FENCED') END;
END;
CREATE TRIGGER admin_board_presentation_update BEFORE UPDATE ON admin_leaderboard_presentations BEGIN
 SELECT CASE WHEN NEW.leaderboard_id<>OLD.leaderboard_id OR NEW.version<>OLD.version+1 OR NOT EXISTS(
 SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON p.epoch=c.epoch AND c.id=1
 JOIN prelaunch_reset_operations o ON o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'
 WHERE p.id=1 AND p.purpose='normal' AND c.mode='open') THEN RAISE(ABORT,'PRESENTATION_CAS_REQUIRED') END;
END;
CREATE TRIGGER admin_board_presentation_no_delete BEFORE DELETE ON admin_leaderboard_presentations BEGIN SELECT RAISE(ABORT,'PRESENTATION_IMMUTABLE'); END;
CREATE TRIGGER admin_board_presentation_no_replace BEFORE INSERT ON admin_leaderboard_presentations WHEN EXISTS(SELECT 1 FROM admin_leaderboard_presentations WHERE leaderboard_id=NEW.leaderboard_id) BEGIN SELECT RAISE(ABORT,'PRESENTATION_IMMUTABLE'); END;
