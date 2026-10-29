//! Unsigned-PSBT construction and signed-PSBT verification over Bitcoin Core RPC.
//!
//! Candidates are built from public chain data only, so FeePilot never needs the user's
//! wallet or keys. `utxoupdatepsbt` attaches the UTXO data a signer needs.

use feepilot_core::fees::{min_rbf_fee, RBF_SIZE_MARGIN_VB};
use feepilot_core::strategy::DUST_LIMIT_SAT;
use serde_json::{json, Value};

use crate::rpc::btc_to_sat;
use crate::{BitcoinError, CoreRpc, CpfpRequest, RbfRequest, SigningBoundary, UnsignedCandidate};

/// Highest sequence that still signals BIP125 replaceability.
const MAX_RBF_SEQUENCE: u64 = 0xffff_fffd;

// JSON-RPC codes meaning "the node refused this transaction".
const RPC_DESERIALIZATION_ERROR: i64 = -22;
const RPC_VERIFY_ERROR: i64 = -25;
const RPC_VERIFY_REJECTED: i64 = -26;
const RPC_VERIFY_ALREADY_IN_CHAIN: i64 = -27;
const RPC_NOT_FOUND: i64 = -5;

fn invalid<T>(msg: impl Into<String>) -> Result<T, BitcoinError> {
    Err(BitcoinError::InvalidRequest(msg.into()))
}

fn malformed(what: &str) -> BitcoinError {
    BitcoinError::Malformed(what.to_string())
}

fn sat_to_btc(sat: u64) -> f64 {
    sat as f64 / 1e8
}

impl CoreRpc {
    /// Fee and vsize of a pending transaction, or an `InvalidRequest` if it is not in the mempool.
    async fn pending_fee_and_vsize(&self, txid: &str) -> Result<(u64, u64), BitcoinError> {
        match self.call("getmempoolentry", json!([txid])).await {
            Ok(e) => Ok((
                btc_to_sat(e["fees"]["base"].as_f64().ok_or_else(|| malformed("fees.base"))?),
                e["vsize"].as_u64().ok_or_else(|| malformed("vsize"))?,
            )),
            Err(BitcoinError::Rpc { code, .. }) if code == RPC_NOT_FOUND => invalid(
                "the transaction is not in the node's mempool; only unconfirmed transactions can be recovered",
            ),
            Err(e) => Err(e),
        }
    }

    /// `createpsbt` followed by `utxoupdatepsbt`, mapping construction failures to user errors.
    async fn psbt_with_utxos(&self, params: Value) -> Result<String, BitcoinError> {
        let psbt = match self.call("createpsbt", params).await {
            Ok(v) => v,
            Err(BitcoinError::Rpc { message, .. }) => {
                return invalid(format!("could not construct the transaction: {message}"))
            }
            Err(e) => return Err(e),
        };
        let updated = self.call("utxoupdatepsbt", json!([psbt])).await?;
        updated
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| malformed("utxoupdatepsbt result"))
    }
}

