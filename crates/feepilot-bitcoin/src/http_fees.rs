//! Fee snapshots from a public fee API, for when running a node just to read estimates is not
//! worth it. Only fee estimates come from here: transaction analysis and PSBTs stay on Core RPC,
//! because a public API would see every txid and cannot build a PSBT.
//!
//! Numbers from these services are labelled `third_party` and are never presented as node data.

use std::time::Duration;

use feepilot_core::{FeeSnapshot, Network, FEE_TARGETS};
use serde_json::Value;

use crate::BitcoinError;

/// Which API shape to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeApiKind {
    /// Esplora `GET {base}/fee-estimates`: a JSON object keyed by confirmation target in blocks.
    /// Used by Blockstream, e.g. `https://blockstream.info/signet/api`.
    Esplora,
    /// mempool.space `GET {base}/v1/fees/recommended`: named levels, so the block targets are
    /// approximate. E.g. `https://mempool.space/signet/api`.
    MempoolSpace,
}

impl std::str::FromStr for FeeApiKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "esplora" => Ok(Self::Esplora),
            "mempool_space" | "mempool.space" | "mempool-space" => Ok(Self::MempoolSpace),
            other => Err(format!(
                "unknown fee API kind {other:?} (use esplora or mempool_space)"
            )),
        }
    }
}

impl FeeApiKind {
    fn path(self) -> &'static str {
        match self {
            Self::Esplora => "/fee-estimates",
            Self::MempoolSpace => "/v1/fees/recommended",
        }
    }

    /// The value written to `FeeSnapshot::source`.
    fn service(self) -> &'static str {
        match self {
            Self::Esplora => "esplora",
            Self::MempoolSpace => "mempool.space",
        }
    }
}

/// Responses larger than this are refused; real ones are well under a kilobyte.
const MAX_BODY_BYTES: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct HttpFeeSource {
    base: String,
    kind: FeeApiKind,
    network: Network,
    http: reqwest::Client,
}

impl HttpFeeSource {
    /// `base` is the API root, for example `https://blockstream.info/signet/api`.
    pub fn new(base: impl Into<String>, kind: FeeApiKind, network: Network) -> Self {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("feepilot/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("the HTTP client settings are valid");
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            kind,
            network,
            http,
        }
    }

    /// Fetch and parse. Any failure, including a response with no usable rate, is an error so
    /// the caller keeps its last good snapshot.
    pub async fn snapshot(&self, now: i64) -> Result<FeeSnapshot, BitcoinError> {
        let url = format!("{}{}", self.base, self.kind.path());
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BitcoinError::Transport(format!("fee API: {}", e.without_url())))?;
        if !resp.status().is_success() {
            return Err(BitcoinError::Transport(format!(
                "fee API answered {}",
                resp.status()
            )));
        }
        if resp
            .content_length()
            .is_some_and(|n| n as usize > MAX_BODY_BYTES)
        {
            return Err(BitcoinError::Malformed("fee API response too large".into()));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| BitcoinError::Transport(format!("fee API: {}", e.without_url())))?;
        if bytes.len() > MAX_BODY_BYTES {
            return Err(BitcoinError::Malformed("fee API response too large".into()));
        }
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|_| BitcoinError::Malformed("fee API did not return JSON".into()))?;
        let raw = match self.kind {
            FeeApiKind::Esplora => parse_esplora(&body),
            FeeApiKind::MempoolSpace => parse_mempool_space(&body),
        }?;
        let snapshot = FeeSnapshot::build_third_party(self.network, now, self.kind.service(), &raw);
        if !snapshot.has_any_rate() {
            return Err(BitcoinError::Malformed(
                "fee API returned no usable estimate".into(),
            ));
        }
        Ok(snapshot)
    }
}

type Raw = Vec<(u32, Option<f64>, bool)>;

fn rate(v: &Value) -> Option<f64> {
    v.as_f64().filter(|r| r.is_finite() && *r > 0.0)
}

/// Esplora gives the exact block count as the key, so nothing is approximated.
pub(crate) fn parse_esplora(body: &Value) -> Result<Raw, BitcoinError> {
    let map = body
        .as_object()
        .ok_or_else(|| BitcoinError::Malformed("fee API: expected a JSON object".into()))?;
    Ok(FEE_TARGETS
        .iter()
        .map(|&blocks| (blocks, map.get(&blocks.to_string()).and_then(rate), false))
        .collect())
}

