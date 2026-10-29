mod envelope;
mod guard;
pub use guard::{with_rate_limit, with_security_headers, RateLimiter};

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderName, HeaderValue, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use feepilot_bitcoin::{
    BitcoinDataSource, BitcoinError, CpfpRequest, FeeSource, RbfRequest, SigningBoundary,
};
use feepilot_core::{
    recommend, validate_txid, CoreError, Eligibility, FreshnessPolicy, Recommendation, RouteKind,
    StrategyInput, TxAnalysis, TxStatus, Urgency, UserPreferences, DEFAULT_CHILD_VSIZE,
};
use feepilot_store::{
    FeeCache, FeeStore, HistoryEntry, Job, JobState, JobStore, NewJob, NewOrder, OrderState,
    OrderStore, StoreError, Upsert,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

/// Settings for the HTTP layer.
#[derive(Debug, Clone, Copy)]
pub struct ApiConfig {
    /// Freshness windows the offline advisor applies to fee snapshots.
    pub policy: FreshnessPolicy,
    /// A refresh within this many seconds of the last good snapshot is served from the cache,
    /// so clients cannot make the node work on every request. 0 always asks the node.
    pub fee_refresh_cooldown_secs: i64,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            policy: FreshnessPolicy::default(),
            fee_refresh_cooldown_secs: 10,
        }
    }
}

/// Shared handler state: the Bitcoin node and the job store.
pub struct AppState<N, S> {
    node: Arc<N>,
    store: Arc<S>,
    config: ApiConfig,
}

impl<N, S> Clone for AppState<N, S> {
    fn clone(&self) -> Self {
        Self {
            node: self.node.clone(),
            store: self.store.clone(),
            config: self.config,
        }
    }
}

/// Build the HTTP router over a Bitcoin node and a job store.
pub fn router<N, S>(node: Arc<N>, store: Arc<S>) -> Router
where
    N: BitcoinDataSource + SigningBoundary + FeeSource + Send + Sync + 'static,
    S: JobStore + FeeStore + OrderStore + 'static,
{
    router_with_config(node, store, ApiConfig::default())
}

/// [`router`] with explicit settings.
pub fn router_with_config<N, S>(node: Arc<N>, store: Arc<S>, config: ApiConfig) -> Router
where
    N: BitcoinDataSource + SigningBoundary + FeeSource + Send + Sync + 'static,
    S: JobStore + FeeStore + OrderStore + 'static,
{
    let state = AppState {
        node,
        store,
        config,
    };
    Router::new()
        .route("/health", get(health))
        // `/v1` keeps its original response shapes. `/v2` serves the same handlers wrapped in
        // the `{ status, message, body }` envelope, with a degraded fee refresh.
        .nest("/v1", api_routes::<N, S>(false))
        .nest(
            "/v2",
            api_routes::<N, S>(true)
                // Unknown paths under /v2 get the envelope too, not an empty 404.
                .fallback(|| async { ApiError::NotFound })
                .layer(middleware::from_fn(envelope::wrap)),
        )
        .with_state(state)
}

/// The API routes, relative to their version prefix.
fn api_routes<N, S>(v2: bool) -> Router<AppState<N, S>>
where
    N: BitcoinDataSource + SigningBoundary + FeeSource + Send + Sync + 'static,
    S: JobStore + FeeStore + OrderStore + 'static,
{
    let fees = if v2 {
        get(refresh_fees_v2::<N, S>)
    } else {
        get(refresh_fees::<N, S>)
    };
    Router::new()
        .route("/fees", fees)
        .route("/fees/latest", get(latest_fees::<N, S>))
        .route("/orders/sync", post(sync_orders::<N, S>))
        .route("/analyze/{txid}", get(analyze::<N, S>))
        .route("/outputs/{txid}", get(tx_outputs::<N, S>))
        .route("/jobs/rbf", post(create_rbf_job::<N, S>))
        .route("/jobs/cpfp", post(create_cpfp_job::<N, S>))
        .route("/jobs/{id}", get(get_job::<N, S>))
        .route("/jobs/{id}/history", get(job_history::<N, S>))
        .route("/jobs/{id}/submit", post(submit_job::<N, S>))
}

/// Serve a built single-page app from `dir`: `app-shell.html` for every `/app/...` route,
/// prerendered pages and assets as files, and a real 404 (with `404.html`) for anything else.
pub fn with_spa(app: Router, dir: impl AsRef<std::path::Path>) -> Router {
    use tower_http::services::{ServeDir, ServeFile};
    let dir = dir.as_ref();
    let shell = ServeFile::new(dir.join("app-shell.html"));
    app.route_service("/app", shell.clone())
        .route_service("/app/", shell.clone())
        .route_service("/app/{*rest}", shell)
        .fallback_service(
            ServeDir::new(dir).not_found_service(ServeFile::new(dir.join("404.html"))),
        )
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// A fee cache plus the freshness policy the client applies to it, including offline.
#[derive(Serialize)]
struct FeesResponse {
    #[serde(flatten)]
    cache: FeeCache,
    policy: FreshnessPolicy,
    /// The server's clock (unix seconds) when it answered. Clients use it to measure snapshot
    /// age without trusting their own clock.
    server_time: i64,
    /// How this refresh went. Absent from `/fees/latest`, which never refreshes.
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh: Option<RefreshStatus>,
}

#[derive(Serialize)]
struct RefreshStatus {
    /// False when the node could not be asked and the saved snapshot is shown instead.
    ok: bool,
    /// The answer came from the cache without asking the node (cooldown, or a failed refresh).
    served_from_cache: bool,
    /// Stable reason when `ok` is false.
    code: Option<&'static str>,
}

/// Outcome of trying to refresh the fee snapshot.
enum Refreshed {
    /// A new snapshot was taken and stored.
    Fresh(FeeCache),
    /// Within the cooldown; the stored snapshot was returned without asking the node.
    Cooldown(FeeCache),
    /// The node could not provide a snapshot. The cache is what is stored (the failure is
    /// recorded in `last_error`).
    Failed {
        cache: FeeCache,
        error: BitcoinError,
    },
}

fn upstream_code(e: &BitcoinError) -> &'static str {
    match e {
        BitcoinError::Transport(_) => "node_unreachable",
        BitcoinError::Unauthorized | BitcoinError::Config(_) => "node_misconfigured",
        BitcoinError::Malformed(_) => "node_bad_response",
        _ => "node_error",
    }
}

