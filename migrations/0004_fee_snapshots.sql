-- Fee cache: one row per refresh attempt. A failed refresh stores its error and no snapshot, so
-- the last good snapshot is never overwritten.
CREATE TABLE fee_snapshots (
    id         BIGSERIAL PRIMARY KEY,
    network    TEXT   NOT NULL,
    fetched_at BIGINT NOT NULL,          -- unix seconds
    snapshot   JSONB,                    -- the FeeSnapshot, NULL when the refresh failed
    error      TEXT,
    CHECK ((snapshot IS NULL) <> (error IS NULL))
);
CREATE INDEX fee_snapshots_network_idx ON fee_snapshots (network, id DESC);
