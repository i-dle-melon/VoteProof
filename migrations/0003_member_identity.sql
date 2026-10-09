-- Unpublished 0003 replaced with final password + mandatory TOTP identity.
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
 password_record TEXT NOT NULL CHECK(json_valid(password_record)),
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
 kind TEXT NOT NULL CHECK(kind IN ('register','login','password_recovery','totp_recovery','totp_reset')),
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
CREATE INDEX idx_auth_transactions_expiration ON auth_transactions(expires_at);
CREATE INDEX idx_auth_transactions_member ON auth_transactions(member_id,kind);
CREATE INDEX idx_auth_sessions_member ON auth_sessions(member_id);
CREATE INDEX idx_auth_sessions_expiration ON auth_sessions(expires_at);
CREATE INDEX idx_trusted_devices_member ON trusted_devices(member_id,expires_at);
CREATE INDEX idx_recovery_codes_member ON recovery_codes(member_id,generation,used_at);
CREATE INDEX idx_auth_rate_expiration ON auth_rate_limits(expires_at);
CREATE INDEX idx_cases_member_cursor ON cases(member_id,created_at DESC,id DESC);
