//! Integration tests against a live regtest node. Run with:
//!   ./scripts/regtest-setup.sh && cargo test -p feepilot-bitcoin -- --ignored
//! The node must run with -txindex=1 (regtest-setup.sh does this).

use feepilot_bitcoin::{
    BitcoinDataSource, BitcoinError, CoreRpc, CpfpRequest, RbfRequest, SigningBoundary,
};
use feepilot_core::{Network, TxStatus};
use serde_json::{json, Value};

fn node() -> CoreRpc {
    let url = std::env::var("BITCOIN_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:18443".into());
    let user = std::env::var("BITCOIN_RPC_USER").unwrap_or_else(|_| "feepilot".into());
    let pass = std::env::var("BITCOIN_RPC_PASS").unwrap_or_else(|_| "change-me".into());
    CoreRpc::new(url, Network::Regtest)
        .with_auth(user, pass)
        .with_fallback_fee_rate(20.0)
}

async fn ensure_wallet(rpc: &CoreRpc, name: &str) -> CoreRpc {
    if rpc.call("loadwallet", json!([name])).await.is_err() {
        let _ = rpc.call("createwallet", json!([name])).await;
    }
    rpc.clone().with_wallet(name)
}

/// Pay `receiver` 0.01 BTC at 1 sat/vB, signalling RBF, and return the txid.
async fn send_low_fee(sender: &CoreRpc, receiver: &CoreRpc) -> String {
    let addr = receiver.call("getnewaddress", json!([])).await.unwrap();
    let res = sender
        .call(
            "send",
            json!({
                "outputs": { addr.as_str().unwrap(): 0.01 },
                "fee_rate": 1,
                "options": { "replaceable": true }
            }),
        )
        .await
        .unwrap();
    res["txid"].as_str().unwrap().to_string()
}