/// Take a fresh fee snapshot from the node and store it. A failed refresh is recorded as an
/// error and leaves the last good snapshot untouched.
async fn refresh_core<N, S>(state: &AppState<N, S>) -> Result<Refreshed, ApiError>
where
    N: BitcoinDataSource + FeeSource + Send + Sync + 'static,
    S: FeeStore + 'static,
{
    let now = unix_now();
    let network = state.node.network();
    let cooldown = state.config.fee_refresh_cooldown_secs;
    if cooldown > 0 {
        let cache = state.store.fee_cache(network).await?;
        if cache
            .snapshot
            .as_ref()
            .is_some_and(|s| now - s.fetched_at < cooldown)
        {
            return Ok(Refreshed::Cooldown(cache));
        }
    }
    match state.node.fee_snapshot(now).await {
        Ok(snapshot) => {
            state.store.save_snapshot(&snapshot).await?;
            Ok(Refreshed::Fresh(FeeCache {
                snapshot: Some(snapshot),
                last_error: None,
            }))
        }
        Err(error) => {
            if let Err(se) = state
                .store
                .save_refresh_error(network, now, "fee refresh failed")
                .await
            {
                tracing::error!("could not record the failed fee refresh: {se}");
            }
            let cache = state.store.fee_cache(network).await?;
            Ok(Refreshed::Failed { cache, error })
        }
    }
}

fn fees_response<N, S>(
    state: &AppState<N, S>,
    cache: FeeCache,
    refresh: Option<RefreshStatus>,
) -> FeesResponse {
    FeesResponse {
        cache,
        policy: state.config.policy,
        server_time: unix_now(),
        refresh,
    }
}

/// `/v1`: a failed refresh is an error (502), as it always was.
async fn refresh_fees<N, S>(
    State(state): State<AppState<N, S>>,
) -> Result<Json<FeesResponse>, ApiError>
where
    N: BitcoinDataSource + FeeSource + Send + Sync + 'static,
    S: FeeStore + 'static,
{
    match refresh_core(&state).await? {
        Refreshed::Fresh(cache) | Refreshed::Cooldown(cache) => {
            Ok(Json(fees_response(&state, cache, None)))
        }
        Refreshed::Failed { error, .. } => Err(error.into()),
    }
}

/// `/v2`: when the node cannot be asked but a snapshot is saved, answer 200 with that snapshot
/// and `refresh.ok = false`. Showing the saved copy is the working path, so it is not an HTTP
/// error. With nothing saved there is nothing to show, so it is still a 502.
async fn refresh_fees_v2<N, S>(State(state): State<AppState<N, S>>) -> Result<Response, ApiError>
where
    N: BitcoinDataSource + FeeSource + Send + Sync + 'static,
    S: FeeStore + 'static,
{
    Ok(match refresh_core(&state).await? {
        Refreshed::Fresh(cache) => {
            let refresh = RefreshStatus {
                ok: true,
                served_from_cache: false,
                code: None,
            };
            Json(fees_response(&state, cache, Some(refresh))).into_response()
        }
        Refreshed::Cooldown(cache) => {
            let refresh = RefreshStatus {
                ok: true,
                served_from_cache: true,
                code: None,
            };
            Json(fees_response(&state, cache, Some(refresh))).into_response()
        }
        Refreshed::Failed { cache, error } => {
            if cache.snapshot.is_none() {
                return Err(error.into());
            }
            tracing::warn!("fee refresh failed, serving the saved snapshot: {error}");
            let refresh = RefreshStatus {
                ok: false,
                served_from_cache: true,
                code: Some(upstream_code(&error)),
            };
            (
                [(
                    HeaderName::from_static(envelope::MESSAGE_HEADER),
                    HeaderValue::from_static(
                        "The node could not be reached, so the last saved fee snapshot is shown.",
                    ),
                )],
                Json(fees_response(&state, cache, Some(refresh))),
            )
                .into_response()
        }
    })
}

/// The last stored snapshot without contacting the node, plus the latest refresh error if the
/// most recent attempt failed. 404 until a refresh has succeeded once.
async fn latest_fees<N, S>(
    State(state): State<AppState<N, S>>,
) -> Result<Json<FeesResponse>, ApiError>
where
    N: BitcoinDataSource + Send + Sync + 'static,
    S: FeeStore + 'static,
{
    let cache = state.store.fee_cache(state.node.network()).await?;
    if cache.snapshot.is_none() {
        return Err(ApiError::NotFound);
    }
    Ok(Json(fees_response(&state, cache, None)))
}

const MAX_SYNC_BATCH: usize = 100;
const MEMO_MAX: usize = 140;

#[derive(Deserialize)]
struct SyncBody {
    orders: Vec<ClientOrder>,
}

#[derive(Deserialize)]
struct ClientOrder {
    /// Client-generated record id.
    id: Uuid,
    idempotency_key: Uuid,
    amount_sat: u64,
    #[serde(default)]
    memo: String,
    txid: Option<String>,
    /// Unix seconds, as the client claims.
    created_at: i64,
    schema_version: u32,
}

#[derive(Serialize)]
struct SyncResult {
    idempotency_key: Uuid,
    outcome: Upsert,
    /// The stored state; for a conflict this is the server's record, not the client's.
    state: OrderState,
    /// Plain-language reading of the state. Never a statement that a payment happened.
    note: String,
    /// The latest node observation, when the order has a txid and the node answered.
    observation: Option<Value>,
}

#[derive(Serialize)]
struct SyncResponse {
    results: Vec<SyncResult>,
}

