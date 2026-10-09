-- Unpublished B4S: Supabase password identity + mandatory VoteProof TOTP.
-- Existing local checkpoint databases must be recreated; Production has only 0001/0002.
CREATE TABLE members (
 id TEXT PRIMARY KEY NOT NULL,
 member_id TEXT NOT NULL UNIQUE,
 login_name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (login_name = lower(trim(login_name)) AND length(login_name) BETWEEN 4 AND 32 AND login_name NOT GLOB '*[^a-z0-9._-]*'),
 nickname TEXT NOT NULL DEFAULT '會員' CHECK (length(nickname) BETWEEN 1 AND 50),
 player_id TEXT CHECK (player_id IS NULL OR length(player_id) BETWEEN 1 AND 100),
 status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT NOT NULL
);
CREATE TABLE member_credentials (
 member_id TEXT PRIMARY KEY NOT NULL REFERENCES members(member_id),
 totp_ciphertext TEXT NOT NULL CHECK(length(totp_ciphertext) BETWEEN 64 AND 1024 AND length(totp_ciphertext)%2=0 AND totp_ciphertext NOT GLOB '*[^a-f0-9]*'),
 totp_iv TEXT NOT NULL CHECK(length(totp_iv)=24 AND totp_iv NOT GLOB '*[^a-f0-9]*'),
 totp_key_version INTEGER NOT NULL CHECK(totp_key_version > 0),
 last_used_time_step INTEGER NOT NULL CHECK(last_used_time_step >= 0),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
 recovery_generation INTEGER NOT NULL DEFAULT 1 CHECK(recovery_generation > 0),
 updated_at INTEGER NOT NULL
);
CREATE TABLE auth_transactions (
 id TEXT PRIMARY KEY NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('email_register','register','login','password_change','password_recovery','totp_recovery','totp_reset')),
 member_id TEXT REFERENCES members(member_id),
 browser_hash TEXT NOT NULL CHECK(length(browser_hash)=64),
 payload TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), consumed_at INTEGER
);
CREATE TABLE auth_sessions (
 token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
 member_id TEXT NOT NULL REFERENCES members(member_id),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
 elevated_until INTEGER NOT NULL DEFAULT 0,
 reauthenticated_until INTEGER NOT NULL DEFAULT 0,
 revoked_at INTEGER
);
CREATE TABLE trusted_devices (
 id TEXT PRIMARY KEY NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(member_id),
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
 created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at > created_at), revoked_at INTEGER,
 label TEXT CHECK(label IS NULL OR length(label) <= 80)
);
CREATE TABLE recovery_codes (
 member_id TEXT NOT NULL REFERENCES members(member_id), generation INTEGER NOT NULL CHECK(generation>0),
 code_hash TEXT NOT NULL CHECK(length(code_hash)=64), created_at INTEGER NOT NULL, used_at INTEGER,
 PRIMARY KEY(member_id,generation,code_hash)
);
CREATE TABLE auth_rate_limits (
 scope_hash TEXT NOT NULL CHECK(length(scope_hash)=64), window_start INTEGER NOT NULL,
 count INTEGER NOT NULL CHECK(count>0), expires_at INTEGER NOT NULL,
 PRIMARY KEY(scope_hash,window_start)
);
-- Batch-local assertion: CHECK failure rolls back the ENTIRE D1 batch.
-- A guard row is inserted then deleted inside the same transaction; never persists.
CREATE TABLE auth_atomic_guards (id TEXT PRIMARY KEY NOT NULL, valid INTEGER NOT NULL CHECK(valid=1));
-- login_name above is an opaque legacy internal label, never the login email.
CREATE TABLE auth_identities (
 provider TEXT NOT NULL CHECK(provider='supabase'),
 provider_subject TEXT PRIMARY KEY NOT NULL CHECK(length(provider_subject)=36),
 member_id TEXT NOT NULL UNIQUE REFERENCES members(member_id),
 email_lookup_hash TEXT NOT NULL UNIQUE CHECK(length(email_lookup_hash)=64),
 email_ciphertext TEXT NOT NULL, email_iv TEXT NOT NULL CHECK(length(email_iv)=24),
 email_key_version INTEGER NOT NULL CHECK(email_key_version>0), created_at INTEGER NOT NULL
);
CREATE TABLE auth_email_challenges (
 id TEXT PRIMARY KEY NOT NULL, email_lookup_hash TEXT NOT NULL CHECK(length(email_lookup_hash)=64),
 browser_hash TEXT NOT NULL CHECK(length(browser_hash)=64), code_hash TEXT NOT NULL CHECK(length(code_hash)=64),
 email_ciphertext TEXT NOT NULL, email_iv TEXT NOT NULL CHECK(length(email_iv)=24),
 email_key_version INTEGER NOT NULL CHECK(email_key_version>0),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','verified','transferred'))
);
CREATE TABLE auth_email_sends (
 id TEXT PRIMARY KEY NOT NULL, challenge_id TEXT NOT NULL,
 email_lookup_hash TEXT NOT NULL CHECK(length(email_lookup_hash)=64),
 source_hash TEXT NOT NULL CHECK(length(source_hash)=64), created_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN('reserved','sent','failed'))
);
CREATE TABLE auth_enrollments (
 id TEXT PRIMARY KEY NOT NULL, email_lookup_hash TEXT NOT NULL CHECK(length(email_lookup_hash)=64),
 member_id TEXT NOT NULL UNIQUE, provider_subject TEXT UNIQUE,
 verified_transaction_id TEXT NOT NULL UNIQUE, totp_transaction_id TEXT UNIQUE,
 state TEXT NOT NULL CHECK(state IN('creating','pending','active','cleanup_failed','deleted')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at)
);
CREATE UNIQUE INDEX idx_enrollment_email ON auth_enrollments(email_lookup_hash) WHERE state!='deleted';
CREATE TABLE auth_password_operations (
 id TEXT PRIMARY KEY NOT NULL, member_id TEXT NOT NULL REFERENCES members(member_id),
 transaction_id TEXT UNIQUE, credential_version INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('change','recovery')),
 status TEXT NOT NULL CHECK(status IN('pending','complete','superseded')),
 lease_until INTEGER NOT NULL, lease_owner TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE UNIQUE INDEX idx_password_operation_pending ON auth_password_operations(member_id) WHERE status='pending';
CREATE INDEX idx_email_send_global ON auth_email_sends(created_at);
CREATE INDEX idx_email_send_identity ON auth_email_sends(email_lookup_hash,created_at);
CREATE INDEX idx_email_send_source ON auth_email_sends(source_hash,created_at);
CREATE INDEX idx_email_challenge_expiry ON auth_email_challenges(expires_at);
CREATE INDEX idx_enrollment_expiry ON auth_enrollments(state,expires_at);
CREATE INDEX idx_auth_transactions_expiration ON auth_transactions(expires_at);
CREATE INDEX idx_auth_transactions_member ON auth_transactions(member_id,kind);
CREATE INDEX idx_auth_sessions_member ON auth_sessions(member_id);
CREATE INDEX idx_auth_sessions_expiration ON auth_sessions(expires_at);
CREATE INDEX idx_trusted_devices_member ON trusted_devices(member_id,expires_at);
CREATE INDEX idx_recovery_codes_member ON recovery_codes(member_id,generation,used_at);
CREATE INDEX idx_auth_rate_expiration ON auth_rate_limits(expires_at);
CREATE INDEX idx_cases_member_cursor ON cases(member_id,created_at DESC,id DESC);
