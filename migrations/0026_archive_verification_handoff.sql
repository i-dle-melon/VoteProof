-- Durable A-to-B verification binding; no activation or data deletion.
ALTER TABLE cold_proofs ADD COLUMN verification_context TEXT;
