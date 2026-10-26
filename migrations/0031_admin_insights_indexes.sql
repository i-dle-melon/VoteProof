-- Read-only admin monitoring/member pages: additive indexing only.
-- Does not change member identity, points, submissions, cleanup mode or image data.
CREATE INDEX IF NOT EXISTS idx_admin_members_status_id ON members(status,member_id);
CREATE INDEX IF NOT EXISTS idx_admin_members_nickname_id ON members(nickname,member_id);
CREATE INDEX IF NOT EXISTS idx_admin_storage_alerts_time ON storage_alerts(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_operations_time ON image_mutation_operations(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_reservations_state ON storage_reservations(state);
CREATE INDEX IF NOT EXISTS idx_admin_backup_status ON proof_backups(provider,status,created_at DESC,id DESC);
