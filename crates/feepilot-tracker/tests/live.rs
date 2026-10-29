//! Live tests: real Bitcoin Core (regtest) and PostgreSQL, including a real reorg.
//! Run with:
//!   ./scripts/regtest-setup.sh
//!   cargo test -p feepilot-tracker --test live -- --ignored --test-threads=1

use feepilot_bitcoin::{BitcoinDataSource, CoreRpc, RbfRequest, SigningBoundary};
use feepilot_core::{Network, RouteKind, Urgency};
use feepilot_store::{Job, JobState, JobStore, NewJob, PgStore};
use feepilot_tracker::{Event, Tracker};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;

const SETTLE: u32 = 6;

fn node() -> CoreRpc {
    let url = std::env::var("BITCOIN_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:18443".into());
    let user = std::env::var("BITCOIN_RPC_USER").unwrap_or_else(|_| "feepilot".into());
    let pass = std::env::var("BITCOIN_RPC_PASS").unwrap_or_else(|_| "change-me".into());
    CoreRpc::new(url, Network::Regtest)
        .with_auth(user, pass)
        .with_fallback_fee_rate(20.0)
}

async fn store() -> PgStore {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://feepilot:feepilot@localhost:5432/feepilot".into());
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .unwrap();
    let store = PgStore::new(pool);
    store.migrate().await.unwrap();
    store
}

async fn wallet(rpc: &CoreRpc, name: &str) -> CoreRpc {
    if rpc.call("loadwallet", json!([name])).await.is_err() {
        let _ = rpc.call("createwallet", json!([name])).await;
    }
    rpc.clone().with_wallet(name)
}

async fn mine(w: &CoreRpc, n: u32) {
    let addr = w.call("getnewaddress", json!([])).await.unwrap();
    w.call("generatetoaddress", json!([n, addr])).await.unwrap();
}

struct Env {
    rpc: CoreRpc,
    sender: CoreRpc,
    tracker: Tracker<CoreRpc, PgStore>,
}

async fn setup() -> (Env, CoreRpc) {
    let rpc = node();
    let sender = wallet(&rpc, "sender").await;
    let receiver = wallet(&rpc, "receiver").await;
    if sender
        .call("getbalance", json!([]))
        .await
        .unwrap()
        .as_f64()
        .unwrap()
        < 1.0
    {
        mine(&sender, 101).await;
    }
    let tracker = Tracker::new(rpc.clone(), store().await, SETTLE);
    (
        Env {
            rpc,
            sender,
            tracker,
        },
        receiver,
    )
}

impl Env {
    /// A stuck payment and an unsigned RBF job for it, as the API would create.
    async fn rbf_job(&self, receiver: &CoreRpc) -> (Job, String) {
        let dest = receiver.call("getnewaddress", json!([])).await.unwrap();
        let dest = dest.as_str().unwrap();
        let orig = self
            .sender
            .call(
                "send",
                json!({ "outputs": { dest: 0.01 }, "fee_rate": 1, "options": { "replaceable": true } }),
            )
            .await
            .unwrap()["txid"]
            .as_str()
            .unwrap()
            .to_string();
        let tx = self
            .rpc
            .call("getrawtransaction", json!([orig, 1]))
            .await
            .unwrap();
        let change_vout = tx["vout"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["scriptPubKey"]["address"] != dest)
            .map(|o| o["n"].as_u64().unwrap() as u32)
            .unwrap();
        let old_fee = self.rpc.analyze(&orig).await.unwrap().fee_sat.unwrap();
        let cand = self
            .rpc
            .build_rbf(&RbfRequest {
                txid: orig.clone(),
                change_vout,
                new_fee_sat: old_fee + 3_000,
            })
            .await
            .unwrap();
        let job = self
            .tracker
            .store()
            .create(NewJob {
                txid: orig.clone(),
                network: Network::Regtest,
                route: RouteKind::Rbf,
                urgency: Urgency::Normal,
                max_budget_sat: None,
                unsigned_psbt: cand.psbt_base64,
                extra_fee_sat: 3_000,
                inputs: self.rpc.tx_inputs(&orig).await.unwrap(),
            })
            .await
            .unwrap();
        (job, orig)
    }

