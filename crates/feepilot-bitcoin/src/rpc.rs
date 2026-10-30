//! Bitcoin Core JSON-RPC client implementing [`BitcoinDataSource`].

use feepilot_core::{
    btc_per_kvb_to_sat_per_vb, FeeSnapshot, Network, Outpoint, TxAnalysis, TxOutput, TxStatus,
    FEE_TARGETS,
};
use serde_json::{json, Value};

use crate::{BitcoinDataSource, BitcoinError, FeeApiKind, FeeSource, HttpFeeSource};

/// JSON-RPC error code for "not found" style lookups.
const RPC_INVALID_ADDRESS_OR_KEY: i64 = -5;

#[derive(Clone)]
pub struct CoreRpc {
    url: String,
    network: Network,
    auth: Option<(String, String)>,
    wallet: Option<String>,
    /// sat/vB used when the node has no fee estimate (always the case on regtest).
    fallback_fee_rate: Option<f64>,
    /// When set, fee snapshots come from this public API instead of the node.
    fee_api: Option<HttpFeeSource>,
    http: reqwest::Client,
}

impl CoreRpc {
    pub fn new(url: impl Into<String>, network: Network) -> Self {
        Self {
            url: url.into(),
            network,
            auth: None,
            wallet: None,
            fallback_fee_rate: None,
            fee_api: None,
            http: reqwest::Client::new(),
        }
    }

    /// Build from `BITCOIN_RPC_URL`, `BITCOIN_RPC_USER`, `BITCOIN_RPC_PASS`,
    /// `FEEPILOT_NETWORK` and the optional `FEEPILOT_FALLBACK_FEE_RATE` (sat/vB).
    pub fn from_env() -> Result<Self, String> {
        let var = |k: &str| std::env::var(k).map_err(|_| format!("{k} is not set"));
        let network = var("FEEPILOT_NETWORK")?.parse::<Network>()?;
        let mut rpc = Self::new(var("BITCOIN_RPC_URL")?, network)
            .with_auth(var("BITCOIN_RPC_USER")?, var("BITCOIN_RPC_PASS")?);
        if let Ok(rate) = std::env::var("FEEPILOT_FALLBACK_FEE_RATE") {
            let rate = rate
                .parse::<f64>()
                .map_err(|e| format!("FEEPILOT_FALLBACK_FEE_RATE: {e}"))?;
            rpc = rpc.with_fallback_fee_rate(rate);
        }
        if let Ok(base) = std::env::var("FEEPILOT_FEE_API_URL") {
            let kind = match std::env::var("FEEPILOT_FEE_API_KIND") {
                Ok(k) => k
                    .parse::<FeeApiKind>()
                    .map_err(|e| format!("FEEPILOT_FEE_API_KIND: {e}"))?,
                Err(_) => FeeApiKind::Esplora,
            };
            if !(base.starts_with("https://") || base.starts_with("http://")) {
                return Err("FEEPILOT_FEE_API_URL must start with https:// or http://".into());
            }
            rpc = rpc.with_fee_api(HttpFeeSource::new(base, kind, network));
        }
        Ok(rpc)
    }

    /// Clients for the extra networks named in the environment, beyond the primary one from
    /// [`CoreRpc::from_env`]. A network is on when `FEEPILOT_<NETWORK>_RPC_URL` is set (for
    /// example `FEEPILOT_SIGNET_RPC_URL`, with `_RPC_USER` and `_RPC_PASS`). No fallback fee
    /// rate is applied, so a missing estimate shows as none. A network equal to the primary one
    /// is ignored.
    pub fn extra_from_env(primary: Network) -> Result<Vec<Self>, String> {
        let mut out = Vec::new();
        for (network, prefix) in [
            (Network::Regtest, "FEEPILOT_REGTEST"),
            (Network::Signet, "FEEPILOT_SIGNET"),
            (Network::Testnet, "FEEPILOT_TESTNET"),
            (Network::Mainnet, "FEEPILOT_MAINNET"),
        ] {
            if network == primary {
                continue;
            }
            let Ok(url) = std::env::var(format!("{prefix}_RPC_URL")) else {
                continue;
            };
            let var = |k: &str| {
                std::env::var(format!("{prefix}_{k}"))
                    .map_err(|_| format!("{prefix}_{k} is not set"))
            };
            out.push(Self::new(url, network).with_auth(var("RPC_USER")?, var("RPC_PASS")?));
        }
        Ok(out)
    }

