-- reset-v1/0001: independent namespace, NOT main migration 0029/0030/0031.
CREATE TABLE prelaunch_reset_schema_versions(version INTEGER PRIMARY KEY,sql_sha256 TEXT NOT NULL,applied_at TEXT NOT NULL);
CREATE TABLE prelaunch_reset_control(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL CHECK(epoch>=0),mode TEXT NOT NULL CHECK(mode IN('open','maintenance')),version INTEGER NOT NULL,run_id TEXT);
INSERT INTO prelaunch_reset_control VALUES(1,0,'maintenance',0,NULL);
CREATE TABLE prelaunch_reset_operations(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('active','completed','unknown')),pending_r2 INTEGER NOT NULL DEFAULT 0 CHECK(pending_r2>=0),r2_writes INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,ended_at TEXT);
CREATE INDEX prelaunch_reset_operations_state ON prelaunch_reset_operations(state);
CREATE TABLE prelaunch_reset_permit(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,operation_id TEXT,purpose TEXT NOT NULL CHECK(purpose IN('normal','reset')),scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),run_id TEXT);
CREATE TABLE prelaunch_reset_issuance(session_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN('legacy','v2','direct')),keys_json TEXT NOT NULL CHECK(json_valid(keys_json)),created_at TEXT NOT NULL);
CREATE TABLE prelaunch_reset_retired_keys(object_key TEXT PRIMARY KEY,epoch INTEGER NOT NULL,run_id TEXT NOT NULL REFERENCES prelaunch_reset_audit(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE prelaunch_reset_audit(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL CHECK(json_valid(detail)));
CREATE TRIGGER prelaunch_reset_issuance_admission BEFORE INSERT ON prelaunch_reset_issuance
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch JOIN prelaunch_reset_operations o ON o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active' WHERE p.id=1 AND p.purpose='normal' AND c.mode='open' AND NEW.epoch=c.epoch)
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_ISSUANCE_FENCED');END;
CREATE TRIGGER prelaunch_reset_issuance_no_update BEFORE UPDATE ON prelaunch_reset_issuance BEGIN SELECT RAISE(ABORT,'RESET_ISSUANCE_IMMUTABLE');END;
CREATE TRIGGER prelaunch_reset_issuance_no_delete BEFORE DELETE ON prelaunch_reset_issuance BEGIN SELECT RAISE(ABORT,'RESET_ISSUANCE_IMMUTABLE');END;
CREATE TRIGGER prelaunch_reset_audit_no_update BEFORE UPDATE ON prelaunch_reset_audit BEGIN SELECT RAISE(ABORT,'RESET_AUDIT_IMMUTABLE');END;
CREATE TRIGGER prelaunch_reset_audit_no_delete BEFORE DELETE ON prelaunch_reset_audit BEGIN SELECT RAISE(ABORT,'RESET_AUDIT_IMMUTABLE');END;
CREATE TRIGGER prelaunch_reset_retired_no_update BEFORE UPDATE ON prelaunch_reset_retired_keys BEGIN SELECT RAISE(ABORT,'RESET_RETIREMENT_IMMUTABLE');END;
CREATE TRIGGER prelaunch_reset_retired_no_delete BEFORE DELETE ON prelaunch_reset_retired_keys BEGIN SELECT RAISE(ABORT,'RESET_RETIREMENT_IMMUTABLE');END;
CREATE TRIGGER prelaunch_fence_admin_audit_logs_insert BEFORE INSERT ON "admin_audit_logs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_audit_logs.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_audit_logs_update BEFORE UPDATE ON "admin_audit_logs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_audit_logs.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_audit_logs_delete BEFORE DELETE ON "admin_audit_logs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_audit_logs.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_content_audit_insert BEFORE INSERT ON "admin_content_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_content_audit.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_content_audit_update BEFORE UPDATE ON "admin_content_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_content_audit.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_content_audit_delete BEFORE DELETE ON "admin_content_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_content_audit.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_member_contact_audit_insert BEFORE INSERT ON "admin_member_contact_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_member_contact_audit.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_member_contact_audit_update BEFORE UPDATE ON "admin_member_contact_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_member_contact_audit.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_member_contact_audit_delete BEFORE DELETE ON "admin_member_contact_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_member_contact_audit.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_member_mail_requests_insert BEFORE INSERT ON "admin_member_mail_requests"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_member_mail_requests.insert') s WHERE s.value=json_array(NEW."send_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_member_mail_requests_update BEFORE UPDATE ON "admin_member_mail_requests"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_member_mail_requests.update') s WHERE s.value=json_array(OLD."send_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_member_mail_requests_delete BEFORE DELETE ON "admin_member_mail_requests"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_member_mail_requests.delete') s WHERE s.value=json_array(OLD."send_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_memberships_insert BEFORE INSERT ON "admin_memberships"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_memberships.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_memberships_update BEFORE UPDATE ON "admin_memberships"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_memberships.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_admin_memberships_delete BEFORE DELETE ON "admin_memberships"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.admin_memberships.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_atomic_guards_insert BEFORE INSERT ON "auth_atomic_guards"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_atomic_guards.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_atomic_guards_update BEFORE UPDATE ON "auth_atomic_guards"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_atomic_guards.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_atomic_guards_delete BEFORE DELETE ON "auth_atomic_guards"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_atomic_guards.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_email_challenges_insert BEFORE INSERT ON "auth_email_challenges"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_email_challenges.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_email_challenges_update BEFORE UPDATE ON "auth_email_challenges"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_email_challenges.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_email_challenges_delete BEFORE DELETE ON "auth_email_challenges"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_email_challenges.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_email_sends_insert BEFORE INSERT ON "auth_email_sends"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_email_sends.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_email_sends_update BEFORE UPDATE ON "auth_email_sends"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_email_sends.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_email_sends_delete BEFORE DELETE ON "auth_email_sends"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_email_sends.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_enrollments_insert BEFORE INSERT ON "auth_enrollments"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_enrollments.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_enrollments_update BEFORE UPDATE ON "auth_enrollments"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_enrollments.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_enrollments_delete BEFORE DELETE ON "auth_enrollments"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_enrollments.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_google_flows_insert BEFORE INSERT ON "auth_google_flows"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_google_flows.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_google_flows_update BEFORE UPDATE ON "auth_google_flows"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_google_flows.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_google_flows_delete BEFORE DELETE ON "auth_google_flows"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_google_flows.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_identities_insert BEFORE INSERT ON "auth_identities"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_identities.insert') s WHERE s.value=json_array(NEW."provider_subject")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_identities_update BEFORE UPDATE ON "auth_identities"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_identities.update') s WHERE s.value=json_array(OLD."provider_subject")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_identities_delete BEFORE DELETE ON "auth_identities"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_identities.delete') s WHERE s.value=json_array(OLD."provider_subject")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_identity_events_insert BEFORE INSERT ON "auth_identity_events"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_identity_events.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_identity_events_update BEFORE UPDATE ON "auth_identity_events"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_identity_events.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_identity_events_delete BEFORE DELETE ON "auth_identity_events"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_identity_events.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_method_setups_insert BEFORE INSERT ON "auth_method_setups"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_method_setups.insert') s WHERE s.value=json_array(NEW."member_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_method_setups_update BEFORE UPDATE ON "auth_method_setups"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_method_setups.update') s WHERE s.value=json_array(OLD."member_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_method_setups_delete BEFORE DELETE ON "auth_method_setups"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_method_setups.delete') s WHERE s.value=json_array(OLD."member_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_password_operations_insert BEFORE INSERT ON "auth_password_operations"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_password_operations.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_password_operations_update BEFORE UPDATE ON "auth_password_operations"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_password_operations.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_password_operations_delete BEFORE DELETE ON "auth_password_operations"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_password_operations.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_rate_limits_insert BEFORE INSERT ON "auth_rate_limits"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_rate_limits.insert') s WHERE s.value=json_array(NEW."scope_hash",NEW."window_start")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_rate_limits_update BEFORE UPDATE ON "auth_rate_limits"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_rate_limits.update') s WHERE s.value=json_array(OLD."scope_hash",OLD."window_start")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_rate_limits_delete BEFORE DELETE ON "auth_rate_limits"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_rate_limits.delete') s WHERE s.value=json_array(OLD."scope_hash",OLD."window_start")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_sessions_insert BEFORE INSERT ON "auth_sessions"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_sessions.insert') s WHERE s.value=json_array(NEW."token_hash")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_sessions_update BEFORE UPDATE ON "auth_sessions"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_sessions.update') s WHERE s.value=json_array(OLD."token_hash")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_sessions_delete BEFORE DELETE ON "auth_sessions"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_sessions.delete') s WHERE s.value=json_array(OLD."token_hash")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_transactions_insert BEFORE INSERT ON "auth_transactions"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_transactions.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_transactions_update BEFORE UPDATE ON "auth_transactions"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_transactions.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_auth_transactions_delete BEFORE DELETE ON "auth_transactions"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.auth_transactions.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_backup_admin_audit_insert BEFORE INSERT ON "backup_admin_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.backup_admin_audit.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_backup_admin_audit_update BEFORE UPDATE ON "backup_admin_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.backup_admin_audit.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_backup_admin_audit_delete BEFORE DELETE ON "backup_admin_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.backup_admin_audit.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_backup_processor_lock_insert BEFORE INSERT ON "backup_processor_lock"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.backup_processor_lock.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_backup_processor_lock_update BEFORE UPDATE ON "backup_processor_lock"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.backup_processor_lock.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_backup_processor_lock_delete BEFORE DELETE ON "backup_processor_lock"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.backup_processor_lock.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_campaign_content_insert BEFORE INSERT ON "campaign_content"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.campaign_content.insert') s WHERE s.value=json_array(NEW."campaign_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_campaign_content_update BEFORE UPDATE ON "campaign_content"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.campaign_content.update') s WHERE s.value=json_array(OLD."campaign_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_campaign_content_delete BEFORE DELETE ON "campaign_content"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.campaign_content.delete') s WHERE s.value=json_array(OLD."campaign_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_campaign_example_assets_insert BEFORE INSERT ON "campaign_example_assets"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.campaign_example_assets.insert') s WHERE s.value=json_array(NEW."asset_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_campaign_example_assets_update BEFORE UPDATE ON "campaign_example_assets"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.campaign_example_assets.update') s WHERE s.value=json_array(OLD."asset_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_campaign_example_assets_delete BEFORE DELETE ON "campaign_example_assets"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.campaign_example_assets.delete') s WHERE s.value=json_array(OLD."asset_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_campaigns_insert BEFORE INSERT ON "campaigns"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.campaigns.insert') s WHERE s.value=json_array(NEW."campaign_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_campaigns_update BEFORE UPDATE ON "campaigns"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.campaigns.update') s WHERE s.value=json_array(OLD."campaign_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_campaigns_delete BEFORE DELETE ON "campaigns"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.campaigns.delete') s WHERE s.value=json_array(OLD."campaign_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_case_files_insert BEFORE INSERT ON "case_files"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.case_files.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_case_files_update BEFORE UPDATE ON "case_files"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.case_files.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_case_files_delete BEFORE DELETE ON "case_files"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.case_files.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_case_idempotency_insert BEFORE INSERT ON "case_idempotency"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.case_idempotency.insert') s WHERE s.value=json_array(NEW."key_hash")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_case_idempotency_update BEFORE UPDATE ON "case_idempotency"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.case_idempotency.update') s WHERE s.value=json_array(OLD."key_hash")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_case_idempotency_delete BEFORE DELETE ON "case_idempotency"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.case_idempotency.delete') s WHERE s.value=json_array(OLD."key_hash")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_cases_insert BEFORE INSERT ON "cases"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.cases.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_cases_update BEFORE UPDATE ON "cases"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.cases.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_cases_delete BEFORE DELETE ON "cases"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.cases.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_cold_proofs_insert BEFORE INSERT ON "cold_proofs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.cold_proofs.insert') s WHERE s.value=json_array(NEW."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_cold_proofs_update BEFORE UPDATE ON "cold_proofs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.cold_proofs.update') s WHERE s.value=json_array(OLD."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_cold_proofs_delete BEFORE DELETE ON "cold_proofs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.cold_proofs.delete') s WHERE s.value=json_array(OLD."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_completed_upload_files_insert BEFORE INSERT ON "completed_upload_files"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.completed_upload_files.insert') s WHERE s.value=json_array(NEW."session_id",NEW."object_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_completed_upload_files_update BEFORE UPDATE ON "completed_upload_files"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.completed_upload_files.update') s WHERE s.value=json_array(OLD."session_id",OLD."object_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_completed_upload_files_delete BEFORE DELETE ON "completed_upload_files"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.completed_upload_files.delete') s WHERE s.value=json_array(OLD."session_id",OLD."object_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_completed_uploads_insert BEFORE INSERT ON "completed_uploads"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.completed_uploads.insert') s WHERE s.value=json_array(NEW."session_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_completed_uploads_update BEFORE UPDATE ON "completed_uploads"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.completed_uploads.update') s WHERE s.value=json_array(OLD."session_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_completed_uploads_delete BEFORE DELETE ON "completed_uploads"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.completed_uploads.delete') s WHERE s.value=json_array(OLD."session_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_drive_backup_folders_insert BEFORE INSERT ON "drive_backup_folders"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.drive_backup_folders.insert') s WHERE s.value=json_array(NEW."root_folder_id",NEW."folder_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_drive_backup_folders_update BEFORE UPDATE ON "drive_backup_folders"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.drive_backup_folders.update') s WHERE s.value=json_array(OLD."root_folder_id",OLD."folder_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_drive_backup_folders_delete BEFORE DELETE ON "drive_backup_folders"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.drive_backup_folders.delete') s WHERE s.value=json_array(OLD."root_folder_id",OLD."folder_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_drive_quota_snapshots_insert BEFORE INSERT ON "drive_quota_snapshots"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.drive_quota_snapshots.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_drive_quota_snapshots_update BEFORE UPDATE ON "drive_quota_snapshots"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.drive_quota_snapshots.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_drive_quota_snapshots_delete BEFORE DELETE ON "drive_quota_snapshots"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.drive_quota_snapshots.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_completed_files_insert BEFORE INSERT ON "export_completed_files"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_completed_files.insert') s WHERE s.value=json_array(NEW."file_id",NEW."etag",NEW."file_size",NEW."content_type")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_completed_files_update BEFORE UPDATE ON "export_completed_files"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_completed_files.update') s WHERE s.value=json_array(OLD."file_id",OLD."etag",OLD."file_size",OLD."content_type")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_completed_files_delete BEFORE DELETE ON "export_completed_files"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_completed_files.delete') s WHERE s.value=json_array(OLD."file_id",OLD."etag",OLD."file_size",OLD."content_type")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_file_claims_insert BEFORE INSERT ON "export_file_claims"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_file_claims.insert') s WHERE s.value=json_array(NEW."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_file_claims_update BEFORE UPDATE ON "export_file_claims"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_file_claims.update') s WHERE s.value=json_array(OLD."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_file_claims_delete BEFORE DELETE ON "export_file_claims"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_file_claims.delete') s WHERE s.value=json_array(OLD."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_job_items_insert BEFORE INSERT ON "export_job_items"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_job_items.insert') s WHERE s.value=json_array(NEW."job_id",NEW."ordinal")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_job_items_update BEFORE UPDATE ON "export_job_items"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_job_items.update') s WHERE s.value=json_array(OLD."job_id",OLD."ordinal")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_job_items_delete BEFORE DELETE ON "export_job_items"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_job_items.delete') s WHERE s.value=json_array(OLD."job_id",OLD."ordinal")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_jobs_insert BEFORE INSERT ON "export_jobs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_jobs.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_jobs_update BEFORE UPDATE ON "export_jobs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_jobs.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_jobs_delete BEFORE DELETE ON "export_jobs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_jobs.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_operation_audit_insert BEFORE INSERT ON "export_operation_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_operation_audit.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_operation_audit_update BEFORE UPDATE ON "export_operation_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_operation_audit.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_operation_audit_delete BEFORE DELETE ON "export_operation_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_operation_audit.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_packages_insert BEFORE INSERT ON "export_packages"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_packages.insert') s WHERE s.value=json_array(NEW."job_id",NEW."number")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_packages_update BEFORE UPDATE ON "export_packages"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_packages.update') s WHERE s.value=json_array(OLD."job_id",OLD."number")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_packages_delete BEFORE DELETE ON "export_packages"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_packages.delete') s WHERE s.value=json_array(OLD."job_id",OLD."number")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_scope_locks_insert BEFORE INSERT ON "export_scope_locks"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_scope_locks.insert') s WHERE s.value=json_array(NEW."scope_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_scope_locks_update BEFORE UPDATE ON "export_scope_locks"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_scope_locks.update') s WHERE s.value=json_array(OLD."scope_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_export_scope_locks_delete BEFORE DELETE ON "export_scope_locks"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.export_scope_locks.delete') s WHERE s.value=json_array(OLD."scope_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_leaderboard_results_insert BEFORE INSERT ON "leaderboard_results"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.leaderboard_results.insert') s WHERE s.value=json_array(NEW."run_id",NEW."rank")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_leaderboard_results_update BEFORE UPDATE ON "leaderboard_results"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.leaderboard_results.update') s WHERE s.value=json_array(OLD."run_id",OLD."rank")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_leaderboard_results_delete BEFORE DELETE ON "leaderboard_results"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.leaderboard_results.delete') s WHERE s.value=json_array(OLD."run_id",OLD."rank")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_leaderboard_runs_insert BEFORE INSERT ON "leaderboard_runs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.leaderboard_runs.insert') s WHERE s.value=json_array(NEW."run_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_leaderboard_runs_update BEFORE UPDATE ON "leaderboard_runs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.leaderboard_runs.update') s WHERE s.value=json_array(OLD."run_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_leaderboard_runs_delete BEFORE DELETE ON "leaderboard_runs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.leaderboard_runs.delete') s WHERE s.value=json_array(OLD."run_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_leaderboards_insert BEFORE INSERT ON "leaderboards"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.leaderboards.insert') s WHERE s.value=json_array(NEW."leaderboard_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_leaderboards_update BEFORE UPDATE ON "leaderboards"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.leaderboards.update') s WHERE s.value=json_array(OLD."leaderboard_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_leaderboards_delete BEFORE DELETE ON "leaderboards"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.leaderboards.delete') s WHERE s.value=json_array(OLD."leaderboard_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_member_credentials_insert BEFORE INSERT ON "member_credentials"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.member_credentials.insert') s WHERE s.value=json_array(NEW."member_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_member_credentials_update BEFORE UPDATE ON "member_credentials"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.member_credentials.update') s WHERE s.value=json_array(OLD."member_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_member_credentials_delete BEFORE DELETE ON "member_credentials"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.member_credentials.delete') s WHERE s.value=json_array(OLD."member_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_member_status_events_insert BEFORE INSERT ON "member_status_events"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.member_status_events.insert') s WHERE s.value=json_array(NEW."sequence")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_member_status_events_update BEFORE UPDATE ON "member_status_events"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.member_status_events.update') s WHERE s.value=json_array(OLD."sequence")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_member_status_events_delete BEFORE DELETE ON "member_status_events"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.member_status_events.delete') s WHERE s.value=json_array(OLD."sequence")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_member_tiers_insert BEFORE INSERT ON "member_tiers"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.member_tiers.insert') s WHERE s.value=json_array(NEW."tier_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_member_tiers_update BEFORE UPDATE ON "member_tiers"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.member_tiers.update') s WHERE s.value=json_array(OLD."tier_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_member_tiers_delete BEFORE DELETE ON "member_tiers"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.member_tiers.delete') s WHERE s.value=json_array(OLD."tier_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_members_insert BEFORE INSERT ON "members"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.members.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_members_update BEFORE UPDATE ON "members"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.members.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_members_delete BEFORE DELETE ON "members"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.members.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_point_transactions_insert BEFORE INSERT ON "point_transactions"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.point_transactions.insert') s WHERE s.value=json_array(NEW."transaction_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_point_transactions_update BEFORE UPDATE ON "point_transactions"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.point_transactions.update') s WHERE s.value=json_array(OLD."transaction_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_point_transactions_delete BEFORE DELETE ON "point_transactions"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.point_transactions.delete') s WHERE s.value=json_array(OLD."transaction_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_backups_insert BEFORE INSERT ON "proof_backups"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_backups.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_backups_update BEFORE UPDATE ON "proof_backups"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_backups.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_backups_delete BEFORE DELETE ON "proof_backups"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_backups.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_duplicate_groups_insert BEFORE INSERT ON "proof_duplicate_groups"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_duplicate_groups.insert') s WHERE s.value=json_array(NEW."member_id",NEW."campaign_id",NEW."sha256")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_duplicate_groups_update BEFORE UPDATE ON "proof_duplicate_groups"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_duplicate_groups.update') s WHERE s.value=json_array(OLD."member_id",OLD."campaign_id",OLD."sha256")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_duplicate_groups_delete BEFORE DELETE ON "proof_duplicate_groups"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_duplicate_groups.delete') s WHERE s.value=json_array(OLD."member_id",OLD."campaign_id",OLD."sha256")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_duplicate_jobs_insert BEFORE INSERT ON "proof_duplicate_jobs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_duplicate_jobs.insert') s WHERE s.value=json_array(NEW."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_duplicate_jobs_update BEFORE UPDATE ON "proof_duplicate_jobs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_duplicate_jobs.update') s WHERE s.value=json_array(OLD."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_duplicate_jobs_delete BEFORE DELETE ON "proof_duplicate_jobs"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_duplicate_jobs.delete') s WHERE s.value=json_array(OLD."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_duplicate_requests_insert BEFORE INSERT ON "proof_duplicate_requests"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_duplicate_requests.insert') s WHERE s.value=json_array(NEW."request_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_duplicate_requests_update BEFORE UPDATE ON "proof_duplicate_requests"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_duplicate_requests.update') s WHERE s.value=json_array(OLD."request_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_duplicate_requests_delete BEFORE DELETE ON "proof_duplicate_requests"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_duplicate_requests.delete') s WHERE s.value=json_array(OLD."request_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_exact_hashes_insert BEFORE INSERT ON "proof_exact_hashes"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_exact_hashes.insert') s WHERE s.value=json_array(NEW."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_exact_hashes_update BEFORE UPDATE ON "proof_exact_hashes"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_exact_hashes.update') s WHERE s.value=json_array(OLD."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_exact_hashes_delete BEFORE DELETE ON "proof_exact_hashes"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_exact_hashes.delete') s WHERE s.value=json_array(OLD."file_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_upload_checksums_insert BEFORE INSERT ON "proof_upload_checksums"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_upload_checksums.insert') s WHERE s.value=json_array(NEW."object_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_upload_checksums_update BEFORE UPDATE ON "proof_upload_checksums"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_upload_checksums.update') s WHERE s.value=json_array(OLD."object_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_upload_checksums_delete BEFORE DELETE ON "proof_upload_checksums"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_upload_checksums.delete') s WHERE s.value=json_array(OLD."object_key")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_upload_intents_insert BEFORE INSERT ON "proof_upload_intents"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_upload_intents.insert') s WHERE s.value=json_array(NEW."session_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_upload_intents_update BEFORE UPDATE ON "proof_upload_intents"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_upload_intents.update') s WHERE s.value=json_array(OLD."session_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_proof_upload_intents_delete BEFORE DELETE ON "proof_upload_intents"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.proof_upload_intents.delete') s WHERE s.value=json_array(OLD."session_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_recovery_codes_insert BEFORE INSERT ON "recovery_codes"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.recovery_codes.insert') s WHERE s.value=json_array(NEW."member_id",NEW."generation",NEW."code_hash")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_recovery_codes_update BEFORE UPDATE ON "recovery_codes"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.recovery_codes.update') s WHERE s.value=json_array(OLD."member_id",OLD."generation",OLD."code_hash")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_recovery_codes_delete BEFORE DELETE ON "recovery_codes"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.recovery_codes.delete') s WHERE s.value=json_array(OLD."member_id",OLD."generation",OLD."code_hash")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_site_announcements_insert BEFORE INSERT ON "site_announcements"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.site_announcements.insert') s WHERE s.value=json_array(NEW."announcement_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_site_announcements_update BEFORE UPDATE ON "site_announcements"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.site_announcements.update') s WHERE s.value=json_array(OLD."announcement_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_site_announcements_delete BEFORE DELETE ON "site_announcements"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.site_announcements.delete') s WHERE s.value=json_array(OLD."announcement_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_solo_targets_insert BEFORE INSERT ON "solo_targets"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.solo_targets.insert') s WHERE s.value=json_array(NEW."target_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_solo_targets_update BEFORE UPDATE ON "solo_targets"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.solo_targets.update') s WHERE s.value=json_array(OLD."target_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_solo_targets_delete BEFORE DELETE ON "solo_targets"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.solo_targets.delete') s WHERE s.value=json_array(OLD."target_id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_alert_deliveries_insert BEFORE INSERT ON "storage_alert_deliveries"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_alert_deliveries.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_alert_deliveries_update BEFORE UPDATE ON "storage_alert_deliveries"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_alert_deliveries.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_alert_deliveries_delete BEFORE DELETE ON "storage_alert_deliveries"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_alert_deliveries.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_alerts_insert BEFORE INSERT ON "storage_alerts"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_alerts.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_alerts_update BEFORE UPDATE ON "storage_alerts"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_alerts.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_alerts_delete BEFORE DELETE ON "storage_alerts"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_alerts.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_audit_insert BEFORE INSERT ON "storage_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_audit.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_audit_update BEFORE UPDATE ON "storage_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_audit.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_audit_delete BEFORE DELETE ON "storage_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_audit.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_capacity_insert BEFORE INSERT ON "storage_capacity"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_capacity.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_capacity_update BEFORE UPDATE ON "storage_capacity"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_capacity.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_capacity_delete BEFORE DELETE ON "storage_capacity"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_capacity.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_history_insert BEFORE INSERT ON "storage_history"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_history.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_history_update BEFORE UPDATE ON "storage_history"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_history.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_history_delete BEFORE DELETE ON "storage_history"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_history.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_reservations_insert BEFORE INSERT ON "storage_reservations"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_reservations.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_reservations_update BEFORE UPDATE ON "storage_reservations"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_reservations.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_storage_reservations_delete BEFORE DELETE ON "storage_reservations"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.storage_reservations.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_submission_settings_insert BEFORE INSERT ON "submission_settings"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.submission_settings.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_submission_settings_update BEFORE UPDATE ON "submission_settings"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.submission_settings.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_submission_settings_delete BEFORE DELETE ON "submission_settings"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.submission_settings.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_submission_settings_audit_insert BEFORE INSERT ON "submission_settings_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.submission_settings_audit.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_submission_settings_audit_update BEFORE UPDATE ON "submission_settings_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.submission_settings_audit.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_submission_settings_audit_delete BEFORE DELETE ON "submission_settings_audit"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.submission_settings_audit.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_trusted_devices_insert BEFORE INSERT ON "trusted_devices"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.trusted_devices.insert') s WHERE s.value=json_array(NEW."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_trusted_devices_update BEFORE UPDATE ON "trusted_devices"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.trusted_devices.update') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
CREATE TRIGGER prelaunch_fence_trusted_devices_delete BEFORE DELETE ON "trusted_devices"
WHEN NOT EXISTS(SELECT 1 FROM prelaunch_reset_permit p JOIN prelaunch_reset_control c ON c.id=1 AND c.epoch=p.epoch
 WHERE p.id=1 AND ((p.purpose='normal' AND c.mode='open' AND EXISTS(SELECT 1 FROM prelaunch_reset_operations o WHERE o.id=p.operation_id AND o.epoch=c.epoch AND o.state='active'))
 OR (p.purpose='reset' AND c.mode='maintenance' AND p.run_id=c.run_id AND EXISTS(SELECT 1 FROM json_each(p.scope_json,'$.trusted_devices.delete') s WHERE s.value=json_array(OLD."id")))))
BEGIN SELECT RAISE(ABORT,'PRELAUNCH_WRITE_FENCED');END;
