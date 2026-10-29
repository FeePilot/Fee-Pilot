-- A recovery job holds the unsigned PSBT FeePilot issued, so the signed one can be
-- checked against it when it comes back. No keys or signatures are stored.
ALTER TABLE jobs
    ADD COLUMN unsigned_psbt TEXT,
    ADD COLUMN extra_fee_sat BIGINT,
    ADD COLUMN recovery_txid TEXT;

ALTER TABLE jobs ALTER COLUMN state SET DEFAULT 'awaiting_signature';
ALTER TABLE jobs ADD CONSTRAINT jobs_state_check
    CHECK (state IN ('analyzed', 'awaiting_signature', 'broadcasting', 'broadcast'));
