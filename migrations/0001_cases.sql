-- Local first. Create/bind the real Production database before applying remotely.
CREATE TABLE completed_uploads (
  session_id TEXT PRIMARY KEY NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  completed_at TEXT NOT NULL,
  consumed_case_id TEXT UNIQUE REFERENCES cases(id),
  consumed_at TEXT
);

CREATE TABLE cases (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  member_id TEXT,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 50),
  player_id TEXT NOT NULL CHECK (length(player_id) BETWEEN 1 AND 100),
  campaign_id TEXT NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 100),
  vote_type TEXT NOT NULL CHECK (vote_type IN ('Solo', '團體')),
  vote_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'completed', 'rejected', 'duplicate', 'revoked')),
  query_key_hash TEXT NOT NULL CHECK (length(query_key_hash) = 64),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  source TEXT NOT NULL DEFAULT 'guest',
  duplicate_flag INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_flag IN (0, 1)),
  reviewed_at TEXT,
  reviewer_id TEXT,
  points_awarded INTEGER NOT NULL DEFAULT 0 CHECK (points_awarded >= 0),
  point_status TEXT,
  upload_session_id TEXT NOT NULL UNIQUE REFERENCES completed_uploads(session_id)
);

CREATE TABLE completed_upload_files (
  session_id TEXT NOT NULL REFERENCES completed_uploads(session_id),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 5242880),
  etag TEXT NOT NULL,
  PRIMARY KEY (session_id, object_key)
);

CREATE TABLE case_files (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES cases(id),
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 5242880),
  etag TEXT,
  created_at TEXT NOT NULL,
  upload_object_key TEXT NOT NULL UNIQUE REFERENCES completed_upload_files(object_key)
);

CREATE INDEX idx_cases_guest_lookup ON cases(case_id, query_key_hash);
CREATE INDEX idx_cases_created_at ON cases(created_at);
CREATE INDEX idx_cases_status ON cases(status);
CREATE INDEX idx_cases_campaign_id ON cases(campaign_id);
CREATE INDEX idx_case_files_case_id ON case_files(case_id);
