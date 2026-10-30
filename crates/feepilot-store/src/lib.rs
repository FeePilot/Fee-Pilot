//! Recovery jobs: the unsigned PSBT FeePilot issued, kept until the signed one returns,
//! and the status history the tracker records afterwards.

mod orders;
mod retention;
pub use orders::{NewOrder, OrderState, OrderStore, StoredOrder, Upsert};
pub use retention::PurgeReport;

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use feepilot_core::{FeeSnapshot, Network, Outpoint, RouteKind, TxStatus, Urgency};
use serde::Serialize;
use sqlx::types::Json;
use sqlx::{postgres::PgRow, PgPool, Row};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
#[error("job store error: {0}")]
pub struct StoreError(pub String);

impl From<sqlx::Error> for StoreError {
    fn from(e: sqlx::Error) -> Self {
        Self(e.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    AwaitingSignature,
    /// A submission is in flight; guards against double broadcasts.
    Broadcasting,
    Broadcast,
    /// The recovery has at least one confirmation. Can fall back to `Broadcast` on a reorg.
    Confirmed,
    /// Confirmed deeply enough to stop watching.
    Settled,
    /// The original confirmed or was replaced by someone else before the user signed.
    Obsolete,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingSignature => "awaiting_signature",
            Self::Broadcasting => "broadcasting",
            Self::Broadcast => "broadcast",
            Self::Confirmed => "confirmed",
            Self::Settled => "settled",
            Self::Obsolete => "obsolete",
        }
    }

    fn parse(s: &str) -> Result<Self, StoreError> {
        [
            Self::AwaitingSignature,
            Self::Broadcasting,
            Self::Broadcast,
            Self::Confirmed,
            Self::Settled,
            Self::Obsolete,
        ]
        .into_iter()
        .find(|st| st.as_str() == s)
        .ok_or_else(|| StoreError(format!("unexpected job state {s:?}")))
    }

    /// States the tracker keeps watching.
    pub const ACTIVE: [JobState; 3] = [Self::AwaitingSignature, Self::Broadcast, Self::Confirmed];
}

fn route_str(r: RouteKind) -> &'static str {
    match r {
        RouteKind::Rbf => "rbf",
        RouteKind::Cpfp => "cpfp",
        RouteKind::ExternalAccelerator => "external_accelerator",
        RouteKind::Wait => "wait",
    }
}

fn route_parse(s: &str) -> Result<RouteKind, StoreError> {
    match s {
        "rbf" => Ok(RouteKind::Rbf),
        "cpfp" => Ok(RouteKind::Cpfp),
        other => Err(StoreError(format!("unexpected route {other:?}"))),
    }
}

fn network_str(n: Network) -> &'static str {
    match n {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet",
        Network::Signet => "signet",
        Network::Regtest => "regtest",
    }
}

fn urgency_str(u: Urgency) -> &'static str {
    match u {
        Urgency::Low => "low",
        Urgency::Normal => "normal",
        Urgency::High => "high",
    }
}

fn status_str(s: TxStatus) -> &'static str {
    match s {
        TxStatus::Pending => "pending",
        TxStatus::Replaced => "replaced",
        TxStatus::Confirmed => "confirmed",
        TxStatus::NotFound => "not_found",
    }
}

#[derive(Debug, Clone)]
pub struct NewJob {
    pub txid: String,
    pub network: Network,
    pub route: RouteKind,
    pub urgency: Urgency,
    pub max_budget_sat: Option<u64>,
    pub unsigned_psbt: String,
    /// Extra network fee over the stuck transaction, in satoshis.
    pub extra_fee_sat: u64,
    /// Outpoints the stuck transaction spends; watched to detect replacement.
    pub inputs: Vec<Outpoint>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: Uuid,
    pub txid: String,
    pub route: RouteKind,
    pub state: JobState,
    pub unsigned_psbt: String,
    pub extra_fee_sat: u64,
    pub recovery_txid: Option<String>,
    /// The network this job lives on; never sent to clients.
    #[serde(skip)]
    pub network: Network,
    #[serde(skip)]
    pub inputs: Vec<Outpoint>,
}

