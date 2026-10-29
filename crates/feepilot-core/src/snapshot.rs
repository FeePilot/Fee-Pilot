//! Fee snapshots: a timestamped copy of the node's fee view, kept so fee guidance can be shown
//! later (and offline) with an honest age. Pure data and unit conversion, no I/O.

use serde::{Deserialize, Serialize};

use crate::Network;

/// Bumped whenever the stored shape changes.
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

/// Confirmation targets (in blocks) snapshotted for fast, medium and economy.
pub const FEE_TARGETS: [u32; 3] = [2, 6, 144];

/// Where a single estimate came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EstimateSource {
    /// The node's `estimatesmartfee`.
    Node,
    /// The operator-configured `FEEPILOT_FALLBACK_FEE_RATE`; not a market estimate.
    Fallback,
    /// A public fee API (see `FeeSnapshot::source` for which). Not data from our own node.
    ThirdParty,
    /// No estimate and no fallback. The rate is `None`; nothing is invented.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TargetEstimate {
    /// Confirmation target in blocks.
    pub blocks: u32,
    pub sat_per_vb: Option<f64>,
    pub source: EstimateSource,
    /// The service has no estimate for exactly this many blocks, so a nearby named level was
    /// used. Absent in snapshots stored before this field existed.
    #[serde(default)]
    pub approximate: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeeSnapshot {
    pub schema_version: u32,
    pub network: Network,
    /// Unix seconds when the snapshot was taken.
    pub fetched_at: i64,
    /// Unit of every rate in this snapshot.
    pub unit: String,
    pub estimates: Vec<TargetEstimate>,
    /// The node's minimum relay fee. A floor for relay, not a rate likely to confirm.
    pub min_relay_fee_sat_per_vb: Option<f64>,
    /// The mempool's current minimum fee. Also a floor, not a confirmation estimate.
    pub mempool_min_fee_sat_per_vb: Option<f64>,
    /// What produced the data, e.g. `bitcoin-core`.
    pub source: String,
}

/// Convert a Bitcoin Core fee rate (BTC per kvB) to sat/vB. Returns `None` for values that are
/// not a positive, finite rate. Rounded to 3 decimals to drop float noise.
pub fn btc_per_kvb_to_sat_per_vb(btc_per_kvb: f64) -> Option<f64> {
    if !btc_per_kvb.is_finite() || btc_per_kvb <= 0.0 {
        return None;
    }
    // 1 BTC/kvB = 100_000_000 sat / 1_000 vB = 100_000 sat/vB.
    Some((btc_per_kvb * 1e5 * 1000.0).round() / 1000.0)
}

impl FeeSnapshot {
    /// Assemble a snapshot from raw node answers. `raw_estimates` holds `(blocks, sat/vB)`;
    /// a `None` or non-positive rate is filled from `fallback` (marked as such) or left unavailable.
    pub fn build(
        network: Network,
        fetched_at: i64,
        raw_estimates: &[(u32, Option<f64>)],
        min_relay_fee_sat_per_vb: Option<f64>,
        mempool_min_fee_sat_per_vb: Option<f64>,
        fallback: Option<f64>,
    ) -> Self {
        let valid = |r: f64| r.is_finite() && r > 0.0;
        let fallback = fallback.filter(|r| valid(*r));
        let estimates = raw_estimates
            .iter()
            .map(
                |&(blocks, rate)| match (rate.filter(|r| valid(*r)), fallback) {
                    (Some(r), _) => TargetEstimate {
                        blocks,
                        sat_per_vb: Some(r),
                        source: EstimateSource::Node,
                        approximate: false,
                    },
                    (None, Some(f)) => TargetEstimate {
                        blocks,
                        sat_per_vb: Some(f),
                        source: EstimateSource::Fallback,
                        approximate: false,
                    },
                    (None, None) => TargetEstimate {
                        blocks,
                        sat_per_vb: None,
                        source: EstimateSource::Unavailable,
                        approximate: false,
                    },
                },
            )
            .collect();
        Self {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            network,
            fetched_at,
            unit: "sat/vB".into(),
            estimates,
            min_relay_fee_sat_per_vb,
            mempool_min_fee_sat_per_vb,
            source: "bitcoin-core".into(),
        }
    }
}

impl FeeSnapshot {
    /// Assemble a snapshot from a public fee API. `raw` holds `(blocks, sat/vB, approximate)`.
    /// There is no fallback here: a rate the service did not give stays `None`. The relay and
    /// mempool floors are unknown because these APIs do not report them in a comparable way.
    pub fn build_third_party(
        network: Network,
        fetched_at: i64,
        service: &str,
        raw: &[(u32, Option<f64>, bool)],
    ) -> Self {
        let estimates = raw
            .iter()
            .map(
                |&(blocks, rate, approximate)| match rate.filter(|r| r.is_finite() && *r > 0.0) {
                    Some(r) => TargetEstimate {
                        blocks,
                        sat_per_vb: Some(r),
                        source: EstimateSource::ThirdParty,
                        approximate,
                    },
                    None => TargetEstimate {
                        blocks,
                        sat_per_vb: None,
                        source: EstimateSource::Unavailable,
                        approximate: false,
                    },
                },
            )
            .collect();
        Self {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            network,
            fetched_at,
            unit: "sat/vB".into(),
            estimates,
            min_relay_fee_sat_per_vb: None,
            mempool_min_fee_sat_per_vb: None,
            source: service.into(),
        }
    }

    /// Whether at least one estimate carries a rate.
    pub fn has_any_rate(&self) -> bool {
        self.estimates.iter().any(|e| e.sat_per_vb.is_some())
    }
}

