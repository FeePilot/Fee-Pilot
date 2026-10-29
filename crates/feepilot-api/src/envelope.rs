//! The `/v2` response envelope: every body is `{ "status", "message", "body" }`.
//!
//! `status` mirrors the HTTP status code (codes stay truthful, so caches, monitors and the rate
//! limiter keep working). The real payload is `body`. On errors `body` is `{ "code": ... }` with
//! a stable machine-readable code, and `message` is safe to show to a person.
//!
//! The handlers are shared with `/v1`; this layer only rewraps their responses, so `/v1` is
//! unchanged.

use axum::{
    body::{to_bytes, Body},
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
};
use serde_json::{json, Value};

/// Handlers set this header on errors; the layer turns it into `body.code` and removes it.
pub(crate) const CODE_HEADER: &str = "x-feepilot-code";
/// A handler may set this on a success to replace the default `"ok"` message.
pub(crate) const MESSAGE_HEADER: &str = "x-feepilot-message";

const MAX_BODY: usize = 4 * 1024 * 1024;

/// A person-facing message for upstream failures, which `/v1` reports with one generic string.
fn upstream_message(code: &str) -> Option<&'static str> {
    match code {
        "node_unreachable" => Some("The Bitcoin node could not be reached."),
        "node_misconfigured" => {
            Some("The Bitcoin node rejected our credentials or lacks a needed option.")
        }
        "node_bad_response" => Some("The Bitcoin node sent a response FeePilot could not read."),
        "node_error" => Some("The Bitcoin node reported an error."),
        _ => None,
    }
}

/// The default code for an error status that no handler labelled (unknown route, bad method,
/// body rejected by an extractor, rate limit).
fn default_code(status: StatusCode) -> &'static str {
    match status {
        StatusCode::BAD_REQUEST => "bad_request",
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::METHOD_NOT_ALLOWED => "method_not_allowed",
        StatusCode::UNPROCESSABLE_ENTITY => "unprocessable",
        StatusCode::TOO_MANY_REQUESTS => "rate_limited",
        StatusCode::PAYLOAD_TOO_LARGE => "payload_too_large",
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "unsupported_media_type",
        s if s.is_server_error() => "internal_error",
        _ => "error",
    }
}

/// Build an envelope response from parts.
pub(crate) fn envelope_response(status: StatusCode, message: &str, body: Value) -> Response {
    let payload = json!({ "status": status.as_u16(), "message": message, "body": body });
    let mut res = Response::new(Body::from(payload.to_string()));
    *res.status_mut() = status;
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    res
}

/// An error envelope with a stable code.
pub(crate) fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    envelope_response(status, message, json!({ "code": code }))
}

/// Middleware: rewrap a `/v1`-shaped response into the envelope.
pub(crate) async fn wrap(req: Request, next: Next) -> Response {
    let res = next.run(req).await;
    let (mut parts, body) = res.into_parts();
    let status = parts.status;
    let code = parts
        .headers
        .remove(CODE_HEADER)
        .and_then(|v| v.to_str().ok().map(str::to_owned));
    let custom_message = parts
        .headers
        .remove(MESSAGE_HEADER)
        .and_then(|v| v.to_str().ok().map(str::to_owned));
    let bytes = match to_bytes(body, MAX_BODY).await {
        Ok(b) => b,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "The response was too large to send.",
            )
        }
    };

    let mut out = if status.is_success() {
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        envelope_response(status, custom_message.as_deref().unwrap_or("ok"), value)
    } else {
        let code = code.unwrap_or_else(|| default_code(status).to_string());
        // `/v1` errors are `{ "error": message }`; extractor rejections are plain text.
        let raw = match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => v["error"].as_str().map(str::to_owned),
            Err(_) => {
                Some(String::from_utf8_lossy(&bytes).trim().to_string()).filter(|s| !s.is_empty())
            }
        };
        let message = upstream_message(&code)
            .map(str::to_owned)
            .or(raw)
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("error").to_string());
        envelope_response(status, &message, json!({ "code": code }))
    };
    // Keep headers a handler or layer set (Retry-After and so on), except body-framing ones.
    for (name, value) in parts.headers.iter() {
        if name != header::CONTENT_LENGTH && name != header::CONTENT_TYPE {
            out.headers_mut().insert(name.clone(), value.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{middleware, routing::get, Json, Router};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn run(app: &Router, uri: &str) -> (StatusCode, Value) {
        let res = app
            .clone()
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn app() -> Router {
        Router::new()
            .route("/ok", get(|| async { Json(json!({ "x": 1 })) }))
            .route(
                "/degraded",
                get(|| async {
                    (
                        [(MESSAGE_HEADER, "saved copy shown")],
                        Json(json!({ "x": 2 })),
                    )
                }),
            )
            .route(
                "/bad",
                get(|| async {
                    (
                        StatusCode::BAD_GATEWAY,
                        [(CODE_HEADER, "node_unreachable")],
                        Json(json!({ "error": "generic" })),
                    )
                }),
            )
            .route(
                "/teapot",
                get(|| async { (StatusCode::IM_A_TEAPOT, "plain words") }),
            )
            .layer(middleware::from_fn(wrap))
    }

    #[tokio::test]
    async fn success_is_wrapped_with_ok() {
        let (status, v) = run(&app(), "/ok").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            v,
            json!({ "status": 200, "message": "ok", "body": { "x": 1 } })
        );
    }

    #[tokio::test]
    async fn a_handler_can_replace_the_success_message() {
        let (_, v) = run(&app(), "/degraded").await;
        assert_eq!(v["message"], "saved copy shown");
        assert_eq!(v["body"]["x"], 2);
    }

    #[tokio::test]
    async fn errors_keep_their_status_and_get_a_code_and_a_person_message() {
        let (status, v) = run(&app(), "/bad").await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(v["status"], 502);
        assert_eq!(v["body"], json!({ "code": "node_unreachable" }));
        assert_eq!(v["message"], "The Bitcoin node could not be reached.");
    }

    #[tokio::test]
    async fn unlabelled_errors_get_a_default_code_and_plain_text_becomes_the_message() {
        let (status, v) = run(&app(), "/missing").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(v["body"]["code"], "not_found");
        assert_eq!(v["message"], "Not Found");
        let (_, t) = run(&app(), "/teapot").await;
        assert_eq!(t["message"], "plain words");
        assert_eq!(t["body"]["code"], "error");
    }

    #[tokio::test]
    async fn internal_headers_never_reach_the_client() {
        let res = app()
            .oneshot(Request::get("/bad").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(res.headers().get(CODE_HEADER).is_none());
        assert_eq!(res.headers()[header::CONTENT_TYPE], "application/json");
    }
}
