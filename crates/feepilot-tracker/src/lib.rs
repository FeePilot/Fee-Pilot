//! Tracks recovery jobs until they settle.
//!
//! Each tick looks at every active job, records what the node says about its
//! transactions (only when something changed) and moves the job through its states:
//!
//! ```text
//! awaiting_signature --(original confirmed or replaced by someone else)--> obsolete
//! broadcast <--> confirmed --(>= settle depth)--> settled
//! broadcast/confirmed --(RBF: the original confirmed first)--> obsolete
//! ```
//!
//! A confirmation is never treated as final: if a reorg takes the confirmations away, a
//! `confirmed` job drops back to `broadcast` and the history shows it.

mod notifier;

pub use notifier::Notifier;

use std::time::Duration;

use feepilot_bitcoin::{BitcoinDataSource, BitcoinError};
use feepilot_core::{RouteKind, TxAnalysis, TxStatus};
use feepilot_store::{Job, JobState, JobStore, StoreError};
use serde::Serialize;
use uuid::Uuid;

/// Confirmations after which a job is considered settled and no longer watched.
pub const DEFAULT_SETTLE_DEPTH: u32 = 6;

#[derive(Debug, thiserror::Error)]
pub enum TrackerError {
    #[error(transparent)]
    Bitcoin(#[from] BitcoinError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// A job changed state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Event {
    pub job_id: Uuid,
    pub txid: String,
    pub recovery_txid: Option<String>,
    pub route: RouteKind,
    pub from: JobState,
    pub to: JobState,
    /// Confirmations of the transaction that decides the outcome.
    pub confirmations: u32,
}

pub struct Tracker<N, S> {
    node: N,
    store: S,
    settle_depth: u32,
}

/// What the node currently says about a job's original transaction.
struct Original {
    status: TxStatus,
    confirmations: u32,
}

impl<N: BitcoinDataSource, S: JobStore> Tracker<N, S> {
    pub fn new(node: N, store: S, settle_depth: u32) -> Self {
        Self {
            node,
            store,
            settle_depth: settle_depth.max(1),
        }
    }

    pub fn node(&self) -> &N {
        &self.node
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    /// Observe every active job once. A failure on one job is logged and does not stop the
    /// others; only failing to list the jobs is an error.
    pub async fn tick(&self) -> Result<Vec<Event>, StoreError> {
        let mut events = Vec::new();
        for job in self.store.list_active().await? {
            match self.observe(&job).await {
                Ok(Some(event)) => events.push(event),
                Ok(None) => {}
                Err(e) => tracing::warn!("job {}: could not observe its transaction: {e}", job.id),
            }
        }
        Ok(events)
    }

    /// Poll forever, handing each state change to `notifier`.
    pub async fn run(&self, interval: Duration, notifier: &Notifier) {
        loop {
            match self.tick().await {
                Ok(events) => {
                    for event in &events {
                        notifier.send(event).await;
                    }
                }
                Err(e) => tracing::error!("tracker tick failed: {e}"),
            }
            tokio::time::sleep(interval).await;
        }
    }

    async fn observe(&self, job: &Job) -> Result<Option<Event>, TrackerError> {
        // The recovery transaction first: it also explains why the original disappeared.
        let recovery = match &job.recovery_txid {
            Some(txid) => {
                let a = self.node.analyze(txid).await?;
                self.store
                    .record_observation(job.id, txid, a.status, a.confirmations, None)
                    .await?;
                Some(a)
            }
            None => None,
        };

        let (original, replaced_by) = self.original(job, recovery.as_ref()).await?;
        self.store
            .record_observation(
                job.id,
                &job.txid,
                original.status,
                original.confirmations,
                replaced_by.as_deref(),
            )
            .await?;

        let (next, confirmations) = self.next_state(job, &original, recovery.as_ref());
        if next == job.state || !self.store.transition(job.id, job.state, next).await? {
            return Ok(None);
        }
        Ok(Some(Event {
            job_id: job.id,
            txid: job.txid.clone(),
            recovery_txid: job.recovery_txid.clone(),
            route: job.route,
            from: job.state,
            to: next,
            confirmations,
        }))
    }

    /// The original transaction's status. If the node no longer has it, work out whether it
    /// was replaced (and by what) or simply dropped.
    async fn original(
        &self,
        job: &Job,
        recovery: Option<&TxAnalysis>,
    ) -> Result<(Original, Option<String>), TrackerError> {
        let a = self.node.analyze(&job.txid).await?;
        if a.status != TxStatus::NotFound {
            let original = Original {
                status: a.status,
                confirmations: a.confirmations,
            };
            return Ok((original, None));
        }

        let replaced = |by: String| {
            (
                Original {
                    status: TxStatus::Replaced,
                    confirmations: 0,
                },
                Some(by),
            )
        };

        if let (Some(txid), Some(r)) = (&job.recovery_txid, recovery) {
            if matches!(r.status, TxStatus::Pending | TxStatus::Confirmed) {
                return Ok(replaced(txid.clone()));
            }
        }
        let spenders = self.node.find_spenders(&job.inputs).await?;
        if let Some(by) = spenders.into_iter().flatten().find(|s| *s != job.txid) {
            return Ok(replaced(by));
        }
        Ok((
            Original {
                status: TxStatus::NotFound,
                confirmations: 0,
            },
            None,
        ))
    }

    /// The job's next state and the confirmation count that decided it.
    fn next_state(
        &self,
        job: &Job,
        original: &Original,
        recovery: Option<&TxAnalysis>,
    ) -> (JobState, u32) {
        match job.state {
            JobState::AwaitingSignature => {
                let moved_on = matches!(original.status, TxStatus::Confirmed | TxStatus::Replaced);
                let next = if moved_on {
                    JobState::Obsolete
                } else {
                    job.state
                };
                (next, original.confirmations)
            }
            JobState::Broadcast | JobState::Confirmed => {
                // RBF succeeds when the replacement confirms; CPFP when the parent does.
                let deciding = match (job.route, recovery) {
                    (RouteKind::Rbf, Some(r)) => (r.status, r.confirmations),
                    (RouteKind::Rbf, None) => (TxStatus::NotFound, 0),
                    _ => (original.status, original.confirmations),
                };
                if job.route == RouteKind::Rbf && original.status == TxStatus::Confirmed {
                    // The original made it into a block before the replacement did.
                    return (JobState::Obsolete, original.confirmations);
                }
                let confs = if deciding.0 == TxStatus::Confirmed {
                    deciding.1
                } else {
                    0
                };
                let next = if confs >= self.settle_depth {
                    JobState::Settled
                } else if confs >= 1 {
                    JobState::Confirmed
                } else {
                    JobState::Broadcast
                };
                (next, confs)
            }
            other => (other, 0),
        }
    }
}