/// One observation of a transaction's status, recorded when it changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HistoryEntry {
    pub txid: String,
    pub status: String,
    pub confirmations: u32,
    /// For `replaced`, the txid of the replacement when known.
    pub detail: Option<String>,
    pub observed_at: String,
}

pub trait JobStore: Send + Sync {
    fn create(&self, new: NewJob) -> impl Future<Output = Result<Job, StoreError>> + Send;
    fn get(&self, id: Uuid) -> impl Future<Output = Result<Option<Job>, StoreError>> + Send;
    /// Atomically move `awaiting_signature` -> `broadcasting`. False if it was not awaiting.
    fn claim_for_broadcast(
        &self,
        id: Uuid,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;
    fn finish_broadcast(
        &self,
        id: Uuid,
        recovery_txid: &str,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
    /// Return a failed `broadcasting` job to `awaiting_signature` so it can be retried.
    fn release(&self, id: Uuid) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// Jobs on `network` the tracker should look at: see [`JobState::ACTIVE`]. A tracker never
    /// sees another network's jobs, so it cannot ask the wrong node about them.
    fn list_active(
        &self,
        network: Network,
    ) -> impl Future<Output = Result<Vec<Job>, StoreError>> + Send;
    /// Compare-and-set a job's state. False if it was no longer in `from`, e.g. because the
    /// user submitted while the tracker was looking.
    fn transition(
        &self,
        id: Uuid,
        from: JobState,
        to: JobState,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;
    /// Append to the status history unless it equals the latest entry for this txid.
    /// Returns whether a row was added.
    fn record_observation(
        &self,
        id: Uuid,
        txid: &str,
        status: TxStatus,
        confirmations: u32,
        detail: Option<&str>,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;
    fn history(
        &self,
        id: Uuid,
    ) -> impl Future<Output = Result<Vec<HistoryEntry>, StoreError>> + Send;
}

/// A refresh that failed after the last good snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RefreshError {
    /// Unix seconds of the failed attempt.
    pub at: i64,
    pub message: String,
}

/// What the cache holds for one network.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FeeCache {
    /// The newest good snapshot, if any refresh ever succeeded.
    pub snapshot: Option<FeeSnapshot>,
    /// Set only when the latest refresh attempt failed (i.e. is newer than `snapshot`).
    pub last_error: Option<RefreshError>,
}

/// Persistence for fee snapshots. A failed refresh never replaces the last good snapshot.
pub trait FeeStore: Send + Sync {
    fn save_snapshot(
        &self,
        snapshot: &FeeSnapshot,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
    fn save_refresh_error(
        &self,
        network: Network,
        at: i64,
        message: &str,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
    fn fee_cache(
        &self,
        network: Network,
    ) -> impl Future<Output = Result<FeeCache, StoreError>> + Send;
}

/// PostgreSQL-backed store. Run `migrations/` first.
#[derive(Clone)]
pub struct PgStore {
    pool: PgPool,
}

const JOB_COLUMNS: &str =
    "id, txid, network, chosen_route, state, unsigned_psbt, extra_fee_sat, recovery_txid, watched_inputs";

fn job_from_row(row: &PgRow) -> Result<Job, StoreError> {
    Ok(Job {
        id: row.try_get("id")?,
        txid: row.try_get("txid")?,
        network: row
            .try_get::<&str, _>("network")?
            .parse()
            .map_err(StoreError)?,
        route: route_parse(row.try_get::<&str, _>("chosen_route")?)?,
        state: JobState::parse(row.try_get::<&str, _>("state")?)?,
        unsigned_psbt: row
            .try_get::<Option<String>, _>("unsigned_psbt")?
            .unwrap_or_default(),
        extra_fee_sat: row.try_get::<Option<i64>, _>("extra_fee_sat")?.unwrap_or(0) as u64,
        recovery_txid: row.try_get("recovery_txid")?,
        inputs: row.try_get::<Json<Vec<Outpoint>>, _>("watched_inputs")?.0,
    })
}

impl PgStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn migrate(&self) -> Result<(), sqlx::migrate::MigrateError> {
        sqlx::migrate!("../../migrations").run(&self.pool).await
    }
}

impl JobStore for PgStore {
    async fn create(&self, new: NewJob) -> Result<Job, StoreError> {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO jobs
                 (txid, network, urgency, max_budget_sat, chosen_route, state,
                  unsigned_psbt, extra_fee_sat, watched_inputs)
             VALUES ($1, $2, $3, $4, $5, 'awaiting_signature', $6, $7, $8)
             RETURNING id",
        )
        .bind(&new.txid)
        .bind(network_str(new.network))
        .bind(urgency_str(new.urgency))
        .bind(new.max_budget_sat.map(|v| v as i64))
        .bind(route_str(new.route))
        .bind(&new.unsigned_psbt)
        .bind(new.extra_fee_sat as i64)
        .bind(Json(&new.inputs))
        .fetch_one(&self.pool)
        .await?;
        Ok(Job {
            id,
            txid: new.txid,
            route: new.route,
            state: JobState::AwaitingSignature,
            unsigned_psbt: new.unsigned_psbt,
            extra_fee_sat: new.extra_fee_sat,
            recovery_txid: None,
            network: new.network,
            inputs: new.inputs,
        })
    }

    async fn get(&self, id: Uuid) -> Result<Option<Job>, StoreError> {
        sqlx::query(&format!("SELECT {JOB_COLUMNS} FROM jobs WHERE id = $1"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(job_from_row)
            .transpose()
    }

    async fn claim_for_broadcast(&self, id: Uuid) -> Result<bool, StoreError> {
        self.transition(id, JobState::AwaitingSignature, JobState::Broadcasting)
            .await
    }

    async fn finish_broadcast(&self, id: Uuid, recovery_txid: &str) -> Result<(), StoreError> {
        sqlx::query(
            "UPDATE jobs SET state = 'broadcast', recovery_txid = $2, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(recovery_txid)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn release(&self, id: Uuid) -> Result<(), StoreError> {
        self.transition(id, JobState::Broadcasting, JobState::AwaitingSignature)
            .await
            .map(drop)
    }

    async fn list_active(&self, network: Network) -> Result<Vec<Job>, StoreError> {
        let states: Vec<&str> = JobState::ACTIVE.iter().map(|s| s.as_str()).collect();
        sqlx::query(&format!(
            "SELECT {JOB_COLUMNS} FROM jobs WHERE state = ANY($1) AND network = $2 ORDER BY created_at"
        ))
        .bind(states)
        .bind(network_str(network))
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(job_from_row)
        .collect()
    }

    async fn transition(&self, id: Uuid, from: JobState, to: JobState) -> Result<bool, StoreError> {
        let done = sqlx::query(
            "UPDATE jobs SET state = $3, updated_at = now() WHERE id = $1 AND state = $2",
        )
        .bind(id)
        .bind(from.as_str())
        .bind(to.as_str())
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    async fn record_observation(
        &self,
        id: Uuid,
        txid: &str,
        status: TxStatus,
        confirmations: u32,
        detail: Option<&str>,
    ) -> Result<bool, StoreError> {
        let done = sqlx::query(
            "INSERT INTO tx_status_history (job_id, txid, status, confirmations, detail)
             SELECT $1::uuid, $2::text, $3::text, $4::int, $5::text
             WHERE NOT EXISTS (
                 SELECT 1 FROM (
                     SELECT status, confirmations, detail FROM tx_status_history
                     WHERE job_id = $1 AND txid = $2 ORDER BY id DESC LIMIT 1
                 ) latest
                 WHERE latest.status = $3 AND latest.confirmations = $4
                   AND latest.detail IS NOT DISTINCT FROM $5
             )",
        )
        .bind(id)
        .bind(txid)
        .bind(status_str(status))
        .bind(confirmations as i32)
        .bind(detail)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    async fn history(&self, id: Uuid) -> Result<Vec<HistoryEntry>, StoreError> {
        let rows = sqlx::query(
            "SELECT txid, status, confirmations, detail, observed_at::text AS observed_at
             FROM tx_status_history WHERE job_id = $1 ORDER BY id",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| {
                Ok(HistoryEntry {
                    txid: r.try_get("txid")?,
                    status: r.try_get("status")?,
                    confirmations: r.try_get::<i32, _>("confirmations")? as u32,
                    detail: r.try_get("detail")?,
                    observed_at: r.try_get("observed_at")?,
                })
            })
            .collect()
    }
}

impl FeeStore for PgStore {
    async fn save_snapshot(&self, snapshot: &FeeSnapshot) -> Result<(), StoreError> {
        let json = serde_json::to_value(snapshot).map_err(|e| StoreError(e.to_string()))?;
        sqlx::query(
            "INSERT INTO fee_snapshots (network, fetched_at, snapshot) VALUES ($1, $2, $3)",
        )
        .bind(network_str(snapshot.network))
        .bind(snapshot.fetched_at)
        .bind(Json(json))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn save_refresh_error(
        &self,
        network: Network,
        at: i64,
        message: &str,
    ) -> Result<(), StoreError> {
        sqlx::query("INSERT INTO fee_snapshots (network, fetched_at, error) VALUES ($1, $2, $3)")
            .bind(network_str(network))
            .bind(at)
            .bind(message)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn fee_cache(&self, network: Network) -> Result<FeeCache, StoreError> {
        let good = sqlx::query(
            "SELECT id, snapshot FROM fee_snapshots
             WHERE network = $1 AND snapshot IS NOT NULL ORDER BY id DESC LIMIT 1",
        )
        .bind(network_str(network))
        .fetch_optional(&self.pool)
        .await?;
        let (good_id, snapshot) = match good {
            Some(row) => {
                let Json(value): Json<serde_json::Value> = row.try_get("snapshot")?;
                let snap = serde_json::from_value(value).map_err(|e| StoreError(e.to_string()))?;
                (row.try_get::<i64, _>("id")?, Some(snap))
            }
            None => (0, None),
        };
        let failed = sqlx::query(
            "SELECT fetched_at, error FROM fee_snapshots
             WHERE network = $1 AND error IS NOT NULL AND id > $2 ORDER BY id DESC LIMIT 1",
        )
        .bind(network_str(network))
        .bind(good_id)
        .fetch_optional(&self.pool)
        .await?;
        let last_error = failed
            .map(|r| -> Result<RefreshError, sqlx::Error> {
                Ok(RefreshError {
                    at: r.try_get("fetched_at")?,
                    message: r.try_get("error")?,
                })
            })
            .transpose()?;
        Ok(FeeCache {
            snapshot,
            last_error,
        })
    }
}

/// One refresh attempt: a snapshot, or the failure `(network, at, message)`.
type FeeAttempt = Result<FeeSnapshot, (Network, i64, String)>;

/// In-memory store for tests and local experiments. Not persistent.
#[derive(Default)]
pub struct MemStore {
    orders: Mutex<HashMap<Uuid, StoredOrder>>,
    /// Refresh attempts in order: a snapshot, or the failure `(network, at, message)`.
    fees: Mutex<Vec<FeeAttempt>>,
    jobs: Mutex<HashMap<Uuid, Job>>,
    history: Mutex<HashMap<Uuid, Vec<HistoryEntry>>>,
}

impl JobStore for MemStore {
    async fn create(&self, new: NewJob) -> Result<Job, StoreError> {
        let job = Job {
            id: Uuid::new_v4(),
            txid: new.txid,
            route: new.route,
            state: JobState::AwaitingSignature,
            unsigned_psbt: new.unsigned_psbt,
            extra_fee_sat: new.extra_fee_sat,
            recovery_txid: None,
            network: new.network,
            inputs: new.inputs,
        };
        self.jobs.lock().unwrap().insert(job.id, job.clone());
        Ok(job)
    }

    async fn get(&self, id: Uuid) -> Result<Option<Job>, StoreError> {
        Ok(self.jobs.lock().unwrap().get(&id).cloned())
    }

    async fn claim_for_broadcast(&self, id: Uuid) -> Result<bool, StoreError> {
        self.transition(id, JobState::AwaitingSignature, JobState::Broadcasting)
            .await
    }

    async fn finish_broadcast(&self, id: Uuid, recovery_txid: &str) -> Result<(), StoreError> {
        if let Some(j) = self.jobs.lock().unwrap().get_mut(&id) {
            j.state = JobState::Broadcast;
            j.recovery_txid = Some(recovery_txid.to_string());
        }
        Ok(())
    }

    async fn release(&self, id: Uuid) -> Result<(), StoreError> {
        self.transition(id, JobState::Broadcasting, JobState::AwaitingSignature)
            .await
            .map(drop)
    }

    async fn list_active(&self, network: Network) -> Result<Vec<Job>, StoreError> {
        let mut jobs: Vec<Job> = self
            .jobs
            .lock()
            .unwrap()
            .values()
            .filter(|j| JobState::ACTIVE.contains(&j.state) && j.network == network)
            .cloned()
            .collect();
        jobs.sort_by_key(|j| j.id);
        Ok(jobs)
    }

    async fn transition(&self, id: Uuid, from: JobState, to: JobState) -> Result<bool, StoreError> {
        match self.jobs.lock().unwrap().get_mut(&id) {
            Some(j) if j.state == from => {
                j.state = to;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn record_observation(
        &self,
        id: Uuid,
        txid: &str,
        status: TxStatus,
        confirmations: u32,
        detail: Option<&str>,
    ) -> Result<bool, StoreError> {
        let entry = HistoryEntry {
            txid: txid.to_string(),
            status: status_str(status).to_string(),
            confirmations,
            detail: detail.map(str::to_string),
            observed_at: String::new(),
        };
        let mut all = self.history.lock().unwrap();
        let rows = all.entry(id).or_default();
        let latest = rows.iter().rev().find(|r| r.txid == txid);
        if latest.is_some_and(|l| {
            (&l.status, l.confirmations, &l.detail)
                == (&entry.status, entry.confirmations, &entry.detail)
        }) {
            return Ok(false);
        }
        rows.push(entry);
        Ok(true)
    }

    async fn history(&self, id: Uuid) -> Result<Vec<HistoryEntry>, StoreError> {
        Ok(self
            .history
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .unwrap_or_default())
    }
}

impl FeeStore for MemStore {
    async fn save_snapshot(&self, snapshot: &FeeSnapshot) -> Result<(), StoreError> {
        self.fees.lock().unwrap().push(Ok(snapshot.clone()));
        Ok(())
    }

    async fn save_refresh_error(
        &self,
        network: Network,
        at: i64,
        message: &str,
    ) -> Result<(), StoreError> {
        self.fees
            .lock()
            .unwrap()
            .push(Err((network, at, message.to_string())));
        Ok(())
    }

    async fn fee_cache(&self, network: Network) -> Result<FeeCache, StoreError> {
        let attempts = self.fees.lock().unwrap();
        let mut snapshot = None;
        let mut last_error = None;
        for attempt in attempts.iter() {
            match attempt {
                Ok(s) if s.network == network => {
                    snapshot = Some(s.clone());
                    last_error = None;
                }
                Err((n, at, message)) if *n == network => {
                    last_error = Some(RefreshError {
                        at: *at,
                        message: message.clone(),
                    });
                }
                _ => {}
            }
        }
        Ok(FeeCache {
            snapshot,
            last_error,
        })
    }
}
