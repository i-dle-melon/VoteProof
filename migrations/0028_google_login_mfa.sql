-- Additive: existing sessions/transactions are untouched until a member opts in.
CREATE TABLE google_login_mfa (
 member_id TEXT PRIMARY KEY NOT NULL REFERENCES members(member_id),
 enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 generation INTEGER NOT NULL CHECK(generation>0),
 updated_at INTEGER NOT NULL
);
ALTER TABLE auth_google_flows ADD COLUMN mfa_policy_action TEXT CHECK(mfa_policy_action IN('enable','disable'));
ALTER TABLE auth_sessions ADD COLUMN google_mfa_generation INTEGER NOT NULL DEFAULT 0 CHECK(google_mfa_generation>=0);
ALTER TABLE auth_sessions ADD COLUMN google_mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK(google_mfa_verified IN(0,1));
CREATE TRIGGER google_mfa_no_delete BEFORE DELETE ON google_login_mfa BEGIN SELECT RAISE(ABORT,'Google MFA policy cannot be deleted'); END;
CREATE TRIGGER google_mfa_no_replace BEFORE INSERT ON google_login_mfa WHEN EXISTS(SELECT 1 FROM google_login_mfa WHERE member_id=NEW.member_id)
 BEGIN SELECT RAISE(ABORT,'Google MFA policy cannot be replaced'); END;
CREATE TRIGGER google_mfa_generation BEFORE UPDATE ON google_login_mfa
 WHEN NEW.member_id!=OLD.member_id OR NEW.generation!=OLD.generation+1
 BEGIN SELECT RAISE(ABORT,'Google MFA generation must advance'); END;
CREATE TRIGGER google_mfa_require_totp_insert BEFORE INSERT ON google_login_mfa
 WHEN NEW.enabled=1 AND NOT EXISTS(SELECT 1 FROM member_credentials WHERE member_id=NEW.member_id)
 BEGIN SELECT RAISE(ABORT,'Google MFA requires Authenticator'); END;
CREATE TRIGGER google_mfa_require_totp_update BEFORE UPDATE ON google_login_mfa
 WHEN NEW.enabled=1 AND NOT EXISTS(SELECT 1 FROM member_credentials WHERE member_id=NEW.member_id)
 BEGIN SELECT RAISE(ABORT,'Google MFA requires Authenticator'); END;
CREATE TRIGGER google_mfa_revoke_insert AFTER INSERT ON google_login_mfa BEGIN
 UPDATE auth_sessions SET revoked_at=CAST(strftime('%s','now') AS INTEGER) WHERE member_id=NEW.member_id AND auth_method='google' AND revoked_at IS NULL;
END;
CREATE TRIGGER google_mfa_revoke_update AFTER UPDATE ON google_login_mfa BEGIN
 UPDATE auth_sessions SET revoked_at=CAST(strftime('%s','now') AS INTEGER) WHERE member_id=NEW.member_id AND auth_method='google' AND revoked_at IS NULL;
END;
-- Downgrade protection: old Workers omit these receipt columns and cannot
-- create Google sessions for opted-in members. No per-request policy read.
CREATE TRIGGER google_mfa_session_gate BEFORE INSERT ON auth_sessions
 WHEN NEW.auth_method='google' AND EXISTS(SELECT 1 FROM google_login_mfa WHERE member_id=NEW.member_id AND enabled=1
 AND (NEW.google_mfa_verified!=1 OR NEW.google_mfa_generation!=generation))
 BEGIN SELECT RAISE(ABORT,'GOOGLE_LOGIN_MFA_REQUIRED'); END;
CREATE TABLE google_login_mfa_events (
 id TEXT PRIMARY KEY NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(member_id),
 flow_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN('enable','disable','enroll','login_totp','login_recovery')),
 generation INTEGER NOT NULL CHECK(generation>=0),
 created_at INTEGER NOT NULL
);
CREATE INDEX idx_google_mfa_events_member ON google_login_mfa_events(member_id,created_at);
CREATE TRIGGER google_mfa_events_no_update BEFORE UPDATE ON google_login_mfa_events BEGIN SELECT RAISE(ABORT,'Google MFA audit is immutable'); END;
CREATE TRIGGER google_mfa_events_no_delete BEFORE DELETE ON google_login_mfa_events BEGIN SELECT RAISE(ABORT,'Google MFA audit is immutable'); END;
CREATE TRIGGER google_mfa_events_no_replace BEFORE INSERT ON google_login_mfa_events WHEN EXISTS(SELECT 1 FROM google_login_mfa_events WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'Google MFA audit is immutable'); END;
