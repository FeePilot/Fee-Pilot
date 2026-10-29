use serde::{Deserialize, Serialize};

/// Bitcoin network a request is evaluated against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Mainnet,
    Testnet,
    Signet,
    Regtest,
}

impl std::str::FromStr for Network {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "mainnet" | "main" => Ok(Self::Mainnet),
            "testnet" | "test" => Ok(Self::Testnet),
            "signet" => Ok(Self::Signet),
            "regtest" => Ok(Self::Regtest),
            other => Err(format!("unknown network: {other}")),
        }
    }
}

/// Lifecycle state of a transaction as observed by FeePilot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxStatus {
    /// In the mempool, unconfirmed.
    Pending,
    /// Not in the mempool; a conflicting transaction spends the same inputs.
    Replaced,
    /// Included in a block (see `confirmations` for depth; not final until deep).
    Confirmed,
    /// Not in the mempool and not confirmed (evicted, or unknown to this node).
    NotFound,
}

/// Facts about a transaction, normalised from the Bitcoin data adapter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TxAnalysis {
    pub txid: String,
    pub network: Network,
    pub status: TxStatus,
    pub confirmations: u32,
    pub vsize: u64,
    /// Absolute fee in satoshis; `None` if inputs are unavailable to compute it.
    pub fee_sat: Option<u64>,
    /// Whether the tx (or an unconfirmed ancestor) signals BIP125 replaceability.
    pub signals_rbf: Option<bool>,
    pub unconfirmed_ancestors: u32,
    pub unconfirmed_descendants: u32,
    /// Current estimate for next-block inclusion, sat/vB.
    pub target_fee_rate: Option<f64>,
}

impl TxAnalysis {
    /// Effective fee rate in sat/vB, if the fee is known.
    pub fn fee_rate(&self) -> Option<f64> {
        self.fee_sat.map(|f| f as f64 / self.vsize.max(1) as f64)
    }
}

/// A transaction output reference (the thing an input spends).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outpoint {
    pub txid: String,
    pub vout: u32,
}

/// What the user told us about their situation. `None` means "not told yet", which the
/// engine treats as unknown rather than assuming either way.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UserPreferences {
    pub urgency: Urgency,
    /// Maximum extra network fee the user will pay, in satoshis.
    pub max_budget_sat: Option<u64>,
    /// Can the user sign for the original inputs? (Enables RBF; typically the sender.)
    pub can_sign_inputs: Option<bool>,
    /// Does the user control an output of the stuck tx? (Enables CPFP; typically a receiver.)
    pub controls_output: Option<bool>,
    /// Value of that output, if known; used to check the child can pay its fee.
    pub output_value_sat: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Urgency {
    Low,
    #[default]
    Normal,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteKind {
    Rbf,
    Cpfp,
    ExternalAccelerator,
    Wait,
}

/// Whether a route can be used, with the reason. `Unknown` is never recommended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Eligibility {
    Feasible,
    Infeasible { reason: String },
    Unknown { missing: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouteOption {
    pub kind: RouteKind,
    pub eligibility: Eligibility,
    /// Extra Bitcoin network fee, satoshis.
    pub network_fee_sat: Option<u64>,
    /// Provider service charge, satoshis. Kept separate from the network fee.
    pub service_fee_sat: Option<u64>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Recommendation {
    pub analysis: TxAnalysis,
    pub options: Vec<RouteOption>,
    pub recommended: RouteKind,
    pub rationale: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("invalid txid: {0}")]
    InvalidTxid(String),
}

/// A txid is 64 hex characters.
pub fn validate_txid(txid: &str) -> Result<(), CoreError> {
    if txid.len() == 64 && txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(CoreError::InvalidTxid(txid.to_string()))
    }
}
