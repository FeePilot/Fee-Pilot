use std::sync::Arc;

use feepilot_bitcoin::CoreRpc;
use feepilot_store::PgStore;
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

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is not set");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("could not connect to the database");
    let store = PgStore::new(pool);
    store.migrate().await.expect("database migration failed");

    let policy = feepilot_core::FreshnessPolicy::from_env()
        .unwrap_or_else(|e| panic!("invalid configuration: {e}"));
    let config = feepilot_api::ApiConfig {
        policy,
        fee_refresh_cooldown_secs: env_number("FEEPILOT_FEE_REFRESH_MIN_SECS", 10),
    };
    let mut app = feepilot_api::router_with_config(Arc::new(rpc), Arc::new(store), config);
    // The web UI is optional; set FEEPILOT_WEB_DIR=web to serve it from the API.
    if let Ok(dir) = std::env::var("FEEPILOT_WEB_DIR") {
        // A built React app has an `app-shell.html`; the original static UI does not.
        if std::path::Path::new(&dir).join("app-shell.html").exists() {
            tracing::info!("serving the React app from {dir}");
            app = feepilot_api::with_spa(app, dir);
        } else {
            tracing::info!("serving the web UI from {dir}");
            app = feepilot_api::with_web(app, dir);
        }
    }

    // Per-client limit on /v1/ requests; 0 turns it off.
    let limit: u32 = env_number("FEEPILOT_RATE_LIMIT_PER_MIN", 120);
    app =
        feepilot_api::with_rate_limit(app, Arc::new(feepilot_api::RateLimiter::per_minute(limit)));
    app = feepilot_api::with_security_headers(app);

    let addr = std::env::var("FEEPILOT_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    tracing::info!("feepilot-api listening on {addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("serve");
}
