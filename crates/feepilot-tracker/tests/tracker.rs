use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use feepilot_bitcoin::{BitcoinDataSource, BitcoinError};
use feepilot_core::{Network, Outpoint, RouteKind, TxAnalysis, TxStatus, Urgency};
use feepilot_store::{Job, JobState, JobStore, MemStore, NewJob};
use feepilot_tracker::{Event, Notifier, Tracker};

/// A scripted chain: tests set what the "node" reports for each txid.
#[derive(Default)]
struct Chain {
    txs: Mutex<HashMap<String, (TxStatus, u32)>>,
    /// outpoint -> txid of the mempool tx spending it
    spenders: Mutex<HashMap<(String, u32), String>>,
    failing: Mutex<HashSet<String>>,
}

impl Chain {
    fn set(&self, txid: &str, status: TxStatus, confirmations: u32) {
        self.txs
            .lock()
            .unwrap()
            .insert(txid.into(), (status, confirmations));
    }
    fn spend(&self, outpoint: &Outpoint, by: &str) {
        self.spenders
            .lock()
            .unwrap()
            .insert((outpoint.txid.clone(), outpoint.vout), by.into());
    }
}

impl BitcoinDataSource for Chain {
    fn network(&self) -> Network {
        Network::Regtest
    }
    async fn analyze(&self, txid: &str) -> Result<TxAnalysis, BitcoinError> {
        if self.failing.lock().unwrap().contains(txid) {
            return Err(BitcoinError::Transport("node down".into()));
        }
        let (status, confirmations) = self
            .txs
            .lock()
            .unwrap()
            .get(txid)
            .copied()
            .unwrap_or((TxStatus::NotFound, 0));
        Ok(TxAnalysis {
            txid: txid.into(),
            network: Network::Regtest,
            status,
            confirmations,
            vsize: 141,
            fee_sat: Some(141),
            signals_rbf: Some(true),
            unconfirmed_ancestors: 0,
            unconfirmed_descendants: 0,
            target_fee_rate: None,
        })
    }
    async fn tx_inputs(&self, _txid: &str) -> Result<Vec<Outpoint>, BitcoinError> {
        Ok(vec![])
    }
    async fn find_spenders(
        &self,
        outpoints: &[Outpoint],
    ) -> Result<Vec<Option<String>>, BitcoinError> {
        let map = self.spenders.lock().unwrap();
        Ok(outpoints
            .iter()
            .map(|o| map.get(&(o.txid.clone(), o.vout)).cloned())
            .collect())
    }
}

const SETTLE: u32 = 6;

struct Harness {
    tracker: Tracker<Chain, MemStore>,
}

fn harness() -> Harness {
    Harness {
        tracker: Tracker::new(Chain::default(), MemStore::default(), SETTLE),
    }
}

fn tx(c: char) -> String {
    c.to_string().repeat(64)
}

fn input() -> Outpoint {
    Outpoint {
        txid: tx('9'),
        vout: 0,
    }
}

impl Harness {
    fn chain(&self) -> &Chain {
        self.tracker.node()
    }

    fn store(&self) -> &MemStore {
        self.tracker.store()
    }

    /// A job for `original`; with `recovery` it is already broadcast.
    async fn job(&self, route: RouteKind, original: &str, recovery: Option<&str>) -> Job {
        let job = self
            .store()
            .create(NewJob {
                txid: original.into(),
                network: Network::Regtest,
                route,
                urgency: Urgency::Normal,
                max_budget_sat: None,
                unsigned_psbt: "psbt".into(),
                extra_fee_sat: 1_000,
                inputs: vec![input()],
            })
            .await
            .unwrap();
        if let Some(r) = recovery {
            assert!(self.store().claim_for_broadcast(job.id).await.unwrap());
            self.store().finish_broadcast(job.id, r).await.unwrap();
        }
        self.store().get(job.id).await.unwrap().unwrap()
    }

    async fn tick(&self) -> Vec<Event> {
        self.tracker.tick().await.unwrap()
    }

    async fn state(&self, job: &Job) -> JobState {
        self.store().get(job.id).await.unwrap().unwrap().state
    }

    async fn statuses(&self, job: &Job, txid: &str) -> Vec<(String, u32, Option<String>)> {
        self.store()
            .history(job.id)
            .await
            .unwrap()
            .into_iter()
            .filter(|h| h.txid == txid)
            .map(|h| (h.status, h.confirmations, h.detail))
            .collect()
    }
}

