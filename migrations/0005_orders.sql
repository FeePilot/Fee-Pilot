-- Offline order notes synced from clients. The idempotency key makes a re-sync a no-op:
-- the first payload stored under a key wins, and a different payload for the same key is
-- reported as a conflict, never overwritten. A note is not proof of payment.
CREATE TABLE orders (
    idempotency_key   UUID PRIMARY KEY,
    client_id         UUID   NOT NULL,
    network           TEXT   NOT NULL,
    amount_sat        BIGINT NOT NULL CHECK (amount_sat > 0),
    memo              TEXT   NOT NULL DEFAULT '' CHECK (length(memo) <= 140),
    txid              TEXT   CHECK (txid IS NULL OR length(txid) = 64),
    client_created_at BIGINT NOT NULL,        -- unix seconds, as the client claimed
    schema_version    INT    NOT NULL,
    state             TEXT   NOT NULL DEFAULT 'awaiting_verification' CHECK (state IN (
        'awaiting_verification', 'seen', 'replaced', 'not_seen')),
    observation       JSONB,                  -- last verification result, NULL if never verified
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_txid_idx ON orders (txid) WHERE txid IS NOT NULL;