fn validate_order(o: &ClientOrder) -> Result<(), String> {
    if o.schema_version != 1 {
        return Err(format!("unsupported schema_version {}", o.schema_version));
    }
    if o.amount_sat == 0 || o.amount_sat > i64::MAX as u64 {
        return Err("amount_sat must be above zero".into());
    }
    if o.memo.chars().count() > MEMO_MAX {
        return Err(format!("memo is longer than {MEMO_MAX} characters"));
    }
    if let Some(txid) = &o.txid {
        validate_txid(txid).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read a node analysis as an order state, with careful wording: "not seen by this node" is
/// never "does not exist", and a replaced transaction is not "not seen".
fn observe(a: &TxAnalysis) -> (OrderState, String, Value) {
    let (state, note) = match a.status {
        TxStatus::Pending => (
            OrderState::Seen,
            "This node sees the transaction in its mempool. It is unconfirmed.".to_string(),
        ),
        TxStatus::Confirmed => (
            OrderState::Seen,
            format!(
                "This node sees the transaction in a block ({} confirmation{}).",
                a.confirmations,
                if a.confirmations == 1 { "" } else { "s" }
            ),
        ),
        TxStatus::Replaced => (
            OrderState::Replaced,
            "A different transaction spending the same inputs was seen. This one may not confirm."
                .to_string(),
        ),
        TxStatus::NotFound => (
            OrderState::NotSeen,
            "This node does not see this transaction. That does not mean it does not exist."
                .to_string(),
        ),
    };
    let rate = a.fee_rate();
    let below = match (rate, a.target_fee_rate) {
        (Some(r), Some(t)) if a.status == TxStatus::Pending => Some(r < t),
        _ => None,
    };
    let observation = json!({
        "status": a.status,
        "confirmations": a.confirmations,
        "fee_rate_sat_vb": rate,
        "target_fee_rate_sat_vb": a.target_fee_rate,
        "fee_below_target": below,
    });
    (state, note, observation)
}

/// Sync queued offline orders. Idempotent: a repeat of the same record returns the existing
/// result; the same key with a different payload is a conflict and the stored record is kept.
/// Orders with a txid are checked against the node using its current fee view.
async fn sync_orders<N, S>(
    State(state): State<AppState<N, S>>,
    Json(body): Json<SyncBody>,
) -> Result<Json<SyncResponse>, ApiError>
where
    N: BitcoinDataSource + Send + Sync + 'static,
    S: OrderStore + 'static,
{
    if body.orders.len() > MAX_SYNC_BATCH {
        return Err(ApiError::BadRequest(format!(
            "at most {MAX_SYNC_BATCH} orders per sync"
        )));
    }
    for (i, o) in body.orders.iter().enumerate() {
        validate_order(o).map_err(|m| ApiError::BadRequest(format!("order {i}: {m}")))?;
    }
    let network = state.node.network();
    let mut results = Vec::with_capacity(body.orders.len());
    for o in body.orders {
        let new = NewOrder {
            idempotency_key: o.idempotency_key,
            client_id: o.id,
            network,
            amount_sat: o.amount_sat,
            memo: o.memo,
            txid: o.txid.map(|t| t.to_ascii_lowercase()),
            client_created_at: o.created_at,
            schema_version: o.schema_version,
        };
        let (stored, outcome) = state.store.upsert_order(&new).await?;
        let (order_state, note, observation) = match &stored.txid {
            None => (
                stored.state.clone(),
                "No txid was given, so there is nothing to check. Not proof of payment."
                    .to_string(),
                stored.observation.clone(),
            ),
            Some(txid) => match state.node.analyze(txid).await {
                Ok(analysis) => {
                    let (st, note, obs) = observe(&analysis);
                    state
                        .store
                        .set_verification(stored.idempotency_key, st.clone(), Some(obs.clone()))
                        .await?;
                    (st, note, Some(obs))
                }
                Err(e) => {
                    tracing::warn!("could not verify an order against the node: {e}");
                    (
                        stored.state.clone(),
                        "The node could not be reached to check this transaction. Try again later."
                            .to_string(),
                        stored.observation.clone(),
                    )
                }
            },
        };
        results.push(SyncResult {
            idempotency_key: stored.idempotency_key,
            outcome,
            state: order_state,
            note,
            observation,
        });
    }
    Ok(Json(SyncResponse { results }))
}

/// Analyze a txid and recommend a recovery route.
///
/// Query parameters (all optional): `urgency` (low|normal|high), `max_budget_sat`,
/// `can_sign_inputs`, `controls_output`, `output_value_sat`.
async fn analyze<N, S>(
    State(state): State<AppState<N, S>>,
    Path(txid): Path<String>,
    Query(prefs): Query<UserPreferences>,
) -> Result<Json<Recommendation>, ApiError>
where
    N: BitcoinDataSource + SigningBoundary + Send + Sync + 'static,
    S: JobStore + 'static,
{
    validate_txid(&txid)?;
    let analysis = state.node.analyze(&txid).await?;
    Ok(Json(recommend(StrategyInput {
        analysis,
        prefs,
        child_vsize: DEFAULT_CHILD_VSIZE,
    })))
}

#[derive(Serialize)]
struct OutputsResponse {
    outputs: Vec<feepilot_core::TxOutput>,
}

/// The outputs of a transaction, so the user can pick their change instead of typing an index.
/// `is_change` is only set when a wallet loaded on the node says so.
async fn tx_outputs<N, S>(
    State(state): State<AppState<N, S>>,
    Path(txid): Path<String>,
) -> Result<Json<OutputsResponse>, ApiError>
where
    N: BitcoinDataSource + SigningBoundary + Send + Sync + 'static,
    S: JobStore + 'static,
{
    validate_txid(&txid)?;
    let outputs = state.node.tx_outputs(&txid).await?;
    Ok(Json(OutputsResponse { outputs }))
}

#[derive(Deserialize)]
struct RbfBody {
    txid: String,
    /// Output index of the user's change; it pays for the fee increase.
    change_vout: u32,
    #[serde(default)]
    urgency: Urgency,
    max_budget_sat: Option<u64>,
}

#[derive(Deserialize)]
struct CpfpBody {
    txid: String,
    /// Output of the stuck transaction the user controls.
    vout: u32,
    /// Where the child sends the remainder (typically the user's own address).
    destination: String,
    #[serde(default)]
    urgency: Urgency,
    max_budget_sat: Option<u64>,
}

#[derive(Serialize)]
struct JobCreated {
    job_id: Uuid,
    route: RouteKind,
    /// Unsigned PSBT (base64). Sign it in your own wallet.
    psbt: String,
    /// Absolute fee of the new transaction.
    fee_sat: u64,
    /// Extra network fee compared with the stuck transaction.
    extra_fee_sat: u64,
    description: String,
    next_step: &'static str,
}

const NEXT_STEP: &str =
    "Sign the PSBT in your wallet, then POST {\"signed_psbt\": ...} to /v1/jobs/{job_id}/submit";

/// Run the strategy engine and require `kind` to be feasible; returns the extra network fee.
async fn plan<N: BitcoinDataSource>(
    node: &N,
    txid: &str,
    prefs: UserPreferences,
    kind: RouteKind,
) -> Result<(TxAnalysis, u64), ApiError> {
    validate_txid(txid)?;
    let analysis = node.analyze(txid).await?;
    if analysis.status != TxStatus::Pending {
        return Err(ApiError::Unprocessable(
            "only unconfirmed transactions in the node's mempool can be recovered".into(),
        ));
    }
    let rec = recommend(StrategyInput {
        analysis: analysis.clone(),
        prefs,
        child_vsize: DEFAULT_CHILD_VSIZE,
    });
    let Some(option) = rec.options.iter().find(|o| o.kind == kind) else {
        return Err(ApiError::Unprocessable(rec.rationale));
    };
    match (&option.eligibility, option.network_fee_sat) {
        (Eligibility::Feasible, Some(fee)) => Ok((analysis, fee)),
        (Eligibility::Infeasible { reason }, _) => Err(ApiError::Unprocessable(reason.clone())),
        (Eligibility::Unknown { missing }, _) => Err(ApiError::Unprocessable(format!(
            "cannot proceed, missing {missing}"
        ))),
        _ => Err(ApiError::Unprocessable(
            "fee could not be determined".into(),
        )),
    }
}

async fn create_rbf_job<N, S>(
    State(state): State<AppState<N, S>>,
    Json(body): Json<RbfBody>,
) -> Result<(StatusCode, Json<JobCreated>), ApiError>
where
    N: BitcoinDataSource + SigningBoundary + Send + Sync + 'static,
    S: JobStore + 'static,
{
    let prefs = UserPreferences {
        urgency: body.urgency,
        max_budget_sat: body.max_budget_sat,
        can_sign_inputs: Some(true),
        ..Default::default()
    };
    let (analysis, extra) = plan(&*state.node, &body.txid, prefs, RouteKind::Rbf).await?;
    let new_fee_sat = analysis.fee_sat.unwrap_or_default() + extra;

    let candidate = state
        .node
        .build_rbf(&RbfRequest {
            txid: body.txid.clone(),
            change_vout: body.change_vout,
            new_fee_sat,
        })
        .await?;
    store_job(
        &state,
        &analysis,
        RouteKind::Rbf,
        body.urgency,
        body.max_budget_sat,
        candidate.psbt_base64,
        candidate.fee_sat,
        extra,
        candidate.description,
    )
    .await
}

async fn create_cpfp_job<N, S>(
    State(state): State<AppState<N, S>>,
    Json(body): Json<CpfpBody>,
) -> Result<(StatusCode, Json<JobCreated>), ApiError>
where
    N: BitcoinDataSource + SigningBoundary + Send + Sync + 'static,
    S: JobStore + 'static,
{
    let prefs = UserPreferences {
        urgency: body.urgency,
        max_budget_sat: body.max_budget_sat,
        controls_output: Some(true),
        ..Default::default()
    };
    let (analysis, child_fee) = plan(&*state.node, &body.txid, prefs, RouteKind::Cpfp).await?;

    let candidate = state
        .node
        .build_cpfp(&CpfpRequest {
            parent_txid: body.txid.clone(),
            vout: body.vout,
            child_fee_sat: child_fee,
            destination: body.destination,
        })
        .await?;
    store_job(
        &state,
        &analysis,
        RouteKind::Cpfp,
        body.urgency,
        body.max_budget_sat,
        candidate.psbt_base64,
        candidate.fee_sat,
        child_fee,
        candidate.description,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn store_job<N: BitcoinDataSource, S: JobStore>(
    state: &AppState<N, S>,
    analysis: &TxAnalysis,
    route: RouteKind,
    urgency: Urgency,
    max_budget_sat: Option<u64>,
    psbt: String,
    fee_sat: u64,
    extra_fee_sat: u64,
    description: String,
) -> Result<(StatusCode, Json<JobCreated>), ApiError> {
    let inputs = state.node.tx_inputs(&analysis.txid).await?;
    let job = state
        .store
        .create(NewJob {
            txid: analysis.txid.clone(),
            network: analysis.network,
            route,
            urgency,
            max_budget_sat,
            unsigned_psbt: psbt.clone(),
            extra_fee_sat,
            inputs,
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(JobCreated {
            job_id: job.id,
            route,
            psbt,
            fee_sat,
            extra_fee_sat,
            description,
            next_step: NEXT_STEP,
        }),
    ))
}

async fn get_job<N, S>(
    State(state): State<AppState<N, S>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Job>, ApiError>
where
    N: BitcoinDataSource + SigningBoundary + Send + Sync + 'static,
    S: JobStore + 'static,
{
    state
        .store
        .get(id)
        .await?
        .map(Json)
        .ok_or(ApiError::NotFound)
}

/// Every status change the tracker has recorded for this job's transactions.
async fn job_history<N, S>(
    State(state): State<AppState<N, S>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<HistoryEntry>>, ApiError>
where
    N: BitcoinDataSource + SigningBoundary + Send + Sync + 'static,
    S: JobStore + 'static,
{
    state.store.get(id).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(state.store.history(id).await?))
}

#[derive(Deserialize)]
struct SubmitBody {
    /// The wallet-signed PSBT (base64).
    signed_psbt: String,
}

/// Verify the signed PSBT matches the one issued for this job, then broadcast it.
async fn submit_job<N, S>(
    State(state): State<AppState<N, S>>,
    Path(id): Path<Uuid>,
    Json(body): Json<SubmitBody>,
) -> Result<Json<Job>, ApiError>
where
    N: BitcoinDataSource + SigningBoundary + Send + Sync + 'static,
    S: JobStore + 'static,
{
    let job = state.store.get(id).await?.ok_or(ApiError::NotFound)?;
    let not_awaiting = || ApiError::Conflict("this job is not awaiting a signature".into());
    if job.state != JobState::AwaitingSignature || !state.store.claim_for_broadcast(id).await? {
        return Err(not_awaiting());
    }

    match state
        .node
        .broadcast_signed(&job.unsigned_psbt, &body.signed_psbt)
        .await
    {
        Ok(txid) => {
            if let Err(e) = state.store.finish_broadcast(id, &txid).await {
                // The transaction is out; this is the one place a txid is logged, so it stays recoverable.
                tracing::error!("job {id} broadcast as {txid} but could not be recorded: {e}");
                return Err(e.into());
            }
            Ok(Json(Job {
                state: JobState::Broadcast,
                recovery_txid: Some(txid),
                ..job
            }))
        }
        Err(e) => {
            if let Err(release) = state.store.release(id).await {
                tracing::error!(
                    "job {id} could not be released after a failed broadcast: {release}"
                );
            }
            Err(e.into())
        }
    }
}

enum ApiError {
    BadRequest(String),
    /// The request was understood but cannot be done (infeasible route, bad PSBT...).
    Unprocessable(String),
    NotFound,
    Conflict(String),
    Upstream(BitcoinError),
    Store(StoreError),
}

impl From<CoreError> for ApiError {
    fn from(e: CoreError) -> Self {
        Self::BadRequest(e.to_string())
    }
}

impl From<BitcoinError> for ApiError {
    fn from(e: BitcoinError) -> Self {
        match e {
            BitcoinError::InvalidRequest(_) | BitcoinError::Rejected(_) => {
                Self::Unprocessable(e.to_string())
            }
            other => Self::Upstream(other),
        }
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, msg) = match self {
            Self::BadRequest(m) => (StatusCode::BAD_REQUEST, "bad_request", m),
            Self::Unprocessable(m) => (StatusCode::UNPROCESSABLE_ENTITY, "unprocessable", m),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found", "not found".into()),
            Self::Conflict(m) => (StatusCode::CONFLICT, "conflict", m),
            // Node and database details stay in the logs; clients get a generic message.
            Self::Upstream(e) => {
                tracing::error!("bitcoin data source error: {e}");
                (
                    StatusCode::BAD_GATEWAY,
                    upstream_code(&e),
                    "bitcoin node unavailable or misconfigured".into(),
                )
            }
            Self::Store(e) => {
                tracing::error!("{e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "internal error".into(),
                )
            }
        };
        let mut res = (status, Json(json!({ "error": msg }))).into_response();
        // `/v2` turns this into `body.code`; `/v1` clients ignore an unknown header.
        res.headers_mut().insert(
            HeaderName::from_static(envelope::CODE_HEADER),
            HeaderValue::from_static(code),
        );
        res
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use feepilot_bitcoin::UnsignedCandidate;
    use feepilot_core::{FeeSnapshot, Network, Outpoint, TxStatus};
    use feepilot_store::MemStore;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    struct Mock(Result<TxAnalysis, &'static str>);

    impl BitcoinDataSource for Mock {
        fn network(&self) -> Network {
            Network::Regtest
        }
        async fn analyze(&self, _txid: &str) -> Result<TxAnalysis, BitcoinError> {
            self.0
                .clone()
                .map_err(|m| BitcoinError::Transport(m.to_string()))
        }
        async fn tx_inputs(&self, _txid: &str) -> Result<Vec<Outpoint>, BitcoinError> {
            Ok(vec![Outpoint {
                txid: "d".repeat(64),
                vout: 0,
            }])
        }
        async fn find_spenders(&self, o: &[Outpoint]) -> Result<Vec<Option<String>>, BitcoinError> {
            Ok(vec![None; o.len()])
        }
    }

    impl FeeSource for Mock {
        async fn fee_snapshot(&self, now: i64) -> Result<FeeSnapshot, BitcoinError> {
            match &self.0 {
                Ok(_) => Ok(FeeSnapshot::build(
                    Network::Regtest,
                    now,
                    &[(2, Some(12.0)), (6, None), (144, None)],
                    Some(1.0),
                    Some(1.0),
                    Some(20.0),
                )),
                Err(m) => Err(BitcoinError::Transport(m.to_string())),
            }
        }
    }

    /// A "signed" PSBT is the unsigned one prefixed with `signed:`.
    impl SigningBoundary for Mock {
        async fn build_rbf(&self, req: &RbfRequest) -> Result<UnsignedCandidate, BitcoinError> {
            Ok(UnsignedCandidate {
                psbt_base64: format!("unsigned-rbf-{}", req.new_fee_sat),
                fee_sat: req.new_fee_sat,
                description: "rbf".into(),
            })
        }
        async fn build_cpfp(&self, req: &CpfpRequest) -> Result<UnsignedCandidate, BitcoinError> {
            Ok(UnsignedCandidate {
                psbt_base64: format!("unsigned-cpfp-{}", req.child_fee_sat),
                fee_sat: req.child_fee_sat,
                description: "cpfp".into(),
            })
        }
        async fn broadcast_signed(
            &self,
            unsigned_psbt: &str,
            signed_psbt: &str,
        ) -> Result<String, BitcoinError> {
            if signed_psbt == format!("signed:{unsigned_psbt}") {
                Ok("c".repeat(64))
            } else {
                Err(BitcoinError::InvalidRequest(
                    "the PSBT is not fully signed".into(),
                ))
            }
        }
    }

    /// 141 vB paying 141 sat (1 sat/vB) against a 20 sat/vB target.
    fn stuck(txid: &str) -> TxAnalysis {
        TxAnalysis {
            txid: txid.into(),
            network: Network::Regtest,
            status: TxStatus::Pending,
            confirmations: 0,
            vsize: 141,
            fee_sat: Some(141),
            signals_rbf: Some(true),
            unconfirmed_ancestors: 0,
            unconfirmed_descendants: 0,
            target_fee_rate: Some(20.0),
        }
    }

    fn no_cooldown() -> ApiConfig {
        ApiConfig {
            fee_refresh_cooldown_secs: 0,
            ..ApiConfig::default()
        }
    }

    fn app(analysis: Result<TxAnalysis, &'static str>) -> Router {
        router_with_config(
            Arc::new(Mock(analysis)),
            Arc::new(MemStore::default()),
            no_cooldown(),
        )
    }

    #[tokio::test]
    async fn fees_refresh_then_serve_from_the_cache() {
        let app = app(Ok(stuck(&"a".repeat(64))));
        let get = |uri: &str| Request::get(uri.to_string()).body(Body::empty()).unwrap();

        let (status, _) = call(&app, get("/v1/fees/latest")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, body) = call(&app, get("/v1/fees")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["snapshot"]["unit"], "sat/vB");
        assert_eq!(body["policy"]["recent_secs"], 600);
        assert_eq!(body["snapshot"]["estimates"][0]["source"], "node");
        assert_eq!(body["snapshot"]["estimates"][1]["source"], "fallback");

        let (status, latest) = call(&app, get("/v1/fees/latest")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(latest["snapshot"], body["snapshot"]);
        assert!(latest["last_error"].is_null());
    }

    #[tokio::test]
    async fn failed_refresh_keeps_the_last_good_snapshot() {
        let store = Arc::new(MemStore::default());
        let good = router_with_config(
            Arc::new(Mock(Ok(stuck(&"a".repeat(64))))),
            store.clone(),
            no_cooldown(),
        );
        let bad = router_with_config(Arc::new(Mock(Err("node down"))), store, no_cooldown());
        let get = |uri: &str| Request::get(uri.to_string()).body(Body::empty()).unwrap();

        let (_, first) = call(&good, get("/v1/fees")).await;
        let (status, _) = call(&bad, get("/v1/fees")).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);

        let (status, latest) = call(&bad, get("/v1/fees/latest")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(latest["snapshot"], first["snapshot"]);
        assert!(latest["last_error"]["message"].is_string());

        // A later success clears the error.
        let (_, _) = call(&good, get("/v1/fees")).await;
        let (_, latest) = call(&good, get("/v1/fees/latest")).await;
        assert!(latest["last_error"].is_null());
    }

    fn post(uri: &str, body: Value) -> Request<Body> {
        Request::post(uri.to_string())
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn order(key: u128, amount: u64, txid: Option<String>) -> Value {
        json!({
            "id": Uuid::from_u128(key + 500), "idempotency_key": Uuid::from_u128(key),
            "amount_sat": amount, "memo": "m", "txid": txid, "created_at": 7, "schema_version": 1,
        })
    }

    #[tokio::test]
    async fn order_sync_is_idempotent_and_reports_conflicts() {
        let app = app(Ok(stuck(&"a".repeat(64))));
        let batch = json!({ "orders": [order(1, 100, None)] });

        let (status, first) = call(&app, post("/v1/orders/sync", batch.clone())).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["results"][0]["outcome"], "created");
        assert_eq!(first["results"][0]["state"], "awaiting_verification");
        assert!(first["results"][0]["note"]
            .as_str()
            .unwrap()
            .contains("Not proof of payment"));

        let (_, again) = call(&app, post("/v1/orders/sync", batch)).await;
        assert_eq!(again["results"][0]["outcome"], "existing");

        let clash = json!({ "orders": [order(1, 999, None)] });
        let (_, clash) = call(&app, post("/v1/orders/sync", clash)).await;
        assert_eq!(clash["results"][0]["outcome"], "conflict");
    }

    #[tokio::test]
    async fn order_sync_checks_the_txid_with_careful_wording() {
        let txid = "a".repeat(64);
        let app = app(Ok(stuck(&txid)));
        let batch = json!({ "orders": [order(2, 50, Some(txid))] });
        let (_, res) = call(&app, post("/v1/orders/sync", batch)).await;
        let r = &res["results"][0];
        assert_eq!(r["state"], "seen");
        assert_eq!(r["observation"]["status"], "pending");
        // 141 sat over 141 vB against a 20 sat/vB target.
        assert_eq!(r["observation"]["fee_below_target"], true);

        let mut gone = stuck(&"b".repeat(64));
        gone.status = TxStatus::NotFound;
        let app = super::tests::app(Ok(gone));
        let batch = json!({ "orders": [order(3, 50, Some("b".repeat(64)))] });
        let (_, res) = call(&app, post("/v1/orders/sync", batch)).await;
        let r = &res["results"][0];
        assert_eq!(r["state"], "not_seen");
        assert!(r["note"]
            .as_str()
            .unwrap()
            .contains("does not mean it does not exist"));
    }

    #[tokio::test]
    async fn order_sync_survives_an_unreachable_node() {
        let app = app(Err("node down"));
        let batch = json!({ "orders": [order(4, 50, Some("c".repeat(64)))] });
        let (status, res) = call(&app, post("/v1/orders/sync", batch)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(res["results"][0]["state"], "awaiting_verification");
        assert_eq!(res["results"][0]["outcome"], "created");
    }

    #[tokio::test]
    async fn order_sync_rejects_bad_input() {
        let app = app(Ok(stuck(&"a".repeat(64))));
        for bad in [
            order(5, 0, None),
            order(5, 10, Some("zz".into())),
            json!({ "id": Uuid::nil(), "idempotency_key": Uuid::nil(), "amount_sat": 1,
                    "memo": "x".repeat(141), "created_at": 1, "schema_version": 1 }),
        ] {
            let (status, _) = call(&app, post("/v1/orders/sync", json!({ "orders": [bad] }))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
        let many: Vec<Value> = (0..101).map(|i| order(i + 10, 1, None)).collect();
        let (status, _) = call(&app, post("/v1/orders/sync", json!({ "orders": many }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn refresh_within_the_cooldown_is_served_from_the_cache() {
        let store = Arc::new(MemStore::default());
        let good = router(Arc::new(Mock(Ok(stuck(&"a".repeat(64))))), store.clone());
        let down = router(Arc::new(Mock(Err("node down"))), store);
        let get = |uri: &str| Request::get(uri.to_string()).body(Body::empty()).unwrap();

        let (status, first) = call(&good, get("/v1/fees")).await;
        assert_eq!(status, StatusCode::OK);
        // The node is gone, but the snapshot is a second old: no node call, no error.
        let (status, again) = call(&down, get("/v1/fees")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(again["snapshot"], first["snapshot"]);
    }

    #[tokio::test]
    async fn responses_carry_security_headers_and_api_responses_are_not_cached() {
        let web = spa_fixture();
        let app = with_security_headers(with_spa(app(Err("unused")), web));
        let page = app
            .clone()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let h = page.headers();
        assert_eq!(h["x-content-type-options"], "nosniff");
        assert_eq!(h["referrer-policy"], "no-referrer");
        assert_eq!(h["x-frame-options"], "DENY");
        assert!(h["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("script-src 'self'"));
        assert!(h.get("cache-control").is_none());

        let api = app
            .oneshot(Request::get("/v1/fees/latest").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(api.headers()["cache-control"], "no-store");
    }

    #[tokio::test]
    async fn the_rate_limit_applies_to_the_api_but_not_to_static_files() {
        let web = spa_fixture();
        let app = with_rate_limit(
            with_spa(app(Err("unused")), web),
            Arc::new(RateLimiter::per_minute(2)),
        );
        let hit = |uri: &str| {
            let app = app.clone();
            let uri = uri.to_string();
            async move {
                app.oneshot(Request::get(uri).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
            }
        };
        assert_eq!(hit("/health").await.status(), StatusCode::OK);
        assert_eq!(hit("/v1/fees/latest").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(hit("/v1/fees/latest").await.status(), StatusCode::NOT_FOUND);
        let limited = hit("/v1/fees/latest").await;
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(limited.headers().contains_key("retry-after"));
        for _ in 0..5 {
            assert_eq!(hit("/index.html").await.status(), StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn v2_wraps_success_in_the_envelope_and_v1_is_untouched() {
        let app = app(Ok(stuck(&"a".repeat(64))));
        let (status, v2) = get_json(&app, "/v2/fees").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            (v2["status"].as_i64(), v2["message"].as_str()),
            (Some(200), Some("ok"))
        );
        assert_eq!(v2["body"]["snapshot"]["unit"], "sat/vB");
        assert_eq!(v2["body"]["refresh"]["ok"], true);
        assert!(v2["body"]["server_time"].as_i64().unwrap() > 1_000_000_000);

        // The same call on /v1 keeps its original, unwrapped shape.
        let (_, v1) = get_json(&app, "/v1/fees").await;
        assert!(v1.get("body").is_none() && v1["snapshot"]["unit"] == "sat/vB");
        assert!(v1.get("refresh").is_none());
    }

    #[tokio::test]
    async fn v2_serves_the_saved_snapshot_as_a_200_when_the_node_is_down() {
        let store = Arc::new(MemStore::default());
        let good = router_with_config(
            Arc::new(Mock(Ok(stuck(&"a".repeat(64))))),
            store.clone(),
            no_cooldown(),
        );
        let down = router_with_config(Arc::new(Mock(Err("node down"))), store, no_cooldown());
        let (_, first) = get_json(&good, "/v2/fees").await;

        let (status, v2) = get_json(&down, "/v2/fees").await;
        assert_eq!(
            status,
            StatusCode::OK,
            "showing the saved copy is not an HTTP error"
        );
        assert_eq!(v2["body"]["snapshot"], first["body"]["snapshot"]);
        assert_eq!(v2["body"]["refresh"]["ok"], false);
        assert_eq!(v2["body"]["refresh"]["served_from_cache"], true);
        assert_eq!(v2["body"]["refresh"]["code"], "node_unreachable");
        assert!(v2["message"]
            .as_str()
            .unwrap()
            .contains("last saved fee snapshot"));
        assert!(v2["body"]["last_error"]["message"].is_string());

        // /v1 still reports the failed refresh as a 502, exactly as before.
        let (status, _) = get_json(&down, "/v1/fees").await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn v2_with_nothing_saved_and_no_node_is_a_502_with_a_code() {
        let app = router_with_config(
            Arc::new(Mock(Err("node down"))),
            Arc::new(MemStore::default()),
            no_cooldown(),
        );
        let (status, v) = get_json(&app, "/v2/fees").await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(v["status"], 502);
        assert_eq!(v["body"]["code"], "node_unreachable");
        assert_eq!(v["message"], "The Bitcoin node could not be reached.");
    }

    #[tokio::test]
    async fn v2_errors_carry_a_status_a_message_and_a_stable_code() {
        let app = app(Ok(stuck(&"a".repeat(64))));
        let (status, v) = get_json(&app, "/v2/analyze/not-a-txid").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            (v["status"].as_i64(), v["body"]["code"].as_str()),
            (Some(400), Some("bad_request"))
        );
        assert!(!v["message"].as_str().unwrap().is_empty());

        let (status, v) = get_json(&app, &format!("/v2/jobs/{}", Uuid::new_v4())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(v["body"]["code"], "not_found");

        let (status, v) = get_json(&app, "/v2/nothing-here").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(v["body"]["code"], "not_found");
    }

    #[tokio::test]
    async fn v2_rate_limit_answers_with_an_envelope_and_retry_after() {
        let app = with_rate_limit(
            app(Ok(stuck(&"a".repeat(64)))),
            Arc::new(RateLimiter::per_minute(1)),
        );
        let hit = |app: Router| async move {
            app.oneshot(Request::get("/v2/fees/latest").body(Body::empty()).unwrap())
                .await
                .unwrap()
        };
        assert_eq!(hit(app.clone()).await.status(), StatusCode::NOT_FOUND);
        let limited = hit(app).await;
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(limited.headers().contains_key("retry-after"));
        let bytes = limited.into_body().collect().await.unwrap().to_bytes();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            (v["status"].as_i64(), v["body"]["code"].as_str()),
            (Some(429), Some("rate_limited"))
        );
    }

    #[tokio::test]
    async fn api_and_app_paths_are_noindex_but_the_home_page_is_not() {
        let dir = spa_fixture();
        let app = with_security_headers(with_spa(app(Err("unused")), &dir));
        let head = |uri: &str| {
            let app = app.clone();
            let uri = uri.to_string();
            async move {
                app.oneshot(Request::get(uri).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
            }
        };
        assert_eq!(
            head("/v2/fees/latest").await.headers()["x-robots-tag"],
            "noindex, nofollow"
        );
        assert_eq!(
            head("/app/fees").await.headers()["x-robots-tag"],
            "noindex, nofollow"
        );
        assert!(head("/").await.headers().get("x-robots-tag").is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    /// A tiny built site: home, app shell, 404 and one asset.
    fn spa_fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("feepilot-spa-{}", Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "HOME-PAGE").unwrap();
        std::fs::write(dir.join("app-shell.html"), "APP-SHELL").unwrap();
        std::fs::write(dir.join("404.html"), "NOT-FOUND-PAGE").unwrap();
        std::fs::write(dir.join("assets/a.js"), "console.log(1)").unwrap();
        dir
    }

    async fn text(res: Response) -> (StatusCode, String) {
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&bytes).to_string())
    }

    #[tokio::test]
    async fn the_spa_serves_the_shell_for_app_routes_and_a_real_404_elsewhere() {
        let dir = spa_fixture();
        let app = with_spa(app(Err("unused")), &dir);
        let get = |uri: &str| {
            let app = app.clone();
            let uri = uri.to_string();
            async move {
                text(
                    app.oneshot(Request::get(uri).body(Body::empty()).unwrap())
                        .await
                        .unwrap(),
                )
                .await
            }
        };
        assert_eq!(get("/").await, (StatusCode::OK, "HOME-PAGE".into()));
        assert_eq!(get("/app").await, (StatusCode::OK, "APP-SHELL".into()));
        assert_eq!(get("/app/").await, (StatusCode::OK, "APP-SHELL".into()));
        assert_eq!(
            get("/app/jobs/abc").await,
            (StatusCode::OK, "APP-SHELL".into())
        );
        assert_eq!(get("/assets/a.js").await.0, StatusCode::OK);
        assert_eq!(
            get("/nope").await,
            (StatusCode::NOT_FOUND, "NOT-FOUND-PAGE".into())
        );
        // The API still wins over the static fallback.
        assert_eq!(get("/health").await.0, StatusCode::OK);
        assert_eq!(get("/v2/fees/latest").await.0, StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn the_built_app_is_served_without_shadowing_the_api() {
        let web = spa_fixture();
        let app = with_spa(app(Err("unused")), web);

        let page = app
            .clone()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(page.status(), StatusCode::OK);
        let html = page.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&html).contains("HOME-PAGE"));

        let (status, body) = call(&app, Request::get("/health").body(Body::empty()).unwrap()).await;
        assert_eq!(
            (status, body["status"].as_str()),
            (StatusCode::OK, Some("ok"))
        );

        let missing = app
            .oneshot(Request::get("/nope.js").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    async fn call(app: &Router, req: Request<Body>) -> (StatusCode, Value) {
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn get_json(app: &Router, uri: &str) -> (StatusCode, Value) {
        call(app, Request::get(uri).body(Body::empty()).unwrap()).await
    }

    async fn post_json(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
        let req = Request::post(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        call(app, req).await
    }

    #[tokio::test]
    async fn analyze_returns_the_analysis() {
        let txid = "a".repeat(64);
        let (status, body) = get_json(&app(Ok(stuck(&txid))), &format!("/v1/analyze/{txid}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["analysis"]["status"], "pending");
        assert_eq!(body["analysis"]["fee_sat"], 141);
        // Nothing is known about the user yet, so no route is recommended.
        assert_eq!(body["recommended"], "wait");
    }

    #[tokio::test]
    async fn preferences_in_the_query_drive_the_recommendation() {
        let txid = "a".repeat(64);
        let uri =
            format!("/v1/analyze/{txid}?can_sign_inputs=true&urgency=high&max_budget_sat=50000");
        let (status, body) = get_json(&app(Ok(stuck(&txid))), &uri).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["recommended"], "rbf");
    }

    #[tokio::test]
    async fn invalid_preferences_are_a_client_error() {
        let txid = "a".repeat(64);
        let (status, _) = get_json(
            &app(Ok(stuck(&txid))),
            &format!("/v1/analyze/{txid}?urgency=asap"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn bad_txid_is_rejected_before_hitting_the_node() {
        let (status, _) = get_json(&app(Err("must not be called")), "/v1/analyze/not-a-txid").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn node_failure_is_a_502_without_leaking_details() {
        let uri = format!("/v1/analyze/{}", "b".repeat(64));
        let (status, body) = get_json(&app(Err("connection refused 10.0.0.5")), &uri).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(!body.to_string().contains("10.0.0.5"));
    }

    #[tokio::test]
    async fn rbf_job_issues_a_psbt_and_is_persisted() {
        let txid = "a".repeat(64);
        let app = app(Ok(stuck(&txid)));
        let (status, body) = post_json(
            &app,
            "/v1/jobs/rbf",
            json!({ "txid": txid, "change_vout": 1 }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        // min_rbf_fee(141 sat, 143 vB, 20 sat/vB) = 2860 sat, i.e. 2719 extra.
        assert_eq!(body["fee_sat"], 2860);
        assert_eq!(body["extra_fee_sat"], 2719);
        assert_eq!(body["psbt"], "unsigned-rbf-2860");

        let (status, job) = get_json(
            &app,
            &format!("/v1/jobs/{}", body["job_id"].as_str().unwrap()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(job["state"], "awaiting_signature");
        assert_eq!(job["route"], "rbf");
    }

    #[tokio::test]
    async fn history_is_empty_until_the_tracker_records_something() {
        let txid = "a".repeat(64);
        let app = app(Ok(stuck(&txid)));
        let (_, created) = post_json(
            &app,
            "/v1/jobs/rbf",
            json!({ "txid": txid, "change_vout": 1 }),
        )
        .await;
        let uri = format!("/v1/jobs/{}/history", created["job_id"].as_str().unwrap());
        let (status, body) = get_json(&app, &uri).await;
        assert_eq!((status, body), (StatusCode::OK, json!([])));
        let (status, _) = get_json(&app, &format!("/v1/jobs/{}/history", Uuid::new_v4())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn submitting_a_valid_signature_broadcasts_once() {
        let txid = "a".repeat(64);
        let app = app(Ok(stuck(&txid)));
        let (_, created) = post_json(
            &app,
            "/v1/jobs/rbf",
            json!({ "txid": txid, "change_vout": 1 }),
        )
        .await;
        let uri = format!("/v1/jobs/{}/submit", created["job_id"].as_str().unwrap());
        let signed = json!({ "signed_psbt": "signed:unsigned-rbf-2860" });

        let (status, job) = post_json(&app, &uri, signed.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(job["state"], "broadcast");
        assert_eq!(job["recovery_txid"], "c".repeat(64));

        let (status, _) = post_json(&app, &uri, signed).await;
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "a job must not be broadcast twice"
        );
    }

    #[tokio::test]
    async fn a_bad_signature_can_be_retried() {
        let txid = "a".repeat(64);
        let app = app(Ok(stuck(&txid)));
        let (_, created) = post_json(
            &app,
            "/v1/jobs/rbf",
            json!({ "txid": txid, "change_vout": 1 }),
        )
        .await;
        let uri = format!("/v1/jobs/{}/submit", created["job_id"].as_str().unwrap());

        let (status, body) = post_json(&app, &uri, json!({ "signed_psbt": "garbage" })).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body["error"].as_str().unwrap().contains("not fully signed"));

        let (status, _) = post_json(
            &app,
            &uri,
            json!({ "signed_psbt": "signed:unsigned-rbf-2860" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn cpfp_job_prices_the_child_to_reach_the_target() {
        let txid = "a".repeat(64);
        let body = json!({ "txid": txid, "vout": 0, "destination": "bcrt1qexample" });
        let (status, created) = post_json(&app(Ok(stuck(&txid))), "/v1/jobs/cpfp", body).await;
        assert_eq!(status, StatusCode::CREATED);
        // package 20 sat/vB * (141 + 110) vB = 5020 sat, minus the parent's 141 sat.
        assert_eq!(created["fee_sat"], 4879);
        assert_eq!(created["route"], "cpfp");
    }

    #[tokio::test]
    async fn jobs_are_refused_when_the_route_is_not_worth_it() {
        let txid = "a".repeat(64);
        // Over budget.
        let over = json!({ "txid": txid, "change_vout": 1, "max_budget_sat": 100 });
        let (status, body) = post_json(&app(Ok(stuck(&txid))), "/v1/jobs/rbf", over).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body["error"].as_str().unwrap().contains("budget"));

        // Already paying above the target: not stuck.
        let mut paid = stuck(&txid);
        paid.fee_sat = Some(5_000);
        let (status, body) = post_json(
            &app(Ok(paid)),
            "/v1/jobs/rbf",
            json!({ "txid": txid, "change_vout": 1 }),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body["error"].as_str().unwrap().contains("not stuck"));

        // Not pending.
        let mut confirmed = stuck(&txid);
        confirmed.status = TxStatus::Confirmed;
        let (status, _) = post_json(
            &app(Ok(confirmed)),
            "/v1/jobs/rbf",
            json!({ "txid": txid, "change_vout": 1 }),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn unknown_or_malformed_job_ids() {
        let app = app(Err("unused"));
        let (status, _) = get_json(&app, &format!("/v1/jobs/{}", Uuid::new_v4())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = get_json(&app, "/v1/jobs/not-a-uuid").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