impl SigningBoundary for CoreRpc {
    async fn build_rbf(&self, req: &RbfRequest) -> Result<UnsignedCandidate, BitcoinError> {
        let (old_fee, vsize) = self.pending_fee_and_vsize(&req.txid).await?;

        let floor = min_rbf_fee(old_fee, vsize + RBF_SIZE_MARGIN_VB, 0.0);
        if req.new_fee_sat < floor {
            return invalid(format!(
                "replacement fee {} sat is below the minimum of {floor} sat the network requires",
                req.new_fee_sat
            ));
        }
        let delta = req.new_fee_sat - old_fee;

        let tx = self.call("getrawtransaction", json!([req.txid, 1])).await?;
        let vin = tx["vin"].as_array().ok_or_else(|| malformed("vin"))?;
        let vout = tx["vout"].as_array().ok_or_else(|| malformed("vout"))?;

        let change = vout
            .iter()
            .find(|o| o["n"].as_u64() == Some(req.change_vout as u64))
            .map_or_else(
                || invalid(format!("the transaction has no output {}", req.change_vout)),
                Ok,
            )?;
        let change_sat = btc_to_sat(change["value"].as_f64().ok_or_else(|| malformed("value"))?);
        let new_change = match change_sat.checked_sub(delta) {
            Some(c) if c >= DUST_LIMIT_SAT => c,
            _ => {
                return invalid(format!(
                    "output {} holds {change_sat} sat, too little to pay the extra {delta} sat fee",
                    req.change_vout
                ))
            }
        };

        let inputs: Vec<Value> = vin
            .iter()
            .map(|i| {
                let seq = i["sequence"].as_u64().unwrap_or(MAX_RBF_SEQUENCE);
                Ok(json!({
                    "txid": i["txid"].as_str().ok_or_else(|| malformed("vin.txid"))?,
                    "vout": i["vout"].as_u64().ok_or_else(|| malformed("vin.vout"))?,
                    "sequence": seq.min(MAX_RBF_SEQUENCE),
                }))
            })
            .collect::<Result<_, BitcoinError>>()?;

        let outputs: Vec<Value> = vout
            .iter()
            .map(|o| {
                let n = o["n"].as_u64().ok_or_else(|| malformed("vout.n"))?;
                let Some(addr) = o["scriptPubKey"]["address"].as_str() else {
                    return invalid(format!(
                        "output {n} has no standard address (type {}); not supported yet",
                        o["scriptPubKey"]["type"].as_str().unwrap_or("unknown")
                    ));
                };
                let sat = if n == req.change_vout as u64 {
                    new_change
                } else {
                    btc_to_sat(o["value"].as_f64().ok_or_else(|| malformed("value"))?)
                };
                Ok(json!({ addr: sat_to_btc(sat) }))
            })
            .collect::<Result<_, BitcoinError>>()?;

        let locktime = tx["locktime"].as_u64().unwrap_or(0);
        let psbt_base64 = self
            .psbt_with_utxos(json!([inputs, outputs, locktime]))
            .await?;
        Ok(UnsignedCandidate {
            psbt_base64,
            fee_sat: req.new_fee_sat,
            description: format!(
                "Replaces {} paying {} sat (was {old_fee} sat); output {} reduced by {delta} sat.",
                req.txid, req.new_fee_sat, req.change_vout
            ),
        })
    }

    async fn build_cpfp(&self, req: &CpfpRequest) -> Result<UnsignedCandidate, BitcoinError> {
        self.pending_fee_and_vsize(&req.parent_txid).await?;

        let valid = self
            .call("validateaddress", json!([req.destination]))
            .await?;
        if valid["isvalid"] != json!(true) {
            return invalid("the destination address is not valid for this network");
        }

        let parent = self
            .call("getrawtransaction", json!([req.parent_txid, 1]))
            .await?;
        let output = parent["vout"]
            .as_array()
            .ok_or_else(|| malformed("vout"))?
            .iter()
            .find(|o| o["n"].as_u64() == Some(req.vout as u64))
            .map_or_else(
                || invalid(format!("the parent has no output {}", req.vout)),
                Ok,
            )?;
        let value = btc_to_sat(output["value"].as_f64().ok_or_else(|| malformed("value"))?);
        let remainder = match value.checked_sub(req.child_fee_sat) {
            Some(r) if r >= DUST_LIMIT_SAT => r,
            _ => {
                return invalid(format!(
                    "output {} holds {value} sat, too little to pay a {} sat child fee",
                    req.vout, req.child_fee_sat
                ))
            }
        };

        let psbt_base64 = self
            .psbt_with_utxos(json!([
                [{ "txid": req.parent_txid, "vout": req.vout }],
                [{ req.destination.as_str(): sat_to_btc(remainder) }],
            ]))
            .await?;
        Ok(UnsignedCandidate {
            psbt_base64,
            fee_sat: req.child_fee_sat,
            description: format!(
                "Child spending output {} of {}, paying {} sat to the network.",
                req.vout, req.parent_txid, req.child_fee_sat
            ),
        })
    }

