//! Bitcoin data adapter and the wallet/signing boundary.
//!
//! FeePilot never holds private keys: it builds *unsigned* candidates (PSBTs)
//! and hands them to a wallet or signer.

mod http_fees;
mod rpc;
mod signing;

pub use http_fees::{FeeApiKind, HttpFeeSource};
pub use rpc::CoreRpc;

use feepilot_core::{FeeSnapshot, Network, Outpoint, TxAnalysis, TxOutput};

#[derive(Debug, thiserror::Error)]
pub enum BitcoinError {
    /// The node answered with a JSON-RPC error.
    #[error("rpc error {code}: {message}")]
    Rpc { code: i64, message: String },
    /// Could not reach the node or read its response.
    #[error("transport error: {0}")]
    Transport(String),
    #[error("node rejected the rpc credentials")]
    Unauthorized,
    /// The node cannot answer this kind of query (e.g. missing `-txindex`).
    #[error("node configuration: {0}")]
    Config(&'static str),
    #[error("unexpected response from node: {0}")]
    Malformed(String),
    /// The request cannot be satisfied (bad input, change too small, tx not pending...).
    /// The message is safe to show to the user.
    #[error("{0}")]
    InvalidRequest(String),
    /// The node refused to relay the transaction. The message is safe to show to the user.
    #[error("transaction rejected by the node: {0}")]
    Rejected(String),
}

/// Read-only access to chain and mempool data.
pub trait BitcoinDataSource {
    fn network(&self) -> Network;
    /// Look up a txid and normalise it into a [`TxAnalysis`].
    fn analyze(
        &self,
        txid: &str,
    ) -> impl std::future::Future<Output = Result<TxAnalysis, BitcoinError>> + Send;

    /// The outpoints a transaction spends.
    fn tx_inputs(
        &self,
        txid: &str,
    ) -> impl std::future::Future<Output = Result<Vec<Outpoint>, BitcoinError>> + Send;

    /// The outputs of a transaction, marked with what the node's loaded wallets know about
    /// them. Sources without that knowledge may return an empty list.
    fn tx_outputs(
        &self,
        _txid: &str,
    ) -> impl std::future::Future<Output = Result<Vec<TxOutput>, BitcoinError>> + Send {
        async { Ok(Vec::new()) }
    }

    /// For each outpoint, the txid of the mempool transaction spending it, if any.
    /// The result is aligned with `outpoints`.
    fn find_spenders(
        &self,
        outpoints: &[Outpoint],
    ) -> impl std::future::Future<Output = Result<Vec<Option<String>>, BitcoinError>> + Send;
}

/// Source of fee estimates for the offline-capable fee cache.
pub trait FeeSource {
    /// Query the node's fee view and stamp it with `now` (unix seconds).
    fn fee_snapshot(
        &self,
        now: i64,
    ) -> impl std::future::Future<Output = Result<FeeSnapshot, BitcoinError>> + Send;
}

/// Replace a pending transaction with a higher-fee version by shrinking one of its outputs.
#[derive(Debug, Clone)]
pub struct RbfRequest {
    pub txid: String,
    /// The output the user's change goes to; its value pays for the fee increase.
    pub change_vout: u32,
    /// Absolute fee of the replacement, in satoshis.
    pub new_fee_sat: u64,
}

/// Spend an output of a pending parent in a child that pays `child_fee_sat`.
#[derive(Debug, Clone)]
pub struct CpfpRequest {
    pub parent_txid: String,
    pub vout: u32,
    pub child_fee_sat: u64,
    /// Where the child sends the remainder (typically back to the user's own wallet).
    pub destination: String,
}

/// An unsigned transaction candidate (base64 PSBT) awaiting external signing.
#[derive(Debug, Clone)]
pub struct UnsignedCandidate {
    pub psbt_base64: String,
    /// Absolute fee paid by the candidate transaction, in satoshis.
    pub fee_sat: u64,
    pub description: String,
}

/// Builds unsigned RBF/CPFP candidates and verifies, finalizes and broadcasts signed ones.
/// Implementations never see private keys.
pub trait SigningBoundary {
    fn build_rbf(
        &self,
        req: &RbfRequest,
    ) -> impl std::future::Future<Output = Result<UnsignedCandidate, BitcoinError>> + Send;

    fn build_cpfp(
        &self,
        req: &CpfpRequest,
    ) -> impl std::future::Future<Output = Result<UnsignedCandidate, BitcoinError>> + Send;

    /// Check that `signed_psbt` is a completed signature of exactly `unsigned_psbt`
    /// (same inputs, outputs and amounts), then broadcast it and return the txid.
    fn broadcast_signed(
        &self,
        unsigned_psbt: &str,
        signed_psbt: &str,
    ) -> impl std::future::Future<Output = Result<String, BitcoinError>> + Send;
}
