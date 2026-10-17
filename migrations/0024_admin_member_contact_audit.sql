-- Additive only. No identity, case, campaign or points data is rewritten.
CREATE TABLE admin_member_mail_requests (
 send_id TEXT PRIMARY KEY NOT NULL,
 created_at TEXT NOT NULL,
 admin_member_id TEXT NOT NULL REFERENCES members(member_id),
 admin_role TEXT NOT NULL CHECK(admin_role IN ('admin','super_admin')),
 target_member_id TEXT NOT NULL REFERENCES members(member_id),
 subject_hash TEXT NOT NULL CHECK(length(subject_hash)=64),
 body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
 recipient_ref TEXT NOT NULL CHECK(length(recipient_ref)=64)
);
CREATE INDEX idx_admin_member_mail_admin ON admin_member_mail_requests(admin_member_id,created_at);
CREATE INDEX idx_admin_member_mail_global ON admin_member_mail_requests(created_at);
CREATE TABLE admin_member_contact_audit (
 id TEXT PRIMARY KEY NOT NULL,
 created_at TEXT NOT NULL,
 admin_member_id TEXT NOT NULL REFERENCES members(member_id),
 admin_role TEXT NOT NULL CHECK(admin_role IN ('admin','super_admin')),
 target_member_id TEXT NOT NULL REFERENCES members(member_id),
 action TEXT NOT NULL CHECK(action IN ('member_lookup','member_mail_send')),
 send_id TEXT UNIQUE REFERENCES admin_member_mail_requests(send_id),
 outcome TEXT NOT NULL CHECK(outcome IN ('revealed','sent','rejected','ambiguous')),
 subject_hash TEXT CHECK(subject_hash IS NULL OR length(subject_hash)=64),
 body_hash TEXT CHECK(body_hash IS NULL OR length(body_hash)=64),
 CHECK((action='member_lookup' AND send_id IS NULL AND outcome='revealed' AND subject_hash IS NULL AND body_hash IS NULL) OR
       (action='member_mail_send' AND send_id IS NOT NULL AND outcome IN ('sent','rejected','ambiguous') AND subject_hash IS NOT NULL AND body_hash IS NOT NULL))
);
CREATE INDEX idx_admin_member_contact_lookup ON admin_member_contact_audit(admin_member_id,target_member_id,action,created_at);
CREATE TRIGGER admin_member_contact_no_update BEFORE UPDATE ON admin_member_contact_audit BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMBER_CONTACT_AUDIT'); END;
CREATE TRIGGER admin_member_contact_no_delete BEFORE DELETE ON admin_member_contact_audit BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMBER_CONTACT_AUDIT'); END;
CREATE TRIGGER admin_member_contact_no_replace BEFORE INSERT ON admin_member_contact_audit WHEN EXISTS(SELECT 1 FROM admin_member_contact_audit WHERE id=NEW.id OR (NEW.send_id IS NOT NULL AND send_id=NEW.send_id)) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMBER_CONTACT_AUDIT'); END;
CREATE TRIGGER admin_member_mail_no_update BEFORE UPDATE ON admin_member_mail_requests BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMBER_MAIL_REQUEST'); END;
CREATE TRIGGER admin_member_mail_no_delete BEFORE DELETE ON admin_member_mail_requests BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMBER_MAIL_REQUEST'); END;
CREATE TRIGGER admin_member_mail_no_replace BEFORE INSERT ON admin_member_mail_requests WHEN EXISTS(SELECT 1 FROM admin_member_mail_requests WHERE send_id=NEW.send_id) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMBER_MAIL_REQUEST'); END;
CREATE TRIGGER admin_member_contact_send_binding BEFORE INSERT ON admin_member_contact_audit WHEN NEW.action='member_mail_send' AND NOT EXISTS(
 SELECT 1 FROM admin_member_mail_requests r WHERE r.send_id=NEW.send_id AND r.admin_member_id=NEW.admin_member_id AND r.admin_role=NEW.admin_role
 AND r.target_member_id=NEW.target_member_id AND r.subject_hash=NEW.subject_hash AND r.body_hash=NEW.body_hash
) BEGIN SELECT RAISE(ABORT,'MEMBER_MAIL_AUDIT_BINDING'); END;