    async fn broadcast_signed(
        &self,
        unsigned_psbt: &str,
        signed_psbt: &str,
    ) -> Result<String, BitcoinError> {
        let finalized = match self.call("finalizepsbt", json!([signed_psbt])).await {
            Ok(v) => v,
            Err(BitcoinError::Rpc { message, .. }) => {
                return invalid(format!("the signed PSBT could not be read: {message}"))
            }
            Err(e) => return Err(e),
        };
        let hex = match (finalized["complete"].as_bool(), finalized["hex"].as_str()) {
            (Some(true), Some(hex)) => hex.to_string(),
            _ => return invalid("the PSBT is not fully signed"),
        };

        let expected = self.call("decodepsbt", json!([unsigned_psbt])).await?;
        let actual = self.call("decoderawtransaction", json!([hex])).await?;
        if summarize(&expected["tx"])? != summarize(&actual)? {
            return invalid(
                "the signed transaction does not match the one FeePilot prepared (inputs or outputs differ)",
            );
        }

        match self.call("sendrawtransaction", json!([hex])).await {
            Ok(txid) => txid
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| malformed("sendrawtransaction result")),
            Err(BitcoinError::Rpc {
                code:
                    RPC_DESERIALIZATION_ERROR
                    | RPC_VERIFY_ERROR
                    | RPC_VERIFY_REJECTED
                    | RPC_VERIFY_ALREADY_IN_CHAIN,
                message,
            }) => Err(BitcoinError::Rejected(message)),
            Err(e) => Err(e),
        }
    }
}

/// What must not change between the unsigned and the signed transaction:
/// every input (outpoint + sequence) and every output (value + script).
type TxShape = (Vec<(String, u64, u64)>, Vec<(u64, String)>);

fn summarize(tx: &Value) -> Result<TxShape, BitcoinError> {
    let inputs = tx["vin"]
        .as_array()
        .ok_or_else(|| malformed("vin"))?
        .iter()
        .map(|i| {
            Ok((
                i["txid"]
                    .as_str()
                    .ok_or_else(|| malformed("vin.txid"))?
                    .to_string(),
                i["vout"].as_u64().ok_or_else(|| malformed("vin.vout"))?,
                i["sequence"]
                    .as_u64()
                    .ok_or_else(|| malformed("vin.sequence"))?,
            ))
        })
        .collect::<Result<_, BitcoinError>>()?;
    let outputs = tx["vout"]
        .as_array()
        .ok_or_else(|| malformed("vout"))?
        .iter()
        .map(|o| {
            Ok((
                btc_to_sat(o["value"].as_f64().ok_or_else(|| malformed("vout.value"))?),
                o["scriptPubKey"]["hex"]
                    .as_str()
                    .ok_or_else(|| malformed("scriptPubKey.hex"))?
                    .to_string(),
            ))
        })
        .collect::<Result<_, BitcoinError>>()?;
    Ok((inputs, outputs))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(value: f64, spk: &str, sequence: u64) -> Value {
        json!({
            "vin": [{ "txid": "ab", "vout": 0, "sequence": sequence, "scriptSig": {} }],
            "vout": [{ "value": value, "n": 0, "scriptPubKey": { "hex": spk } }]
        })
    }

    #[test]
    fn identical_shapes_match_even_with_witness_data() {
        let mut signed = tx(0.001, "0014aa", 0xffff_fffd);
        signed["vin"][0]["txinwitness"] = json!(["sig", "pubkey"]);
        assert_eq!(
            summarize(&tx(0.001, "0014aa", 0xffff_fffd)).unwrap(),
            summarize(&signed).unwrap()
        );
    }

    #[test]
    fn changed_amount_script_or_sequence_is_detected() {
        let base = summarize(&tx(0.001, "0014aa", 0xffff_fffd)).unwrap();
        assert_ne!(
            base,
            summarize(&tx(0.00099999, "0014aa", 0xffff_fffd)).unwrap()
        );
        assert_ne!(base, summarize(&tx(0.001, "0014bb", 0xffff_fffd)).unwrap());
        assert_ne!(base, summarize(&tx(0.001, "0014aa", 0xffff_ffff)).unwrap());
    }

    #[test]
    fn amounts_round_trip_through_btc() {
        for sat in [294, 1_410, 99_999_999, 123_456_789] {
            assert_eq!(btc_to_sat(sat_to_btc(sat)), sat);
        }
    }
}
