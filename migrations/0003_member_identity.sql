-- Email-only identity. No passwords, admin roles or plaintext bearer tokens.
CREATE TABLE members (
  id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (email = lower(trim(email)) AND length(email) <= 254),
  nickname TEXT NOT NULL DEFAULT '會員' CHECK (length(nickname) BETWEEN 1 AND 50),
  player_id TEXT CHECK (player_id IS NULL OR length(player_id) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL CHECK (email = lower(trim(email))),
  browser_hash TEXT NOT NULL CHECK (length(browser_hash) = 64),
  otp_hash TEXT NOT NULL CHECK (length(otp_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
  consumed_at INTEGER
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  member_id TEXT NOT NULL REFERENCES members(member_id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER
);

CREATE TABLE auth_rate_limits (
  scope_hash TEXT NOT NULL CHECK (length(scope_hash) = 64),
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope_hash, window_start)
);

CREATE INDEX idx_auth_challenges_expiration ON auth_challenges(expires_at);
CREATE INDEX idx_auth_challenges_email ON auth_challenges(email, created_at);
CREATE INDEX idx_auth_sessions_member ON auth_sessions(member_id);
CREATE INDEX idx_auth_sessions_expiration ON auth_sessions(expires_at);
CREATE INDEX idx_auth_rate_expiration ON auth_rate_limits(expires_at);
CREATE INDEX idx_cases_member_cursor ON cases(member_id, created_at DESC, id DESC);
