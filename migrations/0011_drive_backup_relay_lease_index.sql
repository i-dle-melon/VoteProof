-- Durable request/receipt lookup for Apps Script claim replay. Existing values stay unchanged.
-- Legacy Worker leases are random UUIDs; NULL is excluded. No seed/backfill or activation.
CREATE UNIQUE INDEX idx_proof_backups_relay_lease_token
ON proof_backups(lease_token) WHERE lease_token IS NOT NULL;
