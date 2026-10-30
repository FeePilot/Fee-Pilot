use std::time::Duration;

use feepilot_bitcoin::CoreRpc;
use feepilot_store::PgStore;
use feepilot_tracker::{Notifier, Tracker, DEFAULT_SETTLE_DEPTH};
use sqlx::postgres::PgPoolOptions;

fn env_number<T: std::str::FromStr>(key: &str, default: T) -> T {
    match std::env::var(key) {
        Ok(v) => v
            .parse()
            .unwrap_or_else(|_| panic!("{key} must be a number")),
        Err(_) => default,
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let rpc = CoreRpc::from_env().unwrap_or_else(|e| panic!("invalid configuration: {e}"));
    let extra = CoreRpc::extra_from_env(feepilot_bitcoin::BitcoinDataSource::network(&rpc))
        .unwrap_or_else(|e| panic!("invalid configuration: {e}"));
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is not set");
    let pool = PgPoolOptions::new()
        .max_connections(3)
        .connect(&database_url)
        .await
        .expect("could not connect to the database");
    let store = PgStore::new(pool);
    store.migrate().await.expect("database migration failed");

    let interval = Duration::from_secs(env_number("FEEPILOT_TRACK_INTERVAL_SECS", 30));
    let settle_depth = env_number("FEEPILOT_SETTLE_DEPTH", DEFAULT_SETTLE_DEPTH);
    let notifier = std::sync::Arc::new(Notifier::new(std::env::var("FEEPILOT_WEBHOOK_URL").ok()));
    // Old fee history, order notes and finished jobs are deleted; 0 keeps everything.
    let retention_days: u32 = env_number("FEEPILOT_RETENTION_DAYS", 30);
    let purger = store.clone();
    // One tracker per network, each asking only its own node about its own network's jobs.
    let trackers: Vec<_> = std::iter::once(rpc)
        .chain(extra)
        .map(|node| Tracker::new(node, store.clone(), settle_depth))
        .collect();

    tracing::info!(
        "feepilot-tracker started for {} network(s) (every {interval:?}, settles at {settle_depth} confirmations)",
        trackers.len()
    );
    tokio::select! {
        _ = async {
            let mut set = tokio::task::JoinSet::new();
            for tracker in trackers {
                let notifier = notifier.clone();
                set.spawn(async move { tracker.run(interval, &notifier).await });
            }
            while set.join_next().await.is_some() {}
        } => {}
        _ = async {
            loop {
                match purger.purge_older_than(retention_days).await {
                    Ok(r) if r != Default::default() => tracing::info!(
                        "retention: removed {} fee rows, {} orders, {} finished jobs",
                        r.fee_rows, r.orders, r.jobs
                    ),
                    Ok(_) => {}
                    Err(e) => tracing::error!("retention purge failed: {e}"),
                }
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        } => {}
        _ = tokio::signal::ctrl_c() => tracing::info!("shutting down"),
    }
}
