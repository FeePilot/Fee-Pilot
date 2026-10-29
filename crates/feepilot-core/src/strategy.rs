//! Rules-based strategy engine. Recommends a route only when the evidence supports it.
//!
//! Rules, in order:
//! 1. Only pending transactions can be recovered; anything else recommends `Wait`.
//! 2. The target fee rate is scaled by urgency (low 0.5x, normal 1x, high 1.5x). A
//!    transaction already paying at or above it is not stuck: `Wait`.
//! 3. Each route is `Feasible`, `Infeasible` (with a reason) or `Unknown` (with what is
//!    missing). `Unknown` is never recommended.
//! 4. Feasible routes whose extra network fee exceeds the budget become `Infeasible`.
//! 5. Of the rest, the cheapest wins; ties go to RBF (no extra output needed).

use crate::fees::{cpfp_child_fee, min_rbf_fee, RBF_SIZE_MARGIN_VB};
use crate::types::*;

/// Smallest output Bitcoin Core relays as non-dust (P2WPKH), in satoshis.
pub const DUST_LIMIT_SAT: u64 = 294;

/// Assumed CPFP child size: one P2WPKH input, one P2WPKH output.
pub const DEFAULT_CHILD_VSIZE: u64 = 110;

pub struct StrategyInput {
    pub analysis: TxAnalysis,
    pub prefs: UserPreferences,
    /// Assumed size of a CPFP child, vbytes.
    pub child_vsize: u64,
}

fn urgency_factor(u: Urgency) -> f64 {
    match u {
        Urgency::Low => 0.5,
        Urgency::Normal => 1.0,
        Urgency::High => 1.5,
    }
}

pub fn recommend(input: StrategyInput) -> Recommendation {
    let StrategyInput {
        analysis,
        prefs,
        child_vsize,
    } = input;

    if analysis.status != TxStatus::Pending {
        let rationale = match analysis.status {
            TxStatus::Confirmed => "Transaction is already confirmed; nothing to recover.",
            TxStatus::Replaced => "Transaction was replaced; track the replacement instead.",
            _ => "Transaction is not visible to this node; recovery cannot be assessed.",
        };
        return wait_only(analysis, rationale.into());
    }

    let target = analysis
        .target_fee_rate
        .map(|t| t * urgency_factor(prefs.urgency));

    if let (Some(current), Some(target)) = (analysis.fee_rate(), target) {
        if current >= target {
            let rationale = format!(
                "Transaction pays {current:.1} sat/vB, at or above the {target:.1} sat/vB target \
                 for this urgency, so it is not stuck. No recovery needed."
            );
            return wait_only(analysis, rationale);
        }
    }

    let mut options = vec![
        rbf_option(&analysis, &prefs, target),
        cpfp_option(&analysis, &prefs, target, child_vsize),
        RouteOption {
            kind: RouteKind::ExternalAccelerator,
            eligibility: Eligibility::Unknown {
                missing: "external accelerators are not supported yet".into(),
            },
            network_fee_sat: None,
            service_fee_sat: None,
            notes: vec![],
        },
        wait_option("Waiting costs nothing; fee estimates may fall."),
    ];

    if let Some(budget) = prefs.max_budget_sat {
        for o in &mut options {
            match o.network_fee_sat {
                Some(fee) if fee > budget && o.eligibility == Eligibility::Feasible => {
                    o.eligibility = Eligibility::Infeasible {
                        reason: format!("costs {fee} sat, over the {budget} sat budget"),
                    };
                }
                _ => {}
            }
        }
    }

    let pick = options
        .iter()
        .filter(|o| o.kind != RouteKind::Wait && o.eligibility == Eligibility::Feasible)
        .min_by_key(|o| {
            (
                o.network_fee_sat.unwrap_or(u64::MAX),
                o.kind != RouteKind::Rbf,
            )
        })
        .map(|o| o.kind);

    let (recommended, rationale) = match pick {
        Some(kind) => {
            let fee = options
                .iter()
                .find(|o| o.kind == kind)
                .and_then(|o| o.network_fee_sat)
                .unwrap_or_default();
            (
                kind,
                format!("{kind:?} is the cheapest feasible route, adding about {fee} sat in network fees."),
            )
        }
        None => (RouteKind::Wait, no_route_rationale(&options)),
    };

    Recommendation {
        analysis,
        options,
        recommended,
        rationale,
    }
}

