//! The v1 **floor-only** clearing algorithm — a *valid* solver, not an optimal
//! one (BLUEPRINT §5.2.7; surplus-maximizing solving is a later layer).
//!
//! Strategy: pick one uniform price `p` (asset_b per asset_a), include every order
//! whose own floor holds at `p`, let opposing orders **net** against each other,
//! and route the leftover residual through the pool — choosing `p` so the pool's
//! `k`-with-fee invariant still holds on that residual.
//!
//! Why the price can't just be the pool spot price: at spot, *any* non-zero
//! residual makes the pool overpay (slippage + fee), so only a perfectly-netted
//! batch clears at spot. A residual needs a price strictly on the pool's side. We
//! therefore scan the candidate prices where order inclusion changes (each order's
//! floor price) plus the spot, keep every price whose residual passes the
//! `k`-check, and choose the feasible one that clears the most user volume.
//!
//! Every returned settlement is **re-verified** against the [`clearing`] pin
//! generator *and* [`curve::k_with_fee_ok`] before it is handed back, so this
//! module can under-solve (a liveness limitation, acceptable in v1) but can never
//! emit a settlement the chain would reject (the safety property).

use crate::clearing::{self, Price, Settlement};
use crate::curve::{self, Fee};
use crate::output::{OrderInput, PoolInput};
use num_integer::Integer;

/// A solved, fully-verified batch ready for `txbuild`.
#[derive(Clone, Debug)]
pub struct SolveResult {
    pub price: Price,
    /// The included orders in canonical input order (the order `txbuild` must use).
    pub orders: Vec<OrderInput>,
    /// `fills[i]` aligns with `orders[i]` (v1: always a full fill = `sell_amount`).
    pub fills: Vec<i128>,
    /// The pinned settlement (owner/pool/remainder outputs + redeemer).
    pub settlement: Settlement,
    /// User volume cleared, measured in `asset_a` units (sold by token-sellers +
    /// bought by asset_b-sellers) — the objective we maximize.
    pub cleared_volume_a: i128,
}

/// Reduce a price to lowest terms with a positive denominator.
fn reduce(num: i128, den: i128) -> Price {
    debug_assert!(den != 0);
    let (mut n, mut d) = (num, den);
    if d < 0 {
        n = -n;
        d = -d;
    }
    let g = n.abs().gcd(&d);
    if g > 1 {
        Price {
            num: n / g,
            den: d / g,
        }
    } else {
        Price { num: n, den: d }
    }
}

/// An order's floor price as a `Price` (asset_b per asset_a) — the boundary at
/// which it just clears. A market order (`limit == 0`) has floor price `0`.
fn floor_price(order: &OrderInput) -> Price {
    let d = &order.datum;
    if d.sell_a {
        // token-seller wants p ≥ limit/sell_amount.
        reduce(d.limit, d.sell_amount.max(1))
    } else {
        // asset_b-seller wants p ≤ sell_amount/limit (∞ if limit == 0).
        if d.limit == 0 {
            // effectively +∞; represent as a very large price.
            Price {
                num: i128::MAX / 2,
                den: 1,
            }
        } else {
            reduce(d.sell_amount, d.limit)
        }
    }
}

/// The pool's instantaneous spot price `res_b / res_a` as a reduced `Price`.
fn spot_price(res_a: i128, res_b: i128) -> Option<Price> {
    if res_a > 0 && res_b > 0 {
        Some(reduce(res_b, res_a))
    } else {
        None
    }
}

/// Does `order`'s floor hold at price `p`?
fn included_at(order: &OrderInput, p: Price) -> bool {
    clearing::floor_ok(&order.datum, p).unwrap_or(false)
}

/// Evaluate a candidate price: the included orders (canonical order) + the net
/// pool movement, and whether the pool `k`-check passes. Returns `None` if the
/// candidate yields no orders or overflows.
fn evaluate(
    orders: &[OrderInput],
    p: Price,
    res_a: i128,
    res_b: i128,
    fee: Fee,
) -> Option<Candidate> {
    let mut included = Vec::new();
    let mut net_a: i128 = 0;
    let mut net_b: i128 = 0;
    let mut volume_a: i128 = 0;
    for o in orders {
        if !included_at(o, p) {
            continue;
        }
        let f = o.datum.sell_amount;
        let recv = clearing::received_for(o.datum.sell_a, f, p).ok()?;
        if o.datum.sell_a {
            net_a = net_a.checked_add(f)?;
            net_b = net_b.checked_sub(recv)?;
            volume_a = volume_a.checked_add(f)?;
        } else {
            net_a = net_a.checked_sub(recv)?;
            net_b = net_b.checked_add(f)?;
            volume_a = volume_a.checked_add(recv)?;
        }
        included.push(o.clone());
    }
    if included.is_empty() {
        return None;
    }
    let feasible = curve::k_with_fee_ok(res_a, res_b, res_a + net_a, res_b + net_b, fee);
    Some(Candidate {
        price: p,
        included,
        volume_a,
        residual_a: net_a.unsigned_abs() as i128,
        feasible,
    })
}

