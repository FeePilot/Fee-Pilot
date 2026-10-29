-- Tracking: what to watch for each job, and a richer state machine.
-- watched_inputs are the outpoints spent by the original transaction; the tracker asks the
-- node who spends them to tell "replaced" apart from "evicted".
ALTER TABLE jobs ADD COLUMN watched_inputs JSONB NOT NULL DEFAULT '[]';

ALTER TABLE jobs DROP CONSTRAINT jobs_state_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_state_check CHECK (state IN (
    'analyzed', 'awaiting_signature', 'broadcasting', 'broadcast',
    'confirmed',  -- the recovery succeeded and has at least one confirmation
    'settled',    -- confirmed deeply enough that a reorg is no longer a practical concern
    'obsolete'    -- the original confirmed or was replaced before the user signed
));

-- history rows may carry a detail, e.g. the txid of the replacement.
ALTER TABLE tx_status_history ADD COLUMN detail TEXT;
CREATE INDEX tx_status_history_job_idx ON tx_status_history (job_id, id);
