//! Pure arithmetic the chain layer uses to finalize a settlement body — the parts
//! that don't depend on a live node or any external JSON, so they're tested exactly.
//!
//! Left for the live integration (needs a node): the Kupo/Ogmios HTTP transport,
//! the exact `script_data_hash` over the protocol cost models, and fee *balancing*
//! (size depends on fee depends on size — solved by iterating once ex-units are
//! known). These helpers are the deterministic building blocks of that loop.

use crate::backend::{ExUnits, ProtocolParams};

/// `ceil(a * b / c)` for non-negative inputs (`c > 0`), in `u128` to avoid overflow.
fn mul_div_ceil(a: u64, b: u64, c: u64) -> u64 {
    let n = a as u128 * b as u128;
    n.div_ceil(c as u128) as u64
}

/// The Plutus script-execution fee for a total ex-unit budget: `price_mem·mem +
/// price_step·steps`, each term rounded up (prices are exact rationals). This is
/// the variable part the EvaluateTx result feeds; the size-based part
/// (`min_fee_a·size + min_fee_b`) is added by the balancer once the tx is encoded.
pub fn script_exec_fee(params: &ProtocolParams, total: ExUnits) -> u64 {
    let (mem_n, mem_d) = params.price_mem;
    let (step_n, step_d) = params.price_step;
    mul_div_ceil(total.mem, mem_n, mem_d) + mul_div_ceil(total.steps, step_n, step_d)
}

/// The size-based fee component: `min_fee_a · tx_size_bytes + min_fee_b`.
pub fn size_fee(params: &ProtocolParams, tx_size_bytes: u64) -> u64 {
    params.min_fee_a.saturating_mul(tx_size_bytes) + params.min_fee_b
}

/// Sum every redeemer's ex-units into one budget (the tx-wide script cost).
pub fn total_ex_units<I: IntoIterator<Item = ExUnits>>(units: I) -> ExUnits {
    units
        .into_iter()
        .fold(ExUnits { mem: 0, steps: 0 }, |a, u| ExUnits {
            mem: a.mem.saturating_add(u.mem),
            steps: a.steps.saturating_add(u.steps),
        })
}

/// Convert a POSIX-ms instant (an order deadline) to the slot whose start is at or
/// before it — the value to put in the tx's `ttl`. Assumes a constant slot length
/// since `system_start_ms` (true on preprod/mainnet in the current era; a
/// multi-era summary would generalize this). `slot_length_ms > 0`.
///
/// We floor (largest slot whose start ≤ the deadline) so the tx's upper time bound,
/// which the ledger derives from `ttl`, never exceeds the deadline the anchor checks.
pub fn posix_to_slot(posix_ms: i64, system_start_ms: i64, slot_length_ms: i64) -> u64 {
    if posix_ms <= system_start_ms || slot_length_ms <= 0 {
        return 0;
    }
    ((posix_ms - system_start_ms) / slot_length_ms) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> ProtocolParams {
        // mainnet-style values: price_mem 577/10000, price_step 721/10_000_000.
        ProtocolParams {
            min_fee_a: 44,
            min_fee_b: 155_381,
            price_mem: (577, 10_000),
            price_step: (721, 10_000_000),
            max_tx_ex_units: ExUnits {
                mem: 14_000_000,
                steps: 10_000_000_000,
            },
            coins_per_utxo_byte: 4_310,
        }
    }

    #[test]
    fn exec_fee_rounds_each_term_up() {
        // mem 1_000_000 * 577/10000 = 57_700 exact; steps 500_000_000 * 721/1e7 = 36_050 exact.
        let f = script_exec_fee(
            &params(),
            ExUnits {
                mem: 1_000_000,
                steps: 500_000_000,
            },
        );
        assert_eq!(f, 57_700 + 36_050);
        // a non-divisible budget rounds up, never down.
        let f2 = script_exec_fee(&params(), ExUnits { mem: 1, steps: 1 });
        assert_eq!(f2, 1 + 1); // ceil(577/10000)=1, ceil(721/1e7)=1
    }

    #[test]
    fn size_fee_is_linear() {
        assert_eq!(size_fee(&params(), 1000), 44 * 1000 + 155_381);
    }

    #[test]
    fn ex_units_sum() {
        let t = total_ex_units([
            ExUnits {
                mem: 10,
                steps: 100,
            },
            ExUnits { mem: 5, steps: 50 },
        ]);
        assert_eq!(
            t,
            ExUnits {
                mem: 15,
                steps: 150
            }
        );
    }

    #[test]
    fn posix_to_slot_floors() {
        // preprod: system start 1654041600000 ms, 1000 ms/slot.
        let start = 1_654_041_600_000;
        assert_eq!(posix_to_slot(start, start, 1000), 0);
        assert_eq!(posix_to_slot(start + 1500, start, 1000), 1); // floors 1.5 -> 1
        assert_eq!(posix_to_slot(start - 1, start, 1000), 0);
    }
}