#[tokio::test]
async fn rbf_goes_pending_confirmed_settled_and_records_the_replacement() {
    let h = harness();
    let (orig, repl) = (tx('a'), tx('b'));
    let job = h.job(RouteKind::Rbf, &orig, Some(&repl)).await;

    // The replacement is in the mempool; the node has forgotten the original.
    h.chain().set(&repl, TxStatus::Pending, 0);
    assert!(
        h.tick().await.is_empty(),
        "still broadcast: nothing to announce"
    );
    assert_eq!(
        h.statuses(&job, &orig).await,
        [("replaced".to_string(), 0, Some(repl.clone()))]
    );

    h.chain().set(&repl, TxStatus::Confirmed, 1);
    let events = h.tick().await;
    assert_eq!(events.len(), 1);
    assert_eq!(
        (events[0].from, events[0].to, events[0].confirmations),
        (JobState::Broadcast, JobState::Confirmed, 1)
    );

    h.chain().set(&repl, TxStatus::Confirmed, 3);
    assert!(
        h.tick().await.is_empty(),
        "deeper but not yet settled: no state change"
    );

    h.chain().set(&repl, TxStatus::Confirmed, SETTLE);
    assert_eq!(h.tick().await[0].to, JobState::Settled);
    assert!(h.tick().await.is_empty());
    assert_eq!(h.state(&job).await, JobState::Settled);
    // Settled jobs are no longer watched.
    assert!(h.store().list_active().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_reorg_demotes_confirmed_back_to_broadcast() {
    let h = harness();
    let (orig, repl) = (tx('a'), tx('b'));
    let job = h.job(RouteKind::Rbf, &orig, Some(&repl)).await;

    h.chain().set(&repl, TxStatus::Confirmed, 2);
    assert_eq!(h.tick().await[0].to, JobState::Confirmed);

    // The block is reorged out and the transaction returns to the mempool.
    h.chain().set(&repl, TxStatus::Pending, 0);
    let events = h.tick().await;
    assert_eq!(
        (events[0].from, events[0].to),
        (JobState::Confirmed, JobState::Broadcast)
    );
    assert_eq!(h.state(&job).await, JobState::Broadcast);
    let seen: Vec<_> = h
        .statuses(&job, &repl)
        .await
        .into_iter()
        .map(|s| (s.0, s.1))
        .collect();
    assert_eq!(
        seen,
        [("confirmed".to_string(), 2), ("pending".to_string(), 0)]
    );

    h.chain().set(&repl, TxStatus::Confirmed, 1);
    assert_eq!(h.tick().await[0].to, JobState::Confirmed);
}

#[tokio::test]
async fn cpfp_succeeds_when_the_parent_confirms() {
    let h = harness();
    let (parent, child) = (tx('a'), tx('c'));
    let job = h.job(RouteKind::Cpfp, &parent, Some(&child)).await;

    h.chain().set(&parent, TxStatus::Pending, 0);
    h.chain().set(&child, TxStatus::Pending, 0);
    assert!(h.tick().await.is_empty());

    h.chain().set(&parent, TxStatus::Confirmed, 1);
    h.chain().set(&child, TxStatus::Confirmed, 1);
    assert_eq!(h.tick().await[0].to, JobState::Confirmed);
    assert_eq!(h.state(&job).await, JobState::Confirmed);
}

#[tokio::test]
async fn unsigned_job_becomes_obsolete_when_the_original_is_replaced_by_someone_else() {
    let h = harness();
    let orig = tx('a');
    let job = h.job(RouteKind::Rbf, &orig, None).await;

    h.chain().set(&orig, TxStatus::Pending, 0);
    assert!(h.tick().await.is_empty());

    // Gone from the node, and another transaction now spends its input.
    h.chain().txs.lock().unwrap().remove(&orig);
    h.chain().spend(&input(), &tx('d'));
    let events = h.tick().await;
    assert_eq!(
        (events[0].from, events[0].to),
        (JobState::AwaitingSignature, JobState::Obsolete)
    );
    let last = h.statuses(&job, &orig).await.pop().unwrap();
    assert_eq!(last, ("replaced".to_string(), 0, Some(tx('d'))));
}

#[tokio::test]
async fn unsigned_job_becomes_obsolete_when_the_original_confirms_on_its_own() {
    let h = harness();
    let orig = tx('a');
    h.job(RouteKind::Cpfp, &orig, None).await;
    h.chain().set(&orig, TxStatus::Confirmed, 1);
    assert_eq!(h.tick().await[0].to, JobState::Obsolete);
}

#[tokio::test]
async fn rbf_is_obsolete_if_the_original_wins_the_race() {
    let h = harness();
    let (orig, repl) = (tx('a'), tx('b'));
    h.job(RouteKind::Rbf, &orig, Some(&repl)).await;
    h.chain().set(&orig, TxStatus::Confirmed, 1);
    h.chain().set(&repl, TxStatus::NotFound, 0);
    assert_eq!(h.tick().await[0].to, JobState::Obsolete);
}

#[tokio::test]
async fn an_evicted_transaction_is_recorded_but_not_called_replaced() {
    let h = harness();
    let orig = tx('a');
    let job = h.job(RouteKind::Rbf, &orig, None).await;
    // Not on the node and nothing spends its inputs: dropped, not replaced.
    assert!(h.tick().await.is_empty());
    assert_eq!(
        h.statuses(&job, &orig).await,
        [("not_found".to_string(), 0, None)]
    );
    assert_eq!(
        h.state(&job).await,
        JobState::AwaitingSignature,
        "the user may still act"
    );
}

#[tokio::test]
async fn ticking_again_without_changes_adds_nothing() {
    let h = harness();
    let (orig, repl) = (tx('a'), tx('b'));
    let job = h.job(RouteKind::Rbf, &orig, Some(&repl)).await;
    h.chain().set(&repl, TxStatus::Pending, 0);
    h.tick().await;
    let before = h.store().history(job.id).await.unwrap().len();
    for _ in 0..3 {
        assert!(h.tick().await.is_empty());
    }
    assert_eq!(h.store().history(job.id).await.unwrap().len(), before);
}

#[tokio::test]
async fn one_failing_job_does_not_stop_the_others() {
    let h = harness();
    let (bad, good) = (tx('a'), tx('c'));
    h.job(RouteKind::Cpfp, &bad, None).await;
    h.job(RouteKind::Cpfp, &good, None).await;
    h.chain().failing.lock().unwrap().insert(bad);
    h.chain().set(&good, TxStatus::Confirmed, 1);
    let events = h.tick().await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].txid, good);
}