async fn mine(sender: &CoreRpc, n: u32) {
    let addr = sender.call("getnewaddress", json!([])).await.unwrap();
    sender
        .call("generatetoaddress", json!([n, addr]))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs a running regtest node"]
async fn analyzes_pending_confirmed_replaced_and_unknown() {
    let rpc = node();
    let sender = ensure_wallet(&rpc, "sender").await;
    let receiver = ensure_wallet(&rpc, "receiver").await;
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

    // Pending: low-fee, RBF-signalling, with the fallback target applied.
    let txid = send_low_fee(&sender, &receiver).await;
    let a = rpc.analyze(&txid).await.unwrap();
    assert_eq!(a.status, TxStatus::Pending);
    assert_eq!(a.signals_rbf, Some(true));
    assert_eq!(a.target_fee_rate, Some(20.0));
    assert!(a.fee_rate().unwrap() < 2.0, "fee rate {:?}", a.fee_rate());

    // Confirmed after one block.
    mine(&sender, 1).await;
    let a = rpc.analyze(&txid).await.unwrap();
    assert_eq!(a.status, TxStatus::Confirmed);
    assert_eq!(a.confirmations, 1);

    // Replaced: the original disappears from the mempool and the node has no record of it.
    // (Detecting "replaced" as opposed to "not found" arrives with the tracker in phase 4.)
    let original = send_low_fee(&sender, &receiver).await;
    let bumped: Value = sender
        .call("bumpfee", json!([original, { "fee_rate": 20 }]))
        .await
        .unwrap();
    let replacement = bumped["txid"].as_str().unwrap();
    assert_eq!(
        rpc.analyze(&original).await.unwrap().status,
        TxStatus::NotFound
    );
    let r = rpc.analyze(replacement).await.unwrap();
    assert_eq!(r.status, TxStatus::Pending);
    assert!(r.fee_rate().unwrap() >= 19.0);

    // Unknown txid.
    let unknown = rpc.analyze(&format!("{}1", "0".repeat(63))).await.unwrap();
    assert_eq!(unknown.status, TxStatus::NotFound);
    mine(&sender, 1).await;
}

/// Output indexes of `txid` as (paying `addr`, everything else).
async fn split_outputs(rpc: &CoreRpc, txid: &str, addr: &str) -> (u32, u32) {
    let tx = rpc
        .call("getrawtransaction", json!([txid, 1]))
        .await
        .unwrap();
    let find = |want: bool| {
        tx["vout"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| (o["scriptPubKey"]["address"] == addr) == want)
            .map(|o| o["n"].as_u64().unwrap() as u32)
            .unwrap()
    };
    (find(true), find(false))
}

/// Stand-in for the user's own wallet: sign a PSBT outside FeePilot.
async fn sign(wallet: &CoreRpc, psbt: &str) -> String {
    let res = wallet
        .call("walletprocesspsbt", json!([psbt]))
        .await
        .unwrap();
    res["psbt"].as_str().unwrap().to_string()
}

async fn setup() -> (CoreRpc, CoreRpc, CoreRpc) {
    let rpc = node();
    let sender = ensure_wallet(&rpc, "sender").await;
    let receiver = ensure_wallet(&rpc, "receiver").await;
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
    (rpc, sender, receiver)
}

#[tokio::test]
#[ignore = "needs a running regtest node"]
async fn rbf_candidate_is_signed_externally_verified_and_confirms() {
    let (rpc, sender, receiver) = setup().await;
    let dest = receiver.call("getnewaddress", json!([])).await.unwrap();
    let dest = dest.as_str().unwrap();
    let original = sender
        .call(
            "send",
            json!({ "outputs": { dest: 0.01 }, "fee_rate": 1, "options": { "replaceable": true } }),
        )
        .await
        .unwrap()["txid"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, change_vout) = split_outputs(&rpc, &original, dest).await;
    let old_fee = rpc.analyze(&original).await.unwrap().fee_sat.unwrap();

    let candidate = rpc
        .build_rbf(&RbfRequest {
            txid: original.clone(),
            change_vout,
            new_fee_sat: old_fee + 2_000,
        })
        .await
        .unwrap();
    assert_eq!(candidate.fee_sat, old_fee + 2_000);

    let signed = sign(&sender, &candidate.psbt_base64).await;
    let replacement = rpc
        .broadcast_signed(&candidate.psbt_base64, &signed)
        .await
        .unwrap();

    assert_eq!(
        rpc.analyze(&original).await.unwrap().status,
        TxStatus::NotFound
    );
    let r = rpc.analyze(&replacement).await.unwrap();
    assert_eq!(r.status, TxStatus::Pending);
    assert_eq!(r.fee_sat, Some(old_fee + 2_000));
    mine(&sender, 1).await;
    assert_eq!(
        rpc.analyze(&replacement).await.unwrap().status,
        TxStatus::Confirmed
    );
}

#[tokio::test]
#[ignore = "needs a running regtest node"]
async fn rbf_rejects_unpayable_or_underpaying_requests() {
    let (rpc, sender, receiver) = setup().await;
    let txid = send_low_fee(&sender, &receiver).await;
    let req = |change_vout, new_fee_sat| RbfRequest {
        txid: txid.clone(),
        change_vout,
        new_fee_sat,
    };
    let old_fee = rpc.analyze(&txid).await.unwrap().fee_sat.unwrap();

    let too_low = rpc.build_rbf(&req(0, old_fee + 1)).await.unwrap_err();
    assert!(matches!(too_low, BitcoinError::InvalidRequest(m) if m.contains("minimum")));
    let no_output = rpc.build_rbf(&req(9, old_fee + 2_000)).await.unwrap_err();
    assert!(matches!(no_output, BitcoinError::InvalidRequest(_)));
    let not_pending = rpc
        .build_rbf(&RbfRequest {
            txid: "0".repeat(64),
            change_vout: 0,
            new_fee_sat: 5_000,
        })
        .await
        .unwrap_err();
    assert!(matches!(not_pending, BitcoinError::InvalidRequest(_)));
    mine(&sender, 1).await;
}

#[tokio::test]
#[ignore = "needs a running regtest node"]
async fn tampered_signed_psbt_is_refused() {
    let (rpc, sender, receiver) = setup().await;
    let dest = receiver.call("getnewaddress", json!([])).await.unwrap();
    let dest = dest.as_str().unwrap();
    let original = sender
        .call(
            "send",
            json!({ "outputs": { dest: 0.01 }, "fee_rate": 1, "options": { "replaceable": true } }),
        )
        .await
        .unwrap()["txid"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, change_vout) = split_outputs(&rpc, &original, dest).await;
    let old_fee = rpc.analyze(&original).await.unwrap().fee_sat.unwrap();
    let build = |fee| RbfRequest {
        txid: original.clone(),
        change_vout,
        new_fee_sat: fee,
    };

    let promised = rpc.build_rbf(&build(old_fee + 2_000)).await.unwrap();
    let other = rpc.build_rbf(&build(old_fee + 9_000)).await.unwrap();
    // The signer returns a *different* (higher-fee) transaction than the one FeePilot prepared.
    let signed_other = sign(&sender, &other.psbt_base64).await;
    let err = rpc
        .broadcast_signed(&promised.psbt_base64, &signed_other)
        .await
        .unwrap_err();
    assert!(matches!(err, BitcoinError::InvalidRequest(m) if m.contains("does not match")));

    // An unsigned PSBT is not enough either.
    let err = rpc
        .broadcast_signed(&promised.psbt_base64, &promised.psbt_base64)
        .await
        .unwrap_err();
    assert!(matches!(err, BitcoinError::InvalidRequest(m) if m.contains("not fully signed")));
    mine(&sender, 1).await;
}

#[tokio::test]
#[ignore = "needs a running regtest node"]
async fn cpfp_child_lifts_a_stuck_parent_into_a_block() {
    let (rpc, sender, receiver) = setup().await;
    let dest = receiver.call("getnewaddress", json!([])).await.unwrap();
    let dest = dest.as_str().unwrap();
    let parent = sender
        .call("send", json!({ "outputs": { dest: 0.01 }, "fee_rate": 1 }))
        .await
        .unwrap()["txid"]
        .as_str()
        .unwrap()
        .to_string();
    let (vout, _) = split_outputs(&rpc, &parent, dest).await;
    let back_to_receiver = receiver.call("getnewaddress", json!([])).await.unwrap();

    let candidate = rpc
        .build_cpfp(&CpfpRequest {
            parent_txid: parent.clone(),
            vout,
            child_fee_sat: 5_000,
            destination: back_to_receiver.as_str().unwrap().to_string(),
        })
        .await
        .unwrap();
    let signed = sign(&receiver, &candidate.psbt_base64).await;
    let child = rpc
        .broadcast_signed(&candidate.psbt_base64, &signed)
        .await
        .unwrap();

    let c = rpc.analyze(&child).await.unwrap();
    assert_eq!(c.status, TxStatus::Pending);
    assert_eq!(c.fee_sat, Some(5_000));
    assert_eq!(
        rpc.analyze(&parent).await.unwrap().unconfirmed_descendants,
        1
    );
    mine(&sender, 1).await;
    assert_eq!(
        rpc.analyze(&parent).await.unwrap().status,
        TxStatus::Confirmed
    );
    assert_eq!(
        rpc.analyze(&child).await.unwrap().status,
        TxStatus::Confirmed
    );
}

#[tokio::test]
#[ignore = "needs a running regtest node"]
async fn cpfp_rejects_bad_destination_and_unaffordable_fee() {
    let (rpc, sender, receiver) = setup().await;
    let dest = receiver.call("getnewaddress", json!([])).await.unwrap();
    let dest = dest.as_str().unwrap().to_string();
    let parent = sender
        .call(
            "send",
            json!({ "outputs": { dest.as_str(): 0.01 }, "fee_rate": 1 }),
        )
        .await
        .unwrap()["txid"]
        .as_str()
        .unwrap()
        .to_string();
    let (vout, _) = split_outputs(&rpc, &parent, &dest).await;
    let req = |destination: &str, fee| CpfpRequest {
        parent_txid: parent.clone(),
        vout,
        child_fee_sat: fee,
        destination: destination.to_string(),
    };

    let bad_addr = rpc
        .build_cpfp(&req("not-an-address", 5_000))
        .await
        .unwrap_err();
    assert!(matches!(bad_addr, BitcoinError::InvalidRequest(m) if m.contains("destination")));
    let too_costly = rpc.build_cpfp(&req(&dest, 1_000_000)).await.unwrap_err();
    assert!(matches!(too_costly, BitcoinError::InvalidRequest(m) if m.contains("too little")));
    mine(&sender, 1).await;
}
