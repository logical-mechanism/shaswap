//! The constant-product pool curve, mirrored from
//! [`spend.ak`](../../../contracts/lib/shaswap/spend.ak)'s `reserve_of` /
//! `pool_settle`. The settlement anchor is curve-agnostic; *this* is what the pool
//! validator enforces (`k_after ≥ k_before` with a residual-only fee), so the
//! solver must size the pool residual to pass it.
//!
//! The `k`-check multiplies two reserves (each up to `i64::MAX`), which overflows
//! `i128`; we use `BigInt` here so the comparison is exact and can never panic —
//! matching Aiken's unbounded `Int`.

use crate::types::{AssetId, PoolDatum, POOL_MIN_ADA};
use crate::value::Value;
use num_bigint::BigInt;

/// A static trading fee `φ = num/den`, with `0 ≤ φ < 1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fee {
    pub num: i128,
    pub den: i128,
}

impl Fee {
    pub fn from_datum(d: &PoolDatum) -> Self {
        Fee {
            num: d.fee_num,
            den: d.fee_den,
        }
    }

    pub fn is_valid(&self) -> bool {
        self.den > 0 && self.num >= 0 && self.num < self.den
    }

    /// `fee_den − fee_num` (the "γ" multiplier on net input).
    fn gamma(&self) -> i128 {
        self.den - self.num
    }
}

/// `spend.reserve_of` — the tradeable reserve of `asset` in a pool value. For the
/// ADA side, `pool_min_ada` is carved out (pure overhead, never liquidity); for a
/// native-token side it is the raw quantity.
pub fn reserve_of(v: &Value, asset: &AssetId) -> i128 {
    if asset.is_ada() {
        v.lovelace_of() - POOL_MIN_ADA
    } else {
        asset.qty_in(v)
    }
}

fn pos(x: i128) -> i128 {
    if x > 0 {
        x
    } else {
        0
    }
}

/// `spend.pool_settle`'s `k`-with-fee invariant, evaluated exactly in `BigInt`:
///
/// ```text
/// eff_a = res_a_out·fee_den − fee_num·pos(res_a_out − res_a_in)
/// eff_b = res_b_out·fee_den − fee_num·pos(res_b_out − res_b_in)
/// accept ⟺ eff_a·eff_b ≥ res_a_in·res_b_in·fee_den²
/// ```
///
/// The fee is charged only on the side the pool *gained* (its net input).
pub fn k_with_fee_ok(
    res_a_in: i128,
    res_b_in: i128,
    res_a_out: i128,
    res_b_out: i128,
    fee: Fee,
) -> bool {
    if !fee.is_valid() || res_a_out < 0 || res_b_out < 0 {
        return false;
    }
    let in_a = pos(res_a_out - res_a_in);
    let in_b = pos(res_b_out - res_b_in);
    let big = BigInt::from;
    let eff_a = big(res_a_out) * big(fee.den) - big(fee.num) * big(in_a);
    let eff_b = big(res_b_out) * big(fee.den) - big(fee.num) * big(in_b);
    let lhs = eff_a * eff_b;
    let rhs = big(res_a_in) * big(res_b_in) * big(fee.den) * big(fee.den);
    lhs >= rhs
}

/// Forward Uniswap-v2 swap with a fee on the input side: the maximum output the
/// pool can pay (`dy`) for an input `dx`, such that [`k_with_fee_ok`] still holds.
///
/// `dy = floor( res_out · dx · γ / (res_in · fee_den + dx · γ) )`, `γ = fee_den − fee_num`.
///
/// Floor keeps `dy` on the conservative side, so a residual routed at exactly this
/// rate always satisfies the on-chain `k`-check. Returns `0` for a non-positive
/// `dx` or a degenerate/empty pool.
pub fn swap_out(res_in: i128, res_out: i128, dx: i128, fee: Fee) -> i128 {
    if dx <= 0 || res_in <= 0 || res_out <= 0 || !fee.is_valid() {
        return 0;
    }
    let g = fee.gamma();
    let num = BigInt::from(res_out) * BigInt::from(dx) * BigInt::from(g);
    let den = BigInt::from(res_in) * BigInt::from(fee.den) + BigInt::from(dx) * BigInt::from(g);
    // den > 0 here, num ≥ 0, so floor == truncation.
    let dy = num / den;
    i128::try_from(dy).unwrap_or(0)
}

