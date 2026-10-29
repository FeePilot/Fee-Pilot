-- Recovery jobs: one per submitted txid + preferences.
CREATE TABLE jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    txid          TEXT        NOT NULL CHECK (length(txid) = 64),
    network       TEXT        NOT NULL,
    urgency       TEXT        NOT NULL DEFAULT 'normal',
    max_budget_sat BIGINT,
    chosen_route  TEXT,                       -- rbf | cpfp | external_accelerator | wait
    state         TEXT        NOT NULL DEFAULT 'analyzed',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_txid_idx ON jobs (txid);

-- Append-only status history (pending -> replaced | confirmed, reorgs included).
CREATE TABLE tx_status_history (
    id            BIGSERIAL PRIMARY KEY,
    job_id        UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    txid          TEXT        NOT NULL,
    status        TEXT        NOT NULL,       -- pending | replaced | confirmed | not_found
    confirmations INTEGER     NOT NULL DEFAULT 0,
    observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw provider quotes/responses, kept verbatim with their conditions and failure reasons.
CREATE TABLE provider_responses (
    id            BIGSERIAL PRIMARY KEY,
    job_id        UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    provider      TEXT        NOT NULL,
    kind          TEXT        NOT NULL,       -- quote | submission
    payload       JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No private keys, seeds or signed secrets are ever stored.
