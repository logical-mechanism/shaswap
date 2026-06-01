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
