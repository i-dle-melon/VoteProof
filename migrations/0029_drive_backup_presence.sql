-- Drive presence is separate from the original backup confirmation and queue.
CREATE TABLE drive_backup_presence (
  backup_id TEXT PRIMARY KEY NOT NULL REFERENCES proof_backups(id) ON DELETE CASCADE,
  drive_file_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available','trashed','unavailable')),
  observed_at INTEGER NOT NULL CHECK (observed_at > 0)
);
