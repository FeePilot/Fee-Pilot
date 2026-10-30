//! Abuse guards: a per-client rate limiter for the API and security headers for everything.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderName, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde_json::json;

/// Token bucket per client address. A limit of 0 requests per minute turns it off.
pub struct RateLimiter {
    capacity: f64,
    refill_per_sec: f64,
    buckets: Mutex<HashMap<IpAddr, (f64, Instant)>>,
}

/// Past this many tracked clients, idle ones (full buckets) are dropped on the next check.
const PRUNE_ABOVE: usize = 10_000;

impl RateLimiter {
    pub fn per_minute(limit: u32) -> Self {
        Self {
            capacity: f64::from(limit),
            refill_per_sec: f64::from(limit) / 60.0,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Take one token. `Err` carries how long until one is available.
    pub fn check(&self, client: IpAddr, now: Instant) -> Result<(), Duration> {
        if self.capacity == 0.0 {
            return Ok(());
        }
        let mut buckets = self.buckets.lock().unwrap();
        if buckets.len() > PRUNE_ABOVE {
            let (cap, rate) = (self.capacity, self.refill_per_sec);
            buckets.retain(|_, (tokens, at)| {
                *tokens + now.saturating_duration_since(*at).as_secs_f64() * rate < cap
            });
        }
        let (tokens, at) = buckets.entry(client).or_insert((self.capacity, now));
        let refilled =
            *tokens + now.saturating_duration_since(*at).as_secs_f64() * self.refill_per_sec;
        *tokens = refilled.min(self.capacity);
        *at = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            Ok(())
        } else {
            Err(Duration::from_secs_f64(
                (1.0 - *tokens) / self.refill_per_sec,
            ))
        }
    }
}

/// The path without a leading `/net/<network>` segment.
fn strip_net(path: &str) -> &str {
    path.strip_prefix("/net/")
        .and_then(|rest| rest.find('/').map(|i| &rest[i..]))
        .unwrap_or(path)
}

fn is_api(path: &str) -> bool {
    let path = strip_net(path);
    path.starts_with("/v1/") || path.starts_with("/v2/")
}

async fn limit(State(rl): State<Arc<RateLimiter>>, req: Request, next: Next) -> Response {
    if !is_api(req.uri().path()) {
        return next.run(req).await;
    }
    let v2 = strip_net(req.uri().path()).starts_with("/v2/");
    // Behind a reverse proxy every request shares the proxy's address; the operator should
    // limit there as well. Forwarded headers are not trusted because clients can set them.
    let client = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED), |c| c.0.ip());
    match rl.check(client, Instant::now()) {
        Ok(()) => next.run(req).await,
        Err(wait) => {
            let secs = wait.as_secs().max(1);
            let mut res = if v2 {
                crate::envelope::error_response(
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate_limited",
                    "Too many requests. Please slow down and try again shortly.",
                )
            } else {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({ "error": "too many requests, slow down" })),
                )
                    .into_response()
            };
            if let Ok(v) = HeaderValue::from_str(&secs.to_string()) {
                res.headers_mut().insert(header::RETRY_AFTER, v);
            }
            res
        }
    }
}

/// Reject clients that send too many `/v1/` or `/v2/` requests. Static files are not limited.
pub fn with_rate_limit(app: Router, limiter: Arc<RateLimiter>) -> Router {
    app.layer(middleware::from_fn_with_state(limiter, limit))
}

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
                   img-src 'self' data:; connect-src 'self'; object-src 'none'; \
                   base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async fn headers(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let api = is_api(&path);
    // The app shell and the API are not for search engines; marketing pages are.
    let private = api || path == "/app" || path.starts_with("/app/");
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    if private {
        h.insert(
            HeaderName::from_static("x-robots-tag"),
            HeaderValue::from_static("noindex, nofollow"),
        );
    }
    if api {
        // Responses can carry PSBTs and notes; never let a shared cache keep them.
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}

/// Add security headers to every response, and `no-store` to API responses.
pub fn with_security_headers(app: Router) -> Router {
    app.layer(middleware::from_fn(headers))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(n: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, n))
    }

    #[test]
    fn bursts_up_to_the_limit_then_refuses_with_a_wait() {
        let rl = RateLimiter::per_minute(3);
        let t0 = Instant::now();
        assert!((0..3).all(|_| rl.check(ip(1), t0).is_ok()));
        let wait = rl.check(ip(1), t0).unwrap_err();
        assert_eq!(wait, Duration::from_secs(20)); // 3 per minute = 1 token per 20 s
    }

    #[test]
    fn tokens_come_back_over_time() {
        let rl = RateLimiter::per_minute(60);
        let t0 = Instant::now();
        for _ in 0..60 {
            rl.check(ip(1), t0).unwrap();
        }
        assert!(rl.check(ip(1), t0).is_err());
        assert!(rl.check(ip(1), t0 + Duration::from_secs(1)).is_ok());
        assert!(rl.check(ip(1), t0 + Duration::from_secs(1)).is_err());
    }

    #[test]
    fn clients_are_limited_separately() {
        let rl = RateLimiter::per_minute(1);
        let t0 = Instant::now();
        assert!(rl.check(ip(1), t0).is_ok());
        assert!(rl.check(ip(1), t0).is_err());
        assert!(rl.check(ip(2), t0).is_ok());
    }

    #[test]
    fn zero_disables_the_limit() {
        let rl = RateLimiter::per_minute(0);
        let t0 = Instant::now();
        assert!((0..1000).all(|_| rl.check(ip(1), t0).is_ok()));
    }
}