    /// Take fee snapshots from a public fee API instead of the node. Analysis and PSBT
    /// building still use the node.
    pub fn with_fee_api(mut self, api: HttpFeeSource) -> Self {
        self.fee_api = Some(api);
        self
    }

    pub fn with_auth(mut self, user: impl Into<String>, pass: impl Into<String>) -> Self {
        self.auth = Some((user.into(), pass.into()));
        self
    }

    pub fn with_fallback_fee_rate(mut self, sat_per_vb: f64) -> Self {
        self.fallback_fee_rate = Some(sat_per_vb);
        self
    }

    /// A client whose calls go to the given wallet (`/wallet/<name>`).
    pub fn with_wallet(mut self, name: impl Into<String>) -> Self {
        self.wallet = Some(name.into());
        self
    }

    /// Raw JSON-RPC call. `params` is a JSON array or object.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, BitcoinError> {
        let url = match &self.wallet {
            Some(w) => format!("{}/wallet/{w}", self.url.trim_end_matches('/')),
            None => self.url.clone(),
        };
        let mut req = self.http.post(url).json(
            &json!({ "jsonrpc": "1.0", "id": "feepilot", "method": method, "params": params }),
        );
        if let Some((user, pass)) = &self.auth {
            req = req.basic_auth(user, Some(pass));
        }
        let resp = req
            .send()
            .await
            .map_err(|e| BitcoinError::Transport(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(BitcoinError::Unauthorized);
        }
        // Core reports RPC errors with a non-2xx status but a JSON body, so parse regardless.
        let mut body: Value = resp
            .json()
            .await
            .map_err(|e| BitcoinError::Transport(e.to_string()))?;
        if let Some(err) = body.get("error").filter(|e| !e.is_null()) {
            return Err(BitcoinError::Rpc {
                code: err["code"].as_i64().unwrap_or(0),
                message: err["message"].as_str().unwrap_or_default().to_string(),
            });
        }
        Ok(body["result"].take())
    }

    /// Next-block fee estimate in sat/vB, falling back to the configured rate.
    async fn target_fee_rate(&self) -> Result<Option<f64>, BitcoinError> {
        let est = self.call("estimatesmartfee", json!([2])).await?;
        Ok(parse_fee_estimate(&est).or(self.fallback_fee_rate))
    }
}

impl FeeSource for CoreRpc {
    async fn fee_snapshot(&self, now: i64) -> Result<FeeSnapshot, BitcoinError> {
        if let Some(api) = &self.fee_api {
            return api.snapshot(now).await;
        }
        let mut raw = Vec::with_capacity(FEE_TARGETS.len());
        for blocks in FEE_TARGETS {
            let est = self.call("estimatesmartfee", json!([blocks])).await?;
            raw.push((blocks, parse_fee_estimate(&est)));
        }
        let pool = self.call("getmempoolinfo", json!([])).await?;
        let floor = |k: &str| pool[k].as_f64().and_then(btc_per_kvb_to_sat_per_vb);
        Ok(FeeSnapshot::build(
            self.network,
            now,
            &raw,
            floor("minrelaytxfee"),
            floor("mempoolminfee"),
            self.fallback_fee_rate,
        ))
    }
}

impl BitcoinDataSource for CoreRpc {
    fn network(&self) -> Network {
        self.network
    }