/// mempool.space has named levels: fastest ~ next block, hour ~ 6 blocks, economy = the cheapest
/// level that still confirms. The mapping to our targets is approximate and flagged as such.
pub(crate) fn parse_mempool_space(body: &Value) -> Result<Raw, BitcoinError> {
    let map = body
        .as_object()
        .ok_or_else(|| BitcoinError::Malformed("fee API: expected a JSON object".into()))?;
    let level = |name: &str| map.get(name).and_then(rate);
    Ok(vec![
        (2, level("fastestFee"), true),
        (6, level("hourFee"), true),
        (144, level("economyFee"), true),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn esplora_uses_the_exact_block_keys() {
        let body = json!({ "1": 9.0, "2": 8.5, "6": 4.0, "144": 1.5, "1008": 0.1 });
        assert_eq!(
            parse_esplora(&body).unwrap(),
            vec![
                (2, Some(8.5), false),
                (6, Some(4.0), false),
                (144, Some(1.5), false)
            ]
        );
    }

    #[test]
    fn esplora_missing_or_bad_values_become_none() {
        let body = json!({ "2": "fast", "6": -1, "144": null });
        assert_eq!(
            parse_esplora(&body).unwrap(),
            vec![(2, None, false), (6, None, false), (144, None, false)]
        );
        assert!(parse_esplora(&json!([1, 2])).is_err());
        assert!(parse_esplora(&json!("x")).is_err());
    }

    #[test]
    fn mempool_space_levels_map_to_targets_and_are_flagged_approximate() {
        let body = json!({ "fastestFee": 5, "halfHourFee": 4, "hourFee": 3, "economyFee": 2, "minimumFee": 1 });
        assert_eq!(
            parse_mempool_space(&body).unwrap(),
            vec![
                (2, Some(5.0), true),
                (6, Some(3.0), true),
                (144, Some(2.0), true)
            ]
        );
    }

    #[test]
    fn mempool_space_missing_levels_become_none() {
        let raw = parse_mempool_space(&json!({ "fastestFee": 5 })).unwrap();
        assert_eq!(raw[0].1, Some(5.0));
        assert_eq!((raw[1].1, raw[2].1), (None, None));
        assert!(parse_mempool_space(&json!(null)).is_err());
    }

    #[test]
    fn kinds_parse_from_config_words() {
        assert_eq!("esplora".parse(), Ok(FeeApiKind::Esplora));
        assert_eq!("mempool_space".parse(), Ok(FeeApiKind::MempoolSpace));
        assert_eq!("Mempool.Space".parse(), Ok(FeeApiKind::MempoolSpace));
        assert!("bitcoin-core".parse::<FeeApiKind>().is_err());
    }

    /// A one-shot local HTTP server answering with `status` and `body`.
    async fn serve(status: &'static str, body: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let reply = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn fetches_and_labels_an_esplora_response() {
        let base = serve(
            "200 OK",
            json!({ "2": 7.0, "6": 3.0, "144": 1.0 }).to_string(),
        )
        .await;
        let src = HttpFeeSource::new(base, FeeApiKind::Esplora, Network::Signet);
        let snap = src.snapshot(42).await.unwrap();
        assert_eq!((snap.fetched_at, snap.source.as_str()), (42, "esplora"));
        assert_eq!(snap.network, Network::Signet);
        assert_eq!(snap.estimates[1].sat_per_vb, Some(3.0));
        assert!(snap.estimates.iter().all(|e| !e.approximate));
    }

    #[tokio::test]
    async fn a_server_error_is_a_failed_refresh() {
        let base = serve("503 Service Unavailable", "{}".into()).await;
        let src = HttpFeeSource::new(base, FeeApiKind::Esplora, Network::Signet);
        assert!(matches!(
            src.snapshot(1).await,
            Err(BitcoinError::Transport(_))
        ));
    }

    #[tokio::test]
    async fn a_response_with_no_usable_rate_is_an_error_not_an_empty_snapshot() {
        let base = serve("200 OK", json!({ "1008": 0.1 }).to_string()).await;
        let src = HttpFeeSource::new(base, FeeApiKind::Esplora, Network::Signet);
        assert!(matches!(
            src.snapshot(1).await,
            Err(BitcoinError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn non_json_and_oversized_responses_are_refused() {
        let base = serve("200 OK", "<html>nope</html>".into()).await;
        let src = HttpFeeSource::new(base, FeeApiKind::MempoolSpace, Network::Signet);
        assert!(matches!(
            src.snapshot(1).await,
            Err(BitcoinError::Malformed(_))
        ));

        let big = format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_BODY_BYTES + 10));
        let base = serve("200 OK", big).await;
        let src = HttpFeeSource::new(base, FeeApiKind::Esplora, Network::Signet);
        assert!(matches!(
            src.snapshot(1).await,
            Err(BitcoinError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn an_unreachable_service_is_a_transport_error_without_leaking_the_url() {
        let src = HttpFeeSource::new("http://127.0.0.1:1", FeeApiKind::Esplora, Network::Signet);
        match src.snapshot(1).await {
            Err(BitcoinError::Transport(m)) => assert!(!m.contains("127.0.0.1:1"), "{m}"),
            other => panic!("expected a transport error, got {other:?}"),
        }
    }
}