fn no_route_rationale(options: &[RouteOption]) -> String {
    let reasons: Vec<String> = options
        .iter()
        .filter(|o| !matches!(o.kind, RouteKind::Wait | RouteKind::ExternalAccelerator))
        .filter_map(|o| match &o.eligibility {
            Eligibility::Infeasible { reason } => Some(format!("{:?}: {reason}", o.kind)),
            Eligibility::Unknown { missing } => {
                Some(format!("{:?}: unknown, need {missing}", o.kind))
            }
            Eligibility::Feasible => None,
        })
        .collect();
    format!("No recovery route recommended. {}", reasons.join("; "))
}

fn wait_only(analysis: TxAnalysis, rationale: String) -> Recommendation {
    Recommendation {
        options: vec![wait_option(&rationale)],
        recommended: RouteKind::Wait,
        rationale,
        analysis,
    }
}

fn wait_option(note: &str) -> RouteOption {
    RouteOption {
        kind: RouteKind::Wait,
        eligibility: Eligibility::Feasible,
        network_fee_sat: Some(0),
        service_fee_sat: None,
        notes: vec![note.into()],
    }
}

fn rbf_option(a: &TxAnalysis, prefs: &UserPreferences, target: Option<f64>) -> RouteOption {
    let eligibility = match (prefs.can_sign_inputs, a.fee_sat, target) {
        (None, ..) => Eligibility::Unknown {
            missing: "whether you can sign for the original inputs (did you send it?)".into(),
        },
        (Some(false), ..) => Eligibility::Infeasible {
            reason: "you cannot sign for the original inputs".into(),
        },
        (_, None, _) | (_, _, None) => Eligibility::Unknown {
            missing: "the transaction fee or a fee-rate estimate".into(),
        },
        _ => Eligibility::Feasible,
    };
    let network_fee_sat = match (a.fee_sat, target) {
        (Some(fee), Some(rate)) => {
            Some(min_rbf_fee(fee, a.vsize + RBF_SIZE_MARGIN_VB, rate).saturating_sub(fee))
        }
        _ => None,
    };

    let mut notes =
        vec!["Assumes the replacement is within 2 vB of the original size.".to_string()];
    match a.signals_rbf {
        Some(true) => {}
        Some(false) => notes.push(
            "The transaction does not signal BIP125 replaceability. Replacement relies on \
             full-RBF policy, which not every node or miner applies."
                .into(),
        ),
        None => notes.push("Replaceability signalling could not be determined.".into()),
    }
    if a.unconfirmed_descendants > 0 {
        notes.push(format!(
            "Replacing evicts {} unconfirmed descendant transaction(s).",
            a.unconfirmed_descendants
        ));
    }
    RouteOption {
        kind: RouteKind::Rbf,
        eligibility,
        network_fee_sat,
        service_fee_sat: None,
        notes,
    }
}