    async fn analyze(&self, txid: &str) -> Result<TxAnalysis, BitcoinError> {
        let target = self.target_fee_rate().await?;

        match self.call("getmempoolentry", json!([txid])).await {
            Ok(entry) => return parse_mempool_entry(txid, self.network, &entry, target),
            Err(BitcoinError::Rpc { code, .. }) if code == RPC_INVALID_ADDRESS_OR_KEY => {}
            Err(e) => return Err(e),
        }

        match self.call("getrawtransaction", json!([txid, 2])).await {
            Ok(tx) => parse_confirmed(txid, self.network, &tx, target),
            Err(BitcoinError::Rpc { code, message }) if code == RPC_INVALID_ADDRESS_OR_KEY => {
                if message.contains("-txindex") {
                    return Err(BitcoinError::Config(
                        "confirmed transactions need the node to run with -txindex=1",
                    ));
                }
                Ok(not_found(txid, self.network, target))
            }
            Err(e) => Err(e),
        }
    }

    async fn tx_inputs(&self, txid: &str) -> Result<Vec<Outpoint>, BitcoinError> {
        match self.call("getrawtransaction", json!([txid, 1])).await {
            Ok(tx) => parse_inputs(&tx),
            Err(BitcoinError::Rpc { code, .. }) if code == RPC_INVALID_ADDRESS_OR_KEY => Err(
                BitcoinError::InvalidRequest("transaction not found on this node".into()),
            ),
            Err(e) => Err(e),
        }
    }

    async fn tx_outputs(&self, txid: &str) -> Result<Vec<TxOutput>, BitcoinError> {
        let tx = match self.call("getrawtransaction", json!([txid, 1])).await {
            Ok(tx) => tx,
            Err(BitcoinError::Rpc { code, .. }) if code == RPC_INVALID_ADDRESS_OR_KEY => {
                return Err(BitcoinError::InvalidRequest(
                    "transaction not found on this node".into(),
                ))
            }
            Err(e) => return Err(e),
        };
        let mut outputs = parse_outputs(&tx)?;
        let wallets = self.wallet_clients().await;
        for o in &mut outputs {
            let Some(addr) = &o.address else { continue };
            let (mut asked, mut mine, mut change) = (false, false, false);
            for w in &wallets {
                if let Ok(info) = w.call("getaddressinfo", json!([addr])).await {
                    asked = true;
                    mine |= info["ismine"].as_bool().unwrap_or(false);
                    change |= info["ischange"].as_bool().unwrap_or(false);
                }
            }
            if asked {
                o.is_mine = Some(mine);
                o.is_change = Some(change);
            }
        }
        Ok(outputs)
    }

    async fn find_spenders(
        &self,
        outpoints: &[Outpoint],
    ) -> Result<Vec<Option<String>>, BitcoinError> {
        if outpoints.is_empty() {
            return Ok(vec![]);
        }
        let query: Vec<Value> = outpoints
            .iter()
            .map(|o| json!({ "txid": o.txid, "vout": o.vout }))
            .collect();
        let res = self.call("gettxspendingprevout", json!([query])).await?;
        parse_spenders(&res, outpoints.len())
    }
}

impl CoreRpc {
    /// One client per wallet loaded on the node, or just the configured wallet. Empty when
    /// the node cannot list its wallets, so ownership stays unknown instead of guessed.
    async fn wallet_clients(&self) -> Vec<CoreRpc> {
        if self.wallet.is_some() {
            return vec![self.clone()];
        }
        match self.call("listwallets", json!([])).await {
            Ok(Value::Array(names)) => names
                .iter()
                .filter_map(Value::as_str)
                .map(|n| self.clone().with_wallet(n))
                .collect(),
            _ => Vec::new(),
        }
    }
}

fn parse_outputs(tx: &Value) -> Result<Vec<TxOutput>, BitcoinError> {
    tx["vout"]
        .as_array()
        .ok_or_else(|| malformed("vout"))?
        .iter()
        .map(|o| {
            Ok(TxOutput {
                vout: o["n"].as_u64().ok_or_else(|| malformed("vout.n"))? as u32,
                value_sat: btc_to_sat(o["value"].as_f64().ok_or_else(|| malformed("vout.value"))?),
                address: o["scriptPubKey"]["address"].as_str().map(str::to_string),
                is_mine: None,
                is_change: None,
            })
        })
        .collect()
}

