//! Retention: old data is deleted so the service holds as little as it needs.

use crate::{PgStore, StoreError};

/// What one purge removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PurgeReport {
    pub fee_rows: u64,
    pub orders: u64,
    pub jobs: u64,
}

impl PgStore {
    /// Delete data older than `days` days. `days == 0` keeps everything.
    ///
    /// - Fee history: all rows, except the newest good snapshot per network, which is kept so the
    ///   offline copy never disappears.
    /// - Orders: notes older than the cutoff.
    /// - Jobs: only finished ones (`settled`, `obsolete`); their history goes with them. Jobs
    ///   still being watched or awaiting a signature are never purged.
    pub async fn purge_older_than(&self, days: u32) -> Result<PurgeReport, StoreError> {
        if days == 0 {
            return Ok(PurgeReport::default());
        }
        let days = i32::try_from(days).unwrap_or(i32::MAX);
        let fee_rows = sqlx::query(
            "DELETE FROM fee_snapshots f
             WHERE f.fetched_at < extract(epoch from now())::bigint - $1::bigint * 86400
               AND NOT (f.snapshot IS NOT NULL AND f.id = (
                    SELECT max(g.id) FROM fee_snapshots g
                    WHERE g.network = f.network AND g.snapshot IS NOT NULL))",
        )
        .bind(days)
        .execute(&self.pool)
        .await?
        .rows_affected();
        let orders =
            sqlx::query("DELETE FROM orders WHERE created_at < now() - make_interval(days => $1)")
                .bind(days)
                .execute(&self.pool)
                .await?
                .rows_affected();
        let jobs = sqlx::query(
            "DELETE FROM jobs
             WHERE state IN ('settled', 'obsolete')
               AND updated_at < now() - make_interval(days => $1)",
        )
        .bind(days)
        .execute(&self.pool)
        .await?
        .rows_affected();
        Ok(PurgeReport {
            fee_rows,
            orders,
            jobs,
        })
    }
}