#[tokio::test]
async fn a_job_the_user_just_signed_is_not_clobbered_by_a_stale_snapshot() {
    let h = harness();
    let (orig, repl) = (tx('a'), tx('b'));
    let stale = h.job(RouteKind::Rbf, &orig, None).await;

    // The user submits between the tracker listing the job and acting on it.
    assert!(h.store().claim_for_broadcast(stale.id).await.unwrap());
    h.store().finish_broadcast(stale.id, &repl).await.unwrap();
    h.chain().set(&repl, TxStatus::Pending, 0);

    // The stale snapshot (awaiting_signature) sees the original "replaced"; the compare-and-set
    // must refuse to mark it obsolete because the job already moved to `broadcast`.
    let moved = h
        .store()
        .transition(stale.id, JobState::AwaitingSignature, JobState::Obsolete)
        .await
        .unwrap();
    assert!(!moved);
    assert_eq!(h.state(&stale).await, JobState::Broadcast);
}

#[tokio::test]
async fn webhook_receives_the_event_and_failures_are_harmless() {
    use axum::{routing::post, Json, Router};
    let received: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let sink = received.clone();
    let app = Router::new().route(
        "/hook",
        post(move |Json(v): Json<serde_json::Value>| {
            let sink = sink.clone();
            async move {
                sink.lock().unwrap().push(v);
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let event = Event {
        job_id: uuid::Uuid::new_v4(),
        txid: tx('a'),
        recovery_txid: Some(tx('b')),
        route: RouteKind::Rbf,
        from: JobState::Broadcast,
        to: JobState::Confirmed,
        confirmations: 1,
    };
    Notifier::new(Some(url)).send(&event).await;
    let got = received.lock().unwrap().clone();
    assert_eq!(got.len(), 1);
    assert_eq!(
        (got[0]["from"].as_str(), got[0]["to"].as_str()),
        (Some("broadcast"), Some("confirmed"))
    );
    assert_eq!(got[0]["route"], "rbf");

    // Nothing listening, and no webhook at all: neither panics.
    Notifier::new(Some("http://127.0.0.1:9/hook".into()))
        .send(&event)
        .await;
    Notifier::new(None).send(&event).await;
}