/// How old a snapshot may be before the offline advisor lowers its confidence. These are
/// configuration (`FEEPILOT_FRESH_SECS`, `FEEPILOT_STALE_SECS`), not constants of the protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FreshnessPolicy {
    /// Up to this age a snapshot is "recent".
    pub recent_secs: u64,
    /// Up to this age it is "past the window"; beyond it, "very stale".
    pub stale_secs: u64,
}

impl Default for FreshnessPolicy {
    fn default() -> Self {
        Self {
            recent_secs: 600,
            stale_secs: 3600,
        }
    }
}

impl FreshnessPolicy {
    /// Read the overrides from the environment. `stale` must not be below `recent`.
    pub fn from_env() -> Result<Self, String> {
        let get = |k: &str, d: u64| -> Result<u64, String> {
            match std::env::var(k) {
                Ok(v) => v.parse::<u64>().map_err(|e| format!("{k}: {e}")),
                Err(_) => Ok(d),
            }
        };
        let d = Self::default();
        let policy = Self {
            recent_secs: get("FEEPILOT_FRESH_SECS", d.recent_secs)?,
            stale_secs: get("FEEPILOT_STALE_SECS", d.stale_secs)?,
        };
        policy.validate()
    }

    pub fn validate(self) -> Result<Self, String> {
        if self.stale_secs < self.recent_secs {
            return Err("FEEPILOT_STALE_SECS must not be below FEEPILOT_FRESH_SECS".into());
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_btc_per_kvb_to_sat_per_vb() {
        assert_eq!(btc_per_kvb_to_sat_per_vb(0.00001), Some(1.0));
        assert_eq!(btc_per_kvb_to_sat_per_vb(0.0002), Some(20.0));
        assert_eq!(btc_per_kvb_to_sat_per_vb(0.00001234), Some(1.234));
        assert_eq!(btc_per_kvb_to_sat_per_vb(0.00000001), Some(0.001));
    }

    #[test]
    fn rejects_values_that_are_not_a_rate() {
        for bad in [0.0, -0.0001, f64::NAN, f64::INFINITY] {
            assert_eq!(btc_per_kvb_to_sat_per_vb(bad), None);
        }
    }

    #[test]
    fn node_estimates_win_and_fallback_is_labelled() {
        let s = FeeSnapshot::build(
            Network::Regtest,
            1_000,
            &[(2, Some(12.5)), (6, None), (144, Some(f64::NAN))],
            Some(1.0),
            Some(1.0),
            Some(20.0),
        );
        let got: Vec<_> = s
            .estimates
            .iter()
            .map(|e| (e.sat_per_vb, e.source))
            .collect();
        assert_eq!(
            got,
            vec![
                (Some(12.5), EstimateSource::Node),
                (Some(20.0), EstimateSource::Fallback),
                (Some(20.0), EstimateSource::Fallback),
            ]
        );
        assert_eq!((s.fetched_at, s.unit.as_str()), (1_000, "sat/vB"));
        assert_eq!(s.schema_version, SNAPSHOT_SCHEMA_VERSION);
    }

    #[test]
    fn missing_estimates_stay_explicit_none() {
        let s = FeeSnapshot::build(Network::Regtest, 0, &[(2, None)], None, None, None);
        assert_eq!(s.estimates[0].sat_per_vb, None);
        assert_eq!(s.estimates[0].source, EstimateSource::Unavailable);
        // A nonsensical fallback is ignored rather than recorded.
        let s = FeeSnapshot::build(Network::Regtest, 0, &[(2, None)], None, None, Some(-3.0));
        assert_eq!(s.estimates[0].source, EstimateSource::Unavailable);
    }

    #[test]
    fn policy_rejects_a_stale_window_shorter_than_the_recent_one() {
        assert!(FreshnessPolicy::default().validate().is_ok());
        let bad = FreshnessPolicy {
            recent_secs: 100,
            stale_secs: 50,
        };
        assert!(bad.validate().is_err());
    }

    #[test]
    fn third_party_snapshot_is_labelled_and_has_no_fallback_or_floors() {
        let s = FeeSnapshot::build_third_party(
            Network::Signet,
            9,
            "mempool.space",
            &[
                (2, Some(4.0), true),
                (6, Some(2.5), true),
                (144, None, false),
            ],
        );
        assert_eq!(s.source, "mempool.space");
        assert_eq!(s.estimates[0].source, EstimateSource::ThirdParty);
        assert!(s.estimates[0].approximate);
        assert_eq!(s.estimates[2].source, EstimateSource::Unavailable);
        assert_eq!(s.estimates[2].sat_per_vb, None);
        assert_eq!(
            (s.min_relay_fee_sat_per_vb, s.mempool_min_fee_sat_per_vb),
            (None, None)
        );
        assert!(s.has_any_rate());
        let none =
            FeeSnapshot::build_third_party(Network::Signet, 9, "x", &[(2, Some(f64::NAN), false)]);
        assert!(!none.has_any_rate());
    }

    #[test]
    fn snapshots_stored_before_the_approximate_flag_still_load() {
        let old = serde_json::json!({
            "schema_version": 1, "network": "regtest", "fetched_at": 1, "unit": "sat/vB",
            "estimates": [{ "blocks": 2, "sat_per_vb": 3.0, "source": "node" }],
            "min_relay_fee_sat_per_vb": null, "mempool_min_fee_sat_per_vb": null,
            "source": "bitcoin-core"
        });
        let s: FeeSnapshot = serde_json::from_value(old).unwrap();
        assert!(!s.estimates[0].approximate);
    }

    #[test]
    fn round_trips_through_json() {
        let s = FeeSnapshot::build(Network::Signet, 5, &[(2, Some(3.0))], None, Some(1.0), None);
        let back: FeeSnapshot = serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }
}
