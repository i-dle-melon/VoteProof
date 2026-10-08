-- Persist retries in the same transaction as the case and upload consumption.
-- Neither the original client key nor a plaintext query credential is stored.
CREATE TABLE case_idempotency (
  key_hash TEXT PRIMARY KEY NOT NULL
    CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  case_id TEXT NOT NULL UNIQUE REFERENCES cases(id),
  query_seed TEXT NOT NULL
    CHECK (length(query_seed) = 64 AND query_seed NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);

ALTER TABLE completed_uploads ADD COLUMN expires_at TEXT NOT NULL
  DEFAULT '1970-01-01T00:00:00.000Z' CHECK (length(expires_at) = 24);
UPDATE completed_uploads SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at, '+24 hours');
CREATE INDEX idx_completed_uploads_expiration ON completed_uploads(expires_at)
  WHERE consumed_case_id IS NULL;