fn parse_inputs(tx: &Value) -> Result<Vec<Outpoint>, BitcoinError> {
    tx["vin"]
        .as_array()
        .ok_or_else(|| malformed("vin"))?
        .iter()
        .map(|i| {
            Ok(Outpoint {
                txid: i["txid"]
                    .as_str()
                    .ok_or_else(|| malformed("vin.txid"))?
                    .to_string(),
                vout: i["vout"].as_u64().ok_or_else(|| malformed("vin.vout"))? as u32,
            })
        })
        .collect()
}

fn parse_spenders(res: &Value, expected: usize) -> Result<Vec<Option<String>>, BitcoinError> {
    let rows = res.as_array().filter(|r| r.len() == expected);
    rows.ok_or_else(|| malformed("gettxspendingprevout"))
        .map(|rows| {
            rows.iter()
                .map(|r| r["spendingtxid"].as_str().map(str::to_string))
                .collect()
        })
}

fn not_found(txid: &str, network: Network, target: Option<f64>) -> TxAnalysis {
    TxAnalysis {
        txid: txid.to_string(),
        network,
        status: TxStatus::NotFound,
        confirmations: 0,
        vsize: 0,
        fee_sat: None,
        signals_rbf: None,
        unconfirmed_ancestors: 0,
        unconfirmed_descendants: 0,
        target_fee_rate: target,
    }
}

pub(crate) fn btc_to_sat(btc: f64) -> u64 {
    (btc * 1e8).round() as u64
}

/// `estimatesmartfee` returns BTC/kvB under `feerate`, or `errors` when it has no data.
fn parse_fee_estimate(v: &Value) -> Option<f64> {
    v["feerate"].as_f64().and_then(btc_per_kvb_to_sat_per_vb)
}

fn malformed(what: &str) -> BitcoinError {
    BitcoinError::Malformed(what.to_string())
}

fn parse_mempool_entry(
    txid: &str,
    network: Network,
    e: &Value,
    target: Option<f64>,
) -> Result<TxAnalysis, BitcoinError> {
    let count = |k: &str| e[k].as_u64().ok_or_else(|| malformed(k));
    Ok(TxAnalysis {
        txid: txid.to_string(),
        network,
        status: TxStatus::Pending,
        confirmations: 0,
        vsize: e["vsize"].as_u64().ok_or_else(|| malformed("vsize"))?,
        fee_sat: Some(btc_to_sat(
            e["fees"]["base"]
                .as_f64()
                .ok_or_else(|| malformed("fees.base"))?,
        )),
        signals_rbf: e["bip125-replaceable"].as_bool(),
        // Core counts the transaction itself in both totals.
        unconfirmed_ancestors: count("ancestorcount")?.saturating_sub(1) as u32,
        unconfirmed_descendants: count("descendantcount")?.saturating_sub(1) as u32,
        target_fee_rate: target,
    })
}