struct Candidate {
    price: Price,
    included: Vec<OrderInput>,
    volume_a: i128,
    /// Net residual routed through the pool (asset_a units, absolute).
    residual_a: i128,
    feasible: bool,
}

/// The supply/demand **balance price**: the uniform `p` at which the two sides net
/// to zero. From `net_a = Σ_tok sell − Σ_ada sell/p = 0`:
///   `p = (Σ asset_b sold) / (Σ asset_a sold)`.
/// This is the CoW clearing price — at it the pool is (nearly) untouched, so it
/// always satisfies the k-check and gives the best user surplus. Returns `None` if
/// either side is empty (no two-sided netting possible).
fn balance_price(orders: &[OrderInput]) -> Option<Price> {
    let mut s_tok: i128 = 0; // Σ asset_a sold (token-sellers)
    let mut s_ada: i128 = 0; // Σ asset_b sold (asset_b-sellers)
    for o in orders {
        if o.datum.sell_a {
            s_tok = s_tok.checked_add(o.datum.sell_amount)?;
        } else {
            s_ada = s_ada.checked_add(o.datum.sell_amount)?;
        }
    }
    if s_tok > 0 && s_ada > 0 {
        Some(reduce(s_ada, s_tok))
    } else {
        None
    }
}

/// A price nudged by `bps` basis points (positive = higher). Used to add
/// pool-favoring neighbors of the balance price so a tiny rounding residual still
/// clears the k-check.
fn nudge(p: Price, bps: i128) -> Price {
    reduce(p.num * (10_000 + bps), p.den * 10_000)
}

/// Solve a batch: returns the best floor-only settlement, or `None` if no
/// non-empty feasible batch exists at any candidate price.
pub fn solve(orders: &[OrderInput], pool: &PoolInput) -> Option<SolveResult> {
    let d = &pool.datum;
    let fee = Fee::from_datum(d);
    let res_a = curve::reserve_of(&pool.value, &d.asset_a);
    let res_b = curve::reserve_of(&pool.value, &d.asset_b);

    // Only orders consenting to THIS pool can ever be included.
    let orders: Vec<OrderInput> = orders
        .iter()
        .filter(|o| o.datum.pool_nft == d.nft)
        .cloned()
        .collect();
    if orders.is_empty() {
        return None;
    }

    // Candidate prices, in priority order of economic quality:
    //  - the supply/demand balance price (CoW clearing) + pool-favoring nudges,
    //    which clear the most volume with the least pool reliance;
    //  - the pool spot price (covers a perfectly-netted batch);
    //  - each order's floor price, the inclusion breakpoints (the fallback that
    //    routes a one-sided residual through the pool at a feasible price).
    let mut candidates: Vec<Price> = Vec::new();
    if let Some(bp) = balance_price(&orders) {
        // exact balance + small nudges each way so a rounding residual still clears.
        candidates.push(bp);
        for bps in [1, 5, 25, 100, -1, -5, -25, -100] {
            candidates.push(nudge(bp, bps));
        }
    }
    if let Some(sp) = spot_price(res_a, res_b) {
        candidates.push(sp);
    }
    candidates.extend(orders.iter().map(floor_price));

    // Pick the feasible candidate clearing the most user volume; tie-break toward
    // the smallest pool residual (highest netting → best surplus, lowest LVR).
    let mut best: Option<Candidate> = None;
    for p in candidates {
        if p.num <= 0 || p.den <= 0 {
            continue;
        }
        let Some(cand) = evaluate(&orders, p, res_a, res_b, fee) else {
            continue;
        };
        if !cand.feasible {
            continue;
        }
        // Objective: include the most orders (price-independent welfare proxy),
        // then minimize the pool residual (max netting → best surplus, least LVR).
        // We deliberately do NOT rank by `volume_a`: it counts asset_b-sellers'
        // *received* asset_a, which a lower price inflates, biasing the choice.
        let better = match &best {
            None => true,
            Some(b) => {
                let (n, bn) = (cand.included.len(), b.included.len());
                n > bn || (n == bn && cand.residual_a < b.residual_a)
            }
        };
        if better {
            best = Some(cand);
        }
    }

    let best = best?;
    // Re-pin and re-verify: canonical-sort, build the settlement, confirm the
    // pool k-check on the actual net. We never return an unverified settlement.
    let mut chosen = best.included;
    chosen.sort_by_key(clearing::canonical_key);
    let fills: Vec<i128> = chosen.iter().map(|o| o.datum.sell_amount).collect();
    let settlement = clearing::build_settlement(&chosen, &fills, pool, best.price, None).ok()?;
    let res_a_out = curve::reserve_of(&settlement.pool_output.value, &d.asset_a);
    let res_b_out = curve::reserve_of(&settlement.pool_output.value, &d.asset_b);
    if !curve::k_with_fee_ok(res_a, res_b, res_a_out, res_b_out, fee) {
        return None;
    }

    Some(SolveResult {
        price: best.price,
        orders: chosen,
        fills,
        settlement,
        cleared_volume_a: best.volume_a,
    })
}