/// The Rev-25 **two-sided price pin** (mirrors `spend.pool_settle`'s underpay floor):
/// the pool must release the FULL curve amount for the net residual it absorbed, within
/// `eps` sub-units. `k_with_fee_ok` separately caps the TOP (overpayment); this is the
/// LOWER edge that closes the floor→fair corridor. `eps = n_orders` (the absolute,
/// batch-size-derived dust band — never a fraction of `k`). Vacuous when there is no
/// residual (perfectly-netted) or on a donation (both sides ≥ 0). A solver MUST size its
/// residual payout so this holds, or the on-chain `pool` validator rejects the settlement.
pub fn pin_ok(
    res_a_in: i128,
    res_b_in: i128,
    res_a_out: i128,
    res_b_out: i128,
    fee: Fee,
    eps: i128,
) -> bool {
    let net_a = res_a_out - res_a_in;
    let net_b = res_b_out - res_b_in;
    if net_a > 0 && net_b < 0 {
        // pool took asset_a, paid asset_b
        -net_b >= swap_out(res_a_in, res_b_in, net_a, fee) - eps
    } else if net_b > 0 && net_a < 0 {
        // pool took asset_b, paid asset_a (symmetric)
        -net_a >= swap_out(res_b_in, res_a_in, net_b, fee) - eps
    } else {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fee_3_1000() -> Fee {
        Fee { num: 3, den: 1000 }
    }

    #[test]
    fn reserve_carves_pool_min_ada_only_for_ada() {
        let tok = AssetId::new(vec![0x33u8; 28], b"T".to_vec());
        let v = Value::from_lovelace(5_000_000).add(&tok.policy, &tok.name, 1_234);
        assert_eq!(reserve_of(&v, &AssetId::ada()), 5_000_000 - POOL_MIN_ADA);
        assert_eq!(reserve_of(&v, &tok), 1_234);
    }

    #[test]
    fn swap_out_satisfies_k_check() {
        // pool 1e9 / 1e9, push 1_000_000 of A in.
        let (ra, rb) = (1_000_000_000i128, 1_000_000_000i128);
        let dx = 1_000_000;
        let dy = swap_out(ra, rb, dx, fee_3_1000());
        assert!(dy > 0 && dy < dx); // pays out less than input (price impact + fee)
        assert!(k_with_fee_ok(ra, rb, ra + dx, rb - dy, fee_3_1000()));
        // paying one extra unit must break the k-check (floor is tight).
        assert!(!k_with_fee_ok(ra, rb, ra + dx, rb - (dy + 1), fee_3_1000()));
    }

    #[test]
    fn pin_ok_boundary_matches_contract() {
        // mirrors clearing_test::prop_pin_fair_boundary / pool_settle_dust_*: with eps=0 the
        // pool must pay EXACTLY the fair curve amount; eps widens the band by that many units.
        let f = fee_3_1000();
        let (ra, rb) = (1_000_000_000i128, 1_000_000_000i128);
        let dx = 1_000_000;
        let fair = swap_out(ra, rb, dx, f);
        // eps = 0: pay fair -> ok; pay fair-1 -> rejected; pay fair+1 -> rejected by k (here pin
        // is vacuous on overpay, but k_with_fee_ok catches it — both gates run in the solver).
        assert!(pin_ok(ra, rb, ra + dx, rb - fair, f, 0));
        assert!(!pin_ok(ra, rb, ra + dx, rb - (fair - 1), f, 0));
        // eps = 1 (one order): fair-1 now within the dust band; fair-2 still rejected.
        assert!(pin_ok(ra, rb, ra + dx, rb - (fair - 1), f, 1));
        assert!(!pin_ok(ra, rb, ra + dx, rb - (fair - 2), f, 1));
        // overpay (fair+1) leaves the pin vacuous-or-true but BREAKS k — the solver requires both.
        assert!(!k_with_fee_ok(ra, rb, ra + dx, rb - (fair + 1), f));
        // perfectly-netted (no residual) is always pin-ok.
        assert!(pin_ok(ra, rb, ra, rb, f, 0));
    }

    #[test]
    fn pin_ok_symmetric_in_the_b_to_a_direction() {
        // The mirror branch of `pin_ok_boundary_matches_contract`: the pool TAKES
        // asset_b and PAYS asset_a. It must release the full curve amount (within eps),
        // exactly like the a→b case — this guards the symmetric arm of `pin_ok`.
        let f = fee_3_1000();
        let (ra, rb) = (1_000_000_000i128, 1_000_000_000i128);
        let db = 1_000_000; // asset_b pushed into the pool
        let fair_a = swap_out(rb, ra, db, f); // asset_a the pool owes for `db` of b
                                              // pay fair_a -> ok; fair_a-1 -> rejected at eps=0; within the dust band at eps=1.
        assert!(pin_ok(ra, rb, ra - fair_a, rb + db, f, 0));
        assert!(!pin_ok(ra, rb, ra - (fair_a - 1), rb + db, f, 0));
        assert!(pin_ok(ra, rb, ra - (fair_a - 1), rb + db, f, 1));
        assert!(!pin_ok(ra, rb, ra - (fair_a - 2), rb + db, f, 1));
        // a pure donation (both reserves only grow) is vacuously pin-ok.
        assert!(pin_ok(ra, rb, ra + 5, rb + 5, f, 0));
    }

    #[test]
    fn k_check_matches_contract_fee_cases() {
        // mirrors clearing_test: pool_fee_ok / pool_fee_short / pool_fee_no_residual.
        let f = fee_3_1000();
        assert!(k_with_fee_ok(1_000_000, 1_000_000, 1_010_000, 991_000, f));
        assert!(k_with_fee_ok(1_000_000, 1_000_000, 991_000, 1_010_000, f));
        assert!(!k_with_fee_ok(1_000_000, 1_000_000, 1_010_000, 990_100, f)); // fee not covered
        assert!(k_with_fee_ok(1_000_000, 1_000_000, 1_000_000, 1_000_000, f)); // no residual
        assert!(!k_with_fee_ok(1_000_000, 1_000_000, 1_010_000, 950_000, f)); // k drops
    }
}