fn parse_confirmed(
    txid: &str,
    network: Network,
    tx: &Value,
    target: Option<f64>,
) -> Result<TxAnalysis, BitcoinError> {
    let confirmations = tx["confirmations"].as_u64().unwrap_or(0) as u32;
    Ok(TxAnalysis {
        txid: txid.to_string(),
        network,
        status: if confirmations > 0 {
            TxStatus::Confirmed
        } else {
            TxStatus::NotFound
        },
        confirmations,
        vsize: tx["vsize"].as_u64().ok_or_else(|| malformed("vsize"))?,
        // Only present when the node still has undo data for the block.
        fee_sat: tx["fee"].as_f64().map(btc_to_sat),
        signals_rbf: None,
        unconfirmed_ancestors: 0,
        unconfirmed_descendants: 0,
        target_fee_rate: target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_btc_to_sats_without_float_drift() {
        assert_eq!(btc_to_sat(0.00000141), 141);
        assert_eq!(btc_to_sat(0.0000282), 2820);
        assert_eq!(btc_to_sat(1.0), 100_000_000);
    }

    #[test]
    fn fee_estimate_is_sat_per_vb() {
        // 0.0002 BTC/kvB = 20 sat/vB
        assert_eq!(
            parse_fee_estimate(&json!({ "feerate": 0.0002, "blocks": 2 })),
            Some(20.0)
        );
        assert_eq!(
            parse_fee_estimate(&json!({ "errors": ["Insufficient data"], "blocks": 2 })),
            None
        );
    }

    #[test]
    fn mempool_entry_becomes_pending_analysis() {
        let entry = json!({
            "vsize": 141, "fees": { "base": 0.00000141 },
            "ancestorcount": 2, "descendantcount": 3, "bip125-replaceable": true
        });
        let a = parse_mempool_entry(&"a".repeat(64), Network::Regtest, &entry, Some(10.0)).unwrap();
        assert_eq!(a.status, TxStatus::Pending);
        assert_eq!((a.vsize, a.fee_sat), (141, Some(141)));
        assert_eq!((a.unconfirmed_ancestors, a.unconfirmed_descendants), (1, 2));
        assert_eq!(a.signals_rbf, Some(true));
        assert_eq!(a.fee_rate(), Some(1.0));
    }

    #[test]
    fn confirmed_tx_keeps_depth_and_optional_fee() {
        let tx = json!({ "vsize": 150, "confirmations": 3 });
        let a = parse_confirmed(&"b".repeat(64), Network::Regtest, &tx, None).unwrap();
        assert_eq!(a.status, TxStatus::Confirmed);
        assert_eq!((a.confirmations, a.fee_sat), (3, None));
    }

    #[test]
    fn inputs_and_spenders_are_parsed_in_order() {
        let tx = json!({ "vin": [{ "txid": "aa", "vout": 1 }, { "txid": "bb", "vout": 0 }] });
        let inputs = parse_inputs(&tx).unwrap();
        assert_eq!(
            inputs[0],
            Outpoint {
                txid: "aa".into(),
                vout: 1
            }
        );
        assert_eq!(inputs.len(), 2);

        let res =
            json!([{ "txid": "aa", "vout": 1, "spendingtxid": "cc" }, { "txid": "bb", "vout": 0 }]);
        assert_eq!(
            parse_spenders(&res, 2).unwrap(),
            vec![Some("cc".to_string()), None]
        );
        assert!(
            parse_spenders(&res, 3).is_err(),
            "length mismatch is an error"
        );
    }

    #[test]
    fn outputs_are_parsed_with_unknown_ownership() {
        let tx = json!({ "vout": [
            { "n": 0, "value": 0.00025, "scriptPubKey": { "address": "bcrt1qa" } },
            { "n": 1, "value": 0.0, "scriptPubKey": { "type": "nulldata" } }
        ]});
        let outs = parse_outputs(&tx).unwrap();
        assert_eq!((outs[0].vout, outs[0].value_sat), (0, 25_000));
        assert_eq!(outs[0].address.as_deref(), Some("bcrt1qa"));
        assert_eq!(outs[1].address, None);
        assert!(outs
            .iter()
            .all(|o| o.is_mine.is_none() && o.is_change.is_none()));
        assert!(parse_outputs(&json!({})).is_err());
    }

    #[test]
    fn malformed_entry_is_an_error_not_a_guess() {
        assert!(parse_mempool_entry("x", Network::Regtest, &json!({}), None).is_err());
    }

    #[tokio::test]
    async fn with_a_fee_api_the_snapshot_never_asks_the_node() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let body = r#"{"2":6.0,"6":3.0,"144":1.0}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(reply.as_bytes()).await;
        });
        // The node address is dead: any RPC call would fail the test.
        let rpc = CoreRpc::new("http://127.0.0.1:1", Network::Signet)
            .with_fallback_fee_rate(20.0)
            .with_fee_api(HttpFeeSource::new(
                format!("http://{addr}"),
                FeeApiKind::Esplora,
                Network::Signet,
            ));
        let snap = rpc.fee_snapshot(5).await.unwrap();
        assert_eq!(snap.source, "esplora");
        assert_eq!(snap.estimates[0].sat_per_vb, Some(6.0));
    }
}