fn cpfp_option(
    a: &TxAnalysis,
    prefs: &UserPreferences,
    target: Option<f64>,
    child_vsize: u64,
) -> RouteOption {
    let network_fee_sat = match (a.fee_sat, target) {
        (Some(fee), Some(rate)) => Some(cpfp_child_fee(fee, a.vsize, child_vsize, rate)),
        _ => None,
    };
    let eligibility = match (prefs.controls_output, network_fee_sat) {
        (None, _) => Eligibility::Unknown {
            missing: "whether you control an output of this transaction (did you receive it?)"
                .into(),
        },
        (Some(false), _) => Eligibility::Infeasible {
            reason: "you control no output of this transaction".into(),
        },
        (_, None) => Eligibility::Unknown {
            missing: "the transaction fee or a fee-rate estimate".into(),
        },
        (_, Some(fee)) => match prefs.output_value_sat {
            Some(value) if value < fee + DUST_LIMIT_SAT => Eligibility::Infeasible {
                reason: format!("your {value} sat output cannot cover the {fee} sat child fee"),
            },
            _ => Eligibility::Feasible,
        },
    };

    let mut notes = vec![format!(
        "Assumes a {child_vsize} vB child spending one output."
    )];
    if prefs.output_value_sat.is_none() {
        notes.push(
            "Output value unknown; the output must be large enough to pay the child fee.".into(),
        );
    }
    if a.unconfirmed_ancestors > 0 {
        notes.push(format!(
            "The transaction has {} unconfirmed ancestor(s) not counted here, so the real \
             package fee needed may be higher.",
            a.unconfirmed_ancestors
        ));
    }
    RouteOption {
        kind: RouteKind::Cpfp,
        eligibility,
        network_fee_sat,
        service_fee_sat: None,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 200 vB paying 200 sat (1 sat/vB) against a 10 sat/vB target:
    /// RBF costs 1820 extra sat (202 vB with the size margin), a 110 vB CPFP child costs 2900 sat.
    fn stuck() -> TxAnalysis {
        TxAnalysis {
            txid: "0".repeat(64),
            network: Network::Regtest,
            status: TxStatus::Pending,
            confirmations: 0,
            vsize: 200,
            fee_sat: Some(200),
            signals_rbf: Some(true),
            unconfirmed_ancestors: 0,
            unconfirmed_descendants: 0,
            target_fee_rate: Some(10.0),
        }
    }

    fn run(a: TxAnalysis, prefs: UserPreferences) -> Recommendation {
        recommend(StrategyInput {
            analysis: a,
            prefs,
            child_vsize: 110,
        })
    }

    fn sender() -> UserPreferences {
        UserPreferences {
            can_sign_inputs: Some(true),
            controls_output: Some(false),
            ..Default::default()
        }
    }

    fn receiver() -> UserPreferences {
        UserPreferences {
            can_sign_inputs: Some(false),
            controls_output: Some(true),
            ..Default::default()
        }
    }

    fn option(r: &Recommendation, kind: RouteKind) -> &RouteOption {
        r.options.iter().find(|o| o.kind == kind).unwrap()
    }

    #[test]
    fn sender_gets_rbf() {
        let r = run(stuck(), sender());
        assert_eq!(r.recommended, RouteKind::Rbf);
        assert_eq!(option(&r, RouteKind::Rbf).network_fee_sat, Some(1820));
    }

    #[test]
    fn receiver_gets_cpfp() {
        let r = run(stuck(), receiver());
        assert_eq!(r.recommended, RouteKind::Cpfp);
        assert_eq!(option(&r, RouteKind::Cpfp).network_fee_sat, Some(2900));
        assert!(matches!(
            option(&r, RouteKind::Rbf).eligibility,
            Eligibility::Infeasible { .. }
        ));
    }

    #[test]
    fn cheapest_wins_when_both_feasible() {
        let prefs = UserPreferences {
            can_sign_inputs: Some(true),
            controls_output: Some(true),
            ..Default::default()
        };
        assert_eq!(run(stuck(), prefs).recommended, RouteKind::Rbf);
    }

    #[test]
    fn unsigned_tx_stays_feasible_but_warns_about_full_rbf() {
        let mut a = stuck();
        a.signals_rbf = Some(false);
        let r = run(a, sender());
        assert_eq!(r.recommended, RouteKind::Rbf);
        assert!(option(&r, RouteKind::Rbf)
            .notes
            .iter()
            .any(|n| n.contains("full-RBF")));
    }

    #[test]
    fn nothing_known_about_the_user_recommends_wait_and_asks() {
        let r = run(stuck(), UserPreferences::default());
        assert_eq!(r.recommended, RouteKind::Wait);
        assert!(r.rationale.contains("did you send it"));
        assert!(matches!(
            option(&r, RouteKind::Rbf).eligibility,
            Eligibility::Unknown { .. }
        ));
    }

    #[test]
    fn unknown_fee_is_never_recommended() {
        let mut a = stuck();
        a.target_fee_rate = None;
        assert_eq!(run(a, sender()).recommended, RouteKind::Wait);
    }

    #[test]
    fn budget_excludes_expensive_routes() {
        let prefs = UserPreferences {
            max_budget_sat: Some(1000),
            ..sender()
        };
        let r = run(stuck(), prefs);
        assert_eq!(r.recommended, RouteKind::Wait);
        assert!(r.rationale.contains("budget"));
    }

    #[test]
    fn budget_can_flip_the_choice_to_the_cheaper_route() {
        let prefs = UserPreferences {
            can_sign_inputs: Some(true),
            controls_output: Some(true),
            max_budget_sat: Some(2000),
            ..Default::default()
        };
        // RBF (1820) fits; CPFP (2900) does not.
        let r = run(stuck(), prefs);
        assert_eq!(r.recommended, RouteKind::Rbf);
        assert!(matches!(
            option(&r, RouteKind::Cpfp).eligibility,
            Eligibility::Infeasible { .. }
        ));
    }

    #[test]
    fn tiny_output_cannot_pay_for_cpfp() {
        let prefs = UserPreferences {
            output_value_sat: Some(1000),
            ..receiver()
        };
        let r = run(stuck(), prefs);
        assert_eq!(r.recommended, RouteKind::Wait);
        assert!(r.rationale.contains("cannot cover"));
    }

    #[test]
    fn urgency_scales_the_target() {
        // At 1 sat/vB current vs 10 target: low urgency halves it to 5, still stuck.
        let low = UserPreferences {
            urgency: Urgency::Low,
            ..sender()
        };
        assert_eq!(
            option(&run(stuck(), low), RouteKind::Rbf).network_fee_sat,
            Some(810)
        );
        let high = UserPreferences {
            urgency: Urgency::High,
            ..sender()
        };
        assert_eq!(
            option(&run(stuck(), high), RouteKind::Rbf).network_fee_sat,
            Some(2830)
        );
    }

    #[test]
    fn transaction_already_paying_enough_is_not_stuck() {
        let mut a = stuck();
        a.fee_sat = Some(2500); // 12.5 sat/vB vs 10 target
        let r = run(a.clone(), sender());
        assert_eq!(r.recommended, RouteKind::Wait);
        assert!(r.rationale.contains("not stuck"));
        // ...but a high-urgency user (target 15) still gets a route.
        let prefs = UserPreferences {
            urgency: Urgency::High,
            ..sender()
        };
        assert_eq!(run(a, prefs).recommended, RouteKind::Rbf);
    }

    #[test]
    fn non_pending_states_recommend_wait() {
        for status in [TxStatus::Confirmed, TxStatus::Replaced, TxStatus::NotFound] {
            let mut a = stuck();
            a.status = status;
            let r = run(a, sender());
            assert_eq!(r.recommended, RouteKind::Wait, "{status:?}");
            assert_eq!(r.options.len(), 1);
        }
    }

    #[test]
    fn descendants_and_ancestors_are_surfaced() {
        let mut a = stuck();
        a.unconfirmed_descendants = 2;
        a.unconfirmed_ancestors = 1;
        let both = UserPreferences {
            controls_output: Some(true),
            ..sender()
        };
        let r = run(a, both);
        assert!(option(&r, RouteKind::Rbf)
            .notes
            .iter()
            .any(|n| n.contains("2 unconfirmed descendant")));
        assert!(option(&r, RouteKind::Cpfp)
            .notes
            .iter()
            .any(|n| n.contains("1 unconfirmed ancestor")));
    }
}
