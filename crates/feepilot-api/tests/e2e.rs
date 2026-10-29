//! End-to-end tests: real Bitcoin Core (regtest) + real PostgreSQL, driven over the HTTP API.
//! Run with:
//!   ./scripts/regtest-setup.sh   # node with -txindex=1 and the `sender` wallet
//!   cargo test -p feepilot-api -- --ignored --test-threads=1
//! Needs DATABASE_URL (defaults to the one in .env.example) and the RPC variables
//! (default to the regtest-setup.sh values).

use std::sync::Arc;

use axum::{body::Body, http::Request, http::StatusCode, Router};
use feepilot_bitcoin::{BitcoinDataSource, CoreRpc};
use feepilot_core::{Network, Outpoint, RouteKind, TxStatus, Urgency};
use feepilot_store::{JobState, JobStore, NewJob, PgStore};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

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

async fn post(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let req = Request::post(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Stand-in for the user's own wallet.
async fn sign(w: &CoreRpc, psbt: &str) -> String {
    let res = w.call("walletprocesspsbt", json!([psbt])).await.unwrap();
    res["psbt"].as_str().unwrap().to_string()
}

async fn setup() -> (CoreRpc, CoreRpc, CoreRpc, Router) {
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
    let app = feepilot_api::router(Arc::new(rpc.clone()), Arc::new(store().await));
    (rpc, sender, receiver, app)
}

/// Pay `dest` 0.01 BTC at 1 sat/vB and return (txid, vout paying dest, other vout).
async fn stuck_payment(rpc: &CoreRpc, sender: &CoreRpc, dest: &str) -> (String, u32, u32) {
    let txid = sender
        .call(
            "send",
            json!({ "outputs": { dest: 0.01 }, "fee_rate": 1, "options": { "replaceable": true } }),
        )
        .await
        .unwrap()["txid"]
        .as_str()
        .unwrap()
        .to_string();
    let tx = rpc
        .call("getrawtransaction", json!([txid, 1]))
        .await
        .unwrap();
    let find = |want: bool| {
        tx["vout"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| (o["scriptPubKey"]["address"] == dest) == want)
            .map(|o| o["n"].as_u64().unwrap() as u32)
            .unwrap()
    };
    (txid, find(true), find(false))
}

#[tokio::test]
#[ignore = "needs regtest node and PostgreSQL"]
async fn pg_store_job_lifecycle() {
    let store = store().await;
    let job = store
        .create(NewJob {
            txid: "a".repeat(64),
            network: Network::Regtest,
            route: RouteKind::Rbf,
            urgency: Urgency::High,
            max_budget_sat: Some(10_000),
            unsigned_psbt: "cHNidP8=".into(),
            extra_fee_sat: 1_234,
            inputs: vec![Outpoint {
                txid: "c".repeat(64),
                vout: 1,
            }],
        })
        .await
        .unwrap();

    let loaded = store.get(job.id).await.unwrap().unwrap();
    assert_eq!(loaded.state, JobState::AwaitingSignature);
    assert_eq!(
        (loaded.extra_fee_sat, loaded.route),
        (1_234, RouteKind::Rbf)
    );

    assert!(store.claim_for_broadcast(job.id).await.unwrap());
    assert!(
        !store.claim_for_broadcast(job.id).await.unwrap(),
        "second claim must fail"
    );
    store.release(job.id).await.unwrap();
    assert!(
        store.claim_for_broadcast(job.id).await.unwrap(),
        "released jobs can be retried"
    );
    store
        .finish_broadcast(job.id, &"b".repeat(64))
        .await
        .unwrap();

    let done = store.get(job.id).await.unwrap().unwrap();
    assert_eq!(done.state, JobState::Broadcast);
    assert_eq!(done.recovery_txid, Some("b".repeat(64)));
    assert!(store.get(uuid::Uuid::new_v4()).await.unwrap().is_none());

    // Tracking: history only grows when something changed.
    let (id, txid) = (job.id, "a".repeat(64));
    assert!(store
        .record_observation(id, &txid, TxStatus::Pending, 0, None)
        .await
        .unwrap());
    assert!(!store
        .record_observation(id, &txid, TxStatus::Pending, 0, None)
        .await
        .unwrap());
    assert!(store
        .record_observation(id, &txid, TxStatus::Replaced, 0, Some("r"))
        .await
        .unwrap());
    assert!(
        store
            .record_observation(id, &txid, TxStatus::Pending, 0, None)
            .await
            .unwrap(),
        "a reorg-style flip back is a change"
    );
    let history = store.history(id).await.unwrap();
    let seen: Vec<_> = history.iter().map(|h| h.status.as_str()).collect();
    assert_eq!(seen, ["pending", "replaced", "pending"]);
    assert_eq!(history[1].detail.as_deref(), Some("r"));

    // Compare-and-set: only one party wins a transition, and settled jobs leave the active list.
    assert!(store
        .list_active()
        .await
        .unwrap()
        .iter()
        .any(|j| j.id == id));
    assert!(!store
        .transition(id, JobState::AwaitingSignature, JobState::Obsolete)
        .await
        .unwrap());
    assert!(store
        .transition(id, JobState::Broadcast, JobState::Settled)
        .await
        .unwrap());
    assert!(!store
        .list_active()
        .await
        .unwrap()
        .iter()
        .any(|j| j.id == id));
}

#[tokio::test]
#[ignore = "needs regtest node and PostgreSQL"]
async fn rbf_recovery_over_http() {
    let (rpc, sender, receiver, app) = setup().await;
    let dest = receiver.call("getnewaddress", json!([])).await.unwrap();
    let (original, _, change_vout) = stuck_payment(&rpc, &sender, dest.as_str().unwrap()).await;

    let (status, created) = post(
        &app,
        "/v1/jobs/rbf",
        json!({ "txid": original, "change_vout": change_vout, "urgency": "normal" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let psbt = created["psbt"].as_str().unwrap();

    let signed = sign(&sender, psbt).await;
    let uri = format!("/v1/jobs/{}/submit", created["job_id"].as_str().unwrap());
    let (status, job) = post(&app, &uri, json!({ "signed_psbt": signed })).await;
    assert_eq!(status, StatusCode::OK, "{job}");
    assert_eq!(job["state"], "broadcast");
    let replacement = job["recovery_txid"].as_str().unwrap();

    assert_eq!(
        rpc.analyze(&original).await.unwrap().status,
        TxStatus::NotFound
    );
    let r = rpc.analyze(replacement).await.unwrap();
    assert_eq!(r.status, TxStatus::Pending);
    assert_eq!(r.fee_sat, created["fee_sat"].as_u64());
    assert!(
        r.fee_rate().unwrap() >= 19.0,
        "replacement should reach the 20 sat/vB target"
    );

    let (status, _) = post(&app, &uri, json!({ "signed_psbt": signed })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    mine(&sender, 1).await;
    assert_eq!(
        rpc.analyze(replacement).await.unwrap().status,
        TxStatus::Confirmed
    );
}

#[tokio::test]
#[ignore = "needs regtest node and PostgreSQL"]
async fn cpfp_recovery_over_http() {
    let (rpc, sender, receiver, app) = setup().await;
    let dest = receiver.call("getnewaddress", json!([])).await.unwrap();
    let (parent, vout, _) = stuck_payment(&rpc, &sender, dest.as_str().unwrap()).await;
    let back = receiver.call("getnewaddress", json!([])).await.unwrap();

    let (status, created) = post(
        &app,
        "/v1/jobs/cpfp",
        json!({ "txid": parent, "vout": vout, "destination": back }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");

    let signed = sign(&receiver, created["psbt"].as_str().unwrap()).await;
    let uri = format!("/v1/jobs/{}/submit", created["job_id"].as_str().unwrap());
    let (status, job) = post(&app, &uri, json!({ "signed_psbt": signed })).await;
    assert_eq!(status, StatusCode::OK, "{job}");

    // The package (parent + child) reaches the 20 sat/vB target.
    let p = rpc.analyze(&parent).await.unwrap();
    let c = rpc
        .analyze(job["recovery_txid"].as_str().unwrap())
        .await
        .unwrap();
    let package_rate =
        (p.fee_sat.unwrap() + c.fee_sat.unwrap()) as f64 / (p.vsize + c.vsize) as f64;
    assert!(package_rate >= 19.0, "package rate {package_rate}");
    mine(&sender, 1).await;
    assert_eq!(
        rpc.analyze(&parent).await.unwrap().status,
        TxStatus::Confirmed
    );
}

#[tokio::test]
#[ignore = "needs regtest node and PostgreSQL"]
async fn submitting_someone_elses_signature_is_refused_and_job_stays_open() {
    let (rpc, sender, receiver, app) = setup().await;
    let dest = receiver.call("getnewaddress", json!([])).await.unwrap();
    let (original, _, change_vout) = stuck_payment(&rpc, &sender, dest.as_str().unwrap()).await;

    // Two jobs for the same tx: signing job B's PSBT must not satisfy job A.
    let body = json!({ "txid": original, "change_vout": change_vout });
    let (_, a) = post(&app, "/v1/jobs/rbf", body.clone()).await;
    let (_, b) = post(
        &app,
        "/v1/jobs/rbf",
        json!({ "txid": original, "change_vout": change_vout, "urgency": "high" }),
    )
    .await;
    assert_ne!(a["fee_sat"], b["fee_sat"]);

    let signed_b = sign(&sender, b["psbt"].as_str().unwrap()).await;
    let uri_a = format!("/v1/jobs/{}/submit", a["job_id"].as_str().unwrap());
    let (status, err) = post(&app, &uri_a, json!({ "signed_psbt": signed_b })).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(err["error"].as_str().unwrap().contains("does not match"));

    // Job A is still open and works with its own signature.
    let signed_a = sign(&sender, a["psbt"].as_str().unwrap()).await;
    let (status, _) = post(&app, &uri_a, json!({ "signed_psbt": signed_a })).await;
    assert_eq!(status, StatusCode::OK);
    mine(&sender, 1).await;
}

#[tokio::test]
#[ignore = "needs PostgreSQL"]
async fn retention_purges_old_data_but_keeps_the_newest_snapshot_and_open_jobs() {
    let store = store().await;
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://feepilot:feepilot@localhost:5432/feepilot".into());
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    // A throwaway network name keeps this test away from real rows.
    let net = format!("test-{}", uuid::Uuid::new_v4());
    let old = "extract(epoch from now())::bigint - 100 * 86400";
    for _ in 0..2 {
        sqlx::query(&format!(
            "INSERT INTO fee_snapshots (network, fetched_at, snapshot) VALUES ($1, {old}, '{{}}')"
        ))
        .bind(&net)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(&format!(
        "INSERT INTO fee_snapshots (network, fetched_at, error) VALUES ($1, {old}, 'x')"
    ))
    .bind(&net)
    .execute(&pool)
    .await
    .unwrap();
    let key = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO orders (idempotency_key, client_id, network, amount_sat, client_created_at,
                             schema_version, created_at)
         VALUES ($1, $1, $2, 1, 1, 1, now() - interval '100 days')",
    )
    .bind(key)
    .bind(&net)
    .execute(&pool)
    .await
    .unwrap();

    let mut jobs = Vec::new();
    for state in ["settled", "awaiting_signature"] {
        let id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO jobs (txid, network, state, updated_at)
             VALUES ($1, $2, $3, now() - interval '100 days') RETURNING id",
        )
        .bind("e".repeat(64))
        .bind(&net)
        .bind(state)
        .fetch_one(&pool)
        .await
        .unwrap();
        jobs.push(id);
    }

    let report = store.purge_older_than(30).await.unwrap();
    assert!(report.fee_rows >= 2 && report.orders >= 1 && report.jobs >= 1);
    let left: Vec<uuid::Uuid> = sqlx::query_scalar("SELECT id FROM jobs WHERE network = $1")
        .bind(&net)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        left,
        vec![jobs[1]],
        "the finished job goes, the one awaiting a signature stays"
    );
    sqlx::query("DELETE FROM jobs WHERE network = $1")
        .bind(&net)
        .execute(&pool)
        .await
        .unwrap();

    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM fee_snapshots WHERE network = $1")
        .bind(&net)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 1, "only the newest good snapshot survives");
    let orders: i64 = sqlx::query_scalar("SELECT count(*) FROM orders WHERE idempotency_key = $1")
        .bind(key)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(orders, 0);
    assert_eq!(
        store.purge_older_than(0).await.unwrap().fee_rows,
        0,
        "0 days keeps everything"
    );
    sqlx::query("DELETE FROM fee_snapshots WHERE network = $1")
        .bind(&net)
        .execute(&pool)
        .await
        .unwrap();
}
