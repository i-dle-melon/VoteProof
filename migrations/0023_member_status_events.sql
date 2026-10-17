-- Local/source only. Member status remains authoritative; events preserve the audit trail.
CREATE TABLE member_status_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 member_id TEXT NOT NULL REFERENCES members(member_id),
 created_at TEXT NOT NULL,
 admin_member_id TEXT NOT NULL REFERENCES members(member_id),
 admin_role TEXT NOT NULL CHECK(admin_role IN ('admin','super_admin')),
 action TEXT NOT NULL CHECK(action IN ('member_block','member_restore')),
 before_status TEXT NOT NULL CHECK(before_status IN ('active','suspended')),
 after_status TEXT NOT NULL CHECK(after_status IN ('active','suspended')),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 CHECK((action='member_block' AND before_status='active' AND after_status='suspended') OR
       (action='member_restore' AND before_status='suspended' AND after_status='active'))
);
CREATE INDEX idx_member_status_events_member ON member_status_events(member_id,sequence DESC);
CREATE TRIGGER member_status_events_no_update BEFORE UPDATE ON member_status_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMBER_STATUS_AUDIT'); END;
CREATE TRIGGER member_status_events_no_delete BEFORE DELETE ON member_status_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMBER_STATUS_AUDIT'); END;
CREATE TRIGGER member_status_events_no_replace BEFORE INSERT ON member_status_events WHEN EXISTS(SELECT 1 FROM member_status_events WHERE id=NEW.id OR sequence=NEW.sequence) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMBER_STATUS_AUDIT'); END;
