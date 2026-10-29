//! Fee arithmetic for the recovery routes. All amounts in satoshis, sizes in vbytes.

/// Default Bitcoin Core incremental relay fee, sat/vB.
pub const INCREMENTAL_RELAY_FEE: f64 = 1.0;

/// Extra vbytes assumed for a replacement, since ECDSA signature sizes vary by a byte or so
/// and BIP125 charges the incremental relay fee on the replacement's own size.
pub const RBF_SIZE_MARGIN_VB: u64 = 2;

/// Minimum absolute fee for an RBF replacement (BIP125 rules 3 and 4):
/// it must pay at least the original fee plus the incremental relay fee for
/// the replacement's own size, and beat the target rate.
pub fn min_rbf_fee(original_fee: u64, replacement_vsize: u64, target_rate: f64) -> u64 {
    let bip125 = original_fee as f64 + INCREMENTAL_RELAY_FEE * replacement_vsize as f64;
    let at_target = target_rate * replacement_vsize as f64;
    bip125.max(at_target).ceil() as u64
}

/// Fee the CPFP child must pay so the parent+child package reaches `target_rate`.
/// Returns 0 if the parent already meets the target.
pub fn cpfp_child_fee(
    parent_fee: u64,
    parent_vsize: u64,
    child_vsize: u64,
    target_rate: f64,
) -> u64 {
    let package = target_rate * (parent_vsize + child_vsize) as f64;
    (package - parent_fee as f64).max(0.0).ceil() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rbf_pays_more_than_original() {
        // 200 vB tx paid 200 sat (1 sat/vB); target 10 sat/vB.
        assert_eq!(min_rbf_fee(200, 200, 10.0), 2000);
        // Target below original: the BIP125 increment still applies.
        assert_eq!(min_rbf_fee(2000, 200, 1.0), 2200);
    }

    #[test]
    fn cpfp_child_covers_package_gap() {
        // parent 200 vB @ 200 sat, child 100 vB, target 10 sat/vB -> package 3000 sat.
        assert_eq!(cpfp_child_fee(200, 200, 100, 10.0), 2800);
        assert_eq!(cpfp_child_fee(5000, 200, 100, 10.0), 0);
    }
}