    /// The user signs and submits, as `POST /v1/jobs/{id}/submit` would.
    async fn submit(&self, job: &Job) -> String {
        let signed = self
            .sender
            .call("walletprocesspsbt", json!([job.unsigned_psbt]))
            .await
            .unwrap()["psbt"]
            .as_str()
            .unwrap()
            .to_string();
        let store = self.tracker.store();
        assert!(store.claim_for_broadcast(job.id).await.unwrap());
        let repl = self
            .rpc
            .broadcast_signed(&job.unsigned_psbt, &signed)
            .await
            .unwrap();
        store.finish_broadcast(job.id, &repl).await.unwrap();
        repl
    }

    /// Run a tick and keep only this job's events (the shared database may hold others).
    async fn tick_for(&self, job: &Job) -> Vec<Event> {
        let mut events = self.tracker.tick().await.unwrap();
        events.retain(|e| e.job_id == job.id);
        events
    }

    async fn history(&self, job: &Job, txid: &str) -> Vec<(String, u32, Option<String>)> {
        self.tracker
            .store()
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
#[ignore = "needs regtest node and PostgreSQL"]
async fn rbf_job_is_tracked_through_replacement_confirmation_reorg_and_settlement() {
    let (env, receiver) = setup().await;
    let (job, orig) = env.rbf_job(&receiver).await;

    // Awaiting signature, original still pending.
    assert!(env.tick_for(&job).await.is_empty());
    assert_eq!(env.history(&job, &orig).await[0].0, "pending");

    // The user signs; the replacement evicts the original, and the tracker says what replaced it.
    let repl = env.submit(&job).await;
    assert!(env.tick_for(&job).await.is_empty());
    let last = env.history(&job, &orig).await.pop().unwrap();
    assert_eq!(last, ("replaced".to_string(), 0, Some(repl.clone())));

    // One confirmation.
    mine(&env.sender, 1).await;
    let events = env.tick_for(&job).await;
    assert_eq!(
        (events[0].from, events[0].to),
        (JobState::Broadcast, JobState::Confirmed)
    );

    // A real reorg: the block is invalidated and the transaction goes back to the mempool.
    let tip = env.rpc.call("getbestblockhash", json!([])).await.unwrap();
    env.rpc.call("invalidateblock", json!([tip])).await.unwrap();
    let events = env.tick_for(&job).await;
    assert_eq!(
        (events[0].from, events[0].to),
        (JobState::Confirmed, JobState::Broadcast)
    );

    // It confirms again on the new chain, then settles once deep enough.
    mine(&env.sender, 1).await;
    assert_eq!(env.tick_for(&job).await[0].to, JobState::Confirmed);
    mine(&env.sender, SETTLE - 1).await;
    let events = env.tick_for(&job).await;
    assert_eq!(
        (events[0].to, events[0].confirmations),
        (JobState::Settled, SETTLE)
    );

    let statuses: Vec<_> = env
        .history(&job, &repl)
        .await
        .into_iter()
        .map(|h| (h.0, h.1))
        .collect();
    assert_eq!(
        statuses,
        [
            ("pending".to_string(), 0),
            ("confirmed".to_string(), 1),
            ("pending".to_string(), 0),
            ("confirmed".to_string(), 1),
            ("confirmed".to_string(), SETTLE),
        ],
        "the reorg must be visible in the history"
    );
}

#[tokio::test]
#[ignore = "needs regtest node and PostgreSQL"]
async fn unsigned_job_goes_obsolete_when_someone_else_replaces_the_original() {
    let (env, receiver) = setup().await;
    let (job, orig) = env.rbf_job(&receiver).await;
    assert!(env.tick_for(&job).await.is_empty());

    // The user's wallet (or anyone with the keys) bumps the fee on its own.
    let bumped = env
        .sender
        .call("bumpfee", json!([orig, { "fee_rate": 30 }]))
        .await
        .unwrap();
    let other = bumped["txid"].as_str().unwrap().to_string();

    let events = env.tick_for(&job).await;
    assert_eq!(
        (events[0].from, events[0].to),
        (JobState::AwaitingSignature, JobState::Obsolete)
    );
    let last = env.history(&job, &orig).await.pop().unwrap();
    assert_eq!(last, ("replaced".to_string(), 0, Some(other)));
    mine(&env.sender, 1).await;
}
