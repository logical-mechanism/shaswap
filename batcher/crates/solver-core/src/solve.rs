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
//! Capping (`solve_capped`): when the per-tx cap truncates a netted book, pricing the
//! kept subset at the *full-book* balance price is self-defeating — that price is
//! tuned for the full book's zero residual, so the truncated subset's leftover
//! residual fails the `k`-check and the whole batch is rejected. We therefore (a)
//! interleave the two sides so a truncated batch stays balanced, and (b) re-price the
//! chosen subset at *its own* balance price (+ nudges) so a capped netted batch nets
//! internally and clears. Without this a netted book larger than the cap would settle
//! as the whole book or not at all — see `cap_tests::capped_netted_book_still_clears`.
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
    max_orders: usize,
) -> Option<Candidate> {
    let mut included = Vec::new();
    let mut net_a: i128 = 0;
    let mut net_b: i128 = 0;
    let mut volume_a: i128 = 0;
    for o in orders {
        // Per-tx cap: a batch holds at most `max_orders`; the rest are drained by
        // the next chained tx. Stop once the batch is full.
        if included.len() >= max_orders {
            break;
        }
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
    // (Rev 25) feasibility is now TWO-sided: k caps overpayment, the pin caps underpayment
    // (the pool must release the full curve amount for its residual, within eps=n_orders).
    // A candidate that clears one-sided flow at an order floor — what v1 used to pick — now
    // fails the pin and is correctly dropped; the fair-price candidate below replaces it.
    let n = included.len() as i128;
    let feasible = curve::k_with_fee_ok(res_a, res_b, res_a + net_a, res_b + net_b, fee)
        && curve::pin_ok(res_a, res_b, res_a + net_a, res_b + net_b, fee, n);
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

/// Pool-favoring neighbors (basis points) of a balance price, so a tiny rounding
/// residual still clears the k-check. Both signs are tried: the residual's direction
/// decides which one lands on the pool's side.
const PRICE_NUDGES_BPS: [i128; 8] = [1, 5, 25, 100, -1, -5, -25, -100];

/// Reorder orders so the two sides alternate, so a *capped* (truncated) batch keeps
/// both sides and can net — instead of going one-sided by input/discovery order,
/// which forces the whole batch through the pool. Stable within each side; a no-op
/// for a one-sided book or when the cap exceeds the book (every order is included).
fn interleave_sides(orders: &[OrderInput]) -> Vec<OrderInput> {
    let (toks, adas): (Vec<OrderInput>, Vec<OrderInput>) =
        orders.iter().cloned().partition(|o| o.datum.sell_a);
    let mut out = Vec::with_capacity(orders.len());
    let (mut i, mut j) = (0usize, 0usize);
    while i < toks.len() || j < adas.len() {
        if i < toks.len() {
            out.push(toks[i].clone());
            i += 1;
        }
        if j < adas.len() {
            out.push(adas[j].clone());
            j += 1;
        }
    }
    out
}

/// Re-price an already-selected capped subset at the subset's OWN balance price
/// (+ nudges) and return the feasible candidates. Capping a netted book at the
/// *full-book* price leaves a residual the pool rejects (the full-book price is tuned
/// for the full-book's zero residual, not the subset's); re-balancing to the chosen
/// subset nets it internally so the k-check passes. The subset is ≤ `max_orders`, so
/// `evaluate` never truncates it further — an order is dropped only if its own floor
/// fails at the refined price. Empty for a one-sided subset (no two-sided balance).
fn refine_to_subset(
    subset: &[OrderInput],
    res_a: i128,
    res_b: i128,
    fee: Fee,
    max_orders: usize,
) -> Vec<Candidate> {
    let Some(bp) = balance_price(subset) else {
        return Vec::new();
    };
    std::iter::once(bp)
        .chain(PRICE_NUDGES_BPS.iter().map(|&b| nudge(bp, b)))
        .filter(|p| p.num > 0 && p.den > 0)
        .filter_map(|p| evaluate(subset, p, res_a, res_b, fee, max_orders))
        .collect()
}

/// The pool residual `(net_a, net_b)` a fixed `included` set produces at price `p`,
/// with every order filled fully (the solver's default). Mirrors `evaluate`'s
/// accumulation and `clearing::received_for`'s rounding, so it agrees with the pin.
fn residual_at(included: &[OrderInput], p: Price) -> Option<(i128, i128)> {
    let mut net_a: i128 = 0;
    let mut net_b: i128 = 0;
    for o in included {
        let f = o.datum.sell_amount;
        let recv = clearing::received_for(o.datum.sell_a, f, p).ok()?;
        if o.datum.sell_a {
            net_a = net_a.checked_add(f)?;
            net_b = net_b.checked_sub(recv)?;
        } else {
            net_a = net_a.checked_sub(recv)?;
            net_b = net_b.checked_add(f)?;
        }
    }
    Some((net_a, net_b))
}

/// (Rev 25) The **fair-equilibrium price**: the uniform `p` at which the included set's
/// pool residual lands exactly on the constant-product curve — i.e. the pool pays
/// `swap_out(net_a)` for its net input, so the Rev-25 pin holds and every order clears at
/// the curve-execution price (not its floor). For a one-sided book `net_a` is constant, so
/// `p = swap_out(net_a)/net_a` converges in one step; for a mixed book the residual depends
/// weakly on `p` (b-sellers' received), so we iterate the map to its fixed point. Returns
/// `None` for a degenerate pool or a perfectly-netted set (any price works — handled by
/// `balance_price`/`spot`).
fn fair_price(included: &[OrderInput], res_a: i128, res_b: i128, fee: Fee) -> Option<Price> {
    let mut p = spot_price(res_a, res_b)?;
    for _ in 0..8 {
        let (net_a, net_b) = residual_at(included, p)?;
        let next = if net_a > 0 {
            // pool gains asset_a, pays asset_b: fair price (b per a) = swap_out(a→b)/net_a.
            let fair_b = curve::swap_out(res_a, res_b, net_a, fee);
            if fair_b <= 0 {
                return None;
            }
            reduce(fair_b, net_a)
        } else if net_a < 0 {
            // pool gains asset_b (net_b > 0), pays asset_a: fair price = net_b / swap_out(b→a).
            let fair_a = curve::swap_out(res_b, res_a, net_b, fee);
            if fair_a <= 0 {
                return None;
            }
            reduce(net_b, fair_a)
        } else {
            // zero residual: perfectly netted, any price clears — keep the current guess.
            return Some(p);
        };
        if next == p {
            break;
        }
        p = next;
    }
    Some(p)
}

/// Re-price an included subset at its **fair-equilibrium price** (+ pool-favouring nudges
/// for the per-order rounding) and return the feasible candidates. This is the Rev-25
/// replacement for clearing one-sided/imbalanced residuals at an order floor: the fair
/// price makes the pool pay the full curve amount, satisfying the two-sided pin.
fn refine_to_fair(
    subset: &[OrderInput],
    res_a: i128,
    res_b: i128,
    fee: Fee,
    max_orders: usize,
) -> Vec<Candidate> {
    let Some(fp) = fair_price(subset, res_a, res_b, fee) else {
        return Vec::new();
    };
    std::iter::once(fp)
        .chain(PRICE_NUDGES_BPS.iter().map(|&b| nudge(fp, b)))
        .filter(|p| p.num > 0 && p.den > 0)
        .filter_map(|p| evaluate(subset, p, res_a, res_b, fee, max_orders))
        .collect()
}

/// Solve a batch: returns the best floor-only settlement, or `None` if no
/// non-empty feasible batch exists at any candidate price.
pub fn solve(orders: &[OrderInput], pool: &PoolInput) -> Option<SolveResult> {
    solve_capped(orders, pool, usize::MAX)
}

/// Like [`solve`], but include at most `max_orders` in the settlement (the per-tx
/// cap). A pool with more settleable orders is drained by chaining several capped
/// settlements, each re-solved against the previous one's pool output. Still
/// re-verifies every result against the pin generator + k-check (never invalid).
pub fn solve_capped(
    orders: &[OrderInput],
    pool: &PoolInput,
    max_orders: usize,
) -> Option<SolveResult> {
    let d = &pool.datum;
    let fee = Fee::from_datum(d);
    // Defense-in-depth against a junk pool datum. `pool_mint` validates the fee at
    // creation, but a *discovered* pool is read straight off-chain, so re-check at the
    // solver entry: an out-of-range fee (num<0, den<=0, or num>=den) would otherwise
    // produce a wrong clearing or a divide-by-zero in the curve math (`gamma = den−num`
    // hits the denominator). Refuse to solve such a pool — the orchestrator skips it.
    if !fee.is_valid() {
        return None;
    }
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

    // When capping, prefer a BALANCED subset: interleave the two sides so a truncated
    // batch keeps both and can net, instead of going one-sided by discovery order.
    // No-op when uncapped (all included) or one-sided.
    let ordered = interleave_sides(&orders);

    // Candidate prices, in priority order of economic quality:
    //  - the supply/demand balance price (CoW clearing) + pool-favoring nudges,
    //    which clear the most volume with the least pool reliance;
    //  - the pool spot price (covers a perfectly-netted batch);
    //  - each order's floor price, the inclusion breakpoints (the fallback that
    //    routes a one-sided residual through the pool at a feasible price).
    let mut candidates: Vec<Price> = Vec::new();
    if let Some(bp) = balance_price(&ordered) {
        // exact balance + small nudges each way so a rounding residual still clears.
        candidates.push(bp);
        for bps in PRICE_NUDGES_BPS {
            candidates.push(nudge(bp, bps));
        }
    }
    if let Some(sp) = spot_price(res_a, res_b) {
        candidates.push(sp);
    }
    candidates.extend(ordered.iter().map(floor_price));

    // Pick the feasible candidate clearing the most user volume; tie-break toward the
    // smallest pool residual (highest netting → best surplus, lowest LVR). For each
    // base price we ALSO try re-pricing the selected subset to its own balance price
    // (`refine_to_subset`): when the cap truncates a netted book, the full-book price
    // leaves a residual the pool rejects, but the subset's own balance price nets it
    // internally and clears the k-check — so a capped netted book still settles.
    let mut best: Option<Candidate> = None;
    for p in candidates {
        if p.num <= 0 || p.den <= 0 {
            continue;
        }
        let Some(cand) = evaluate(&ordered, p, res_a, res_b, fee, max_orders) else {
            continue;
        };
        let refined = refine_to_subset(&cand.included, res_a, res_b, fee, max_orders);
        // (Rev 25) also re-price this subset at its fair-equilibrium price — the candidate
        // that satisfies the two-sided pin for a one-sided/imbalanced residual (where the
        // old floor-price candidate is now infeasible). Netted books still win via balance.
        let fair = refine_to_fair(&cand.included, res_a, res_b, fee, max_orders);
        for c in std::iter::once(cand).chain(refined).chain(fair) {
            if !c.feasible {
                continue;
            }
            // Objective: include the most orders (price-independent welfare proxy),
            // then minimize the pool residual (max netting → best surplus, least LVR).
            // We deliberately do NOT rank by `volume_a`: it counts asset_b-sellers'
            // *received* asset_a, which a lower price inflates, biasing the choice.
            let better = match &best {
                None => true,
                Some(b) => {
                    let (n, bn) = (c.included.len(), b.included.len());
                    n > bn || (n == bn && c.residual_a < b.residual_a)
                }
            };
            if better {
                best = Some(c);
            }
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
    // (Rev 25) re-verify BOTH on-chain gates on the actual net: the k-check (top) and the
    // two-sided price pin (bottom, eps = order count). Never return a settlement the `pool`
    // validator would reject — if even the fair candidate misses the dust band, under-solve.
    let eps = chosen.len() as i128;
    if !curve::k_with_fee_ok(res_a, res_b, res_a_out, res_b_out, fee)
        || !curve::pin_ok(res_a, res_b, res_a_out, res_b_out, fee, eps)
    {
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

#[cfg(test)]
mod cap_tests {
    use super::*;
    use crate::output::Address;
    use crate::types::{
        AssetId, Credential, OrderDatum, OutputReference, PoolDatum, NFT_NAME, ORDER_MIN_ADA,
        POOL_MIN_ADA,
    };
    use crate::value::Value;

    fn tok() -> AssetId {
        AssetId::new(vec![0x33u8; 28], b"T".to_vec())
    }
    fn nft() -> AssetId {
        AssetId::new(vec![0x44u8; 28], NFT_NAME.to_vec())
    }

    fn pool(res_tok: i128, res_ada: i128) -> PoolInput {
        PoolInput {
            output_reference: OutputReference {
                transaction_id: vec![0xd1u8; 32],
                output_index: 0,
            },
            address: Address {
                payment: Credential::Script(vec![0x99u8; 28]),
                stake: Some(Credential::Script(vec![0x55u8; 28])),
            },
            value: Value::from_lovelace(res_ada + POOL_MIN_ADA)
                .add(&tok().policy, &tok().name, res_tok)
                .add(&nft().policy, &nft().name, 1),
            datum: PoolDatum {
                nft: nft(),
                asset_a: tok(),
                asset_b: AssetId::ada(),
                fee_num: 3,
                fee_den: 1000,
                creator: Credential::VerificationKey(vec![0xb1u8; 28]),
            },
        }
    }

    // A token-seller selling `sell` token with a loose floor (clears near spot).
    fn token_seller(i: u8, sell: i128, limit: i128) -> OrderInput {
        OrderInput {
            output_reference: OutputReference {
                transaction_id: vec![i; 32],
                output_index: 0,
            },
            address: Address {
                payment: Credential::Script(vec![0x0bu8; 28]),
                stake: Some(Credential::Script(vec![0x55u8; 28])),
            },
            value: Value::from_lovelace(ORDER_MIN_ADA + 2_000_000).add(
                &tok().policy,
                &tok().name,
                sell,
            ),
            datum: OrderDatum {
                owner: Credential::VerificationKey(vec![0xb1u8; 28]),
                owner_stake: None,
                pool_nft: nft(),
                sell_a: true,
                sell_amount: sell,
                limit,
                tip: 2_000_000,
                partial: false,
                deadline: None,
            },
        }
    }

    #[test]
    fn cap_limits_included_orders_and_uncapped_includes_more() {
        // Deep pool so all five loosely-priced token-sellers clear (no floor bind).
        let pool = pool(1_000_000_000_000, 1_000_000_000_000);
        // spot ≈ 1 ADA/token; floor 800k ADA for 1M token is well below spot.
        let orders: Vec<OrderInput> = (0..5)
            .map(|i| token_seller(i, 1_000_000, 800_000))
            .collect();

        let capped = solve_capped(&orders, &pool, 2).expect("a capped settlement");
        assert_eq!(capped.orders.len(), 2, "cap of 2 must include exactly 2");

        let uncapped = solve(&orders, &pool).expect("an uncapped settlement");
        assert!(
            uncapped.orders.len() > capped.orders.len(),
            "no-cap solve includes more than the capped batch ({} vs {})",
            uncapped.orders.len(),
            capped.orders.len()
        );

        // A cap >= the book settles the whole book in one batch.
        let big = solve_capped(&orders, &pool, 99).expect("settlement");
        assert_eq!(big.orders.len(), uncapped.orders.len());
    }

    // (Rev 25) THE corridor fix, end-to-end in the solver: a one-sided book with a near-zero
    // (market) floor. Pre-Rev-25 the solver cleared this at an order floor price — banking the
    // floor→fair gap into k. Now the two-sided pin forces the FAIR curve price, so the trader
    // receives ~get_amount_out(sell), not ~their floor, and the settlement passes the pin.
    #[test]
    fn one_sided_market_order_clears_at_fair_not_floor() {
        let (res, dx) = (1_000_000_000_000i128, 1_000_000i128);
        let pool = pool(res, res);
        // limit = 1 ⇒ a market order: pre-fix it could be paid as little as ~1 lovelace.
        let orders = vec![token_seller(0, dx, 1)];
        let r = solve(&orders, &pool).expect("a fair settlement must exist");

        let fee = Fee { num: 3, den: 1000 };
        let fair = curve::swap_out(res, res, dx, fee); // = get_amount_out(dx) at the curve
        let paid = -r.settlement.net_b; // ADA the pool paid the trader
        assert!(
            paid >= fair - 1 && paid <= fair,
            "must clear at the fair curve price: paid {paid} vs fair {fair}"
        );
        // and the settlement satisfies the on-chain pin (eps = 1 order) — never rejected.
        assert!(curve::pin_ok(
            res,
            res,
            res + r.settlement.net_a,
            res + r.settlement.net_b,
            fee,
            1
        ));
        // sanity: the trader got ~the curve price (~997k), ~1e6× their market floor of 1.
        assert!(
            paid > 900_000,
            "clearing at the floor would pay far less ({paid})"
        );
    }

    #[test]
    fn rejects_pool_with_invalid_fee() {
        // A junk pool datum whose fee is out of range must be skipped (None), not
        // solved — guards the curve math against divide-by-zero / nonsense clearing.
        let orders = vec![token_seller(0, 1_000_000, 800_000)];
        for (fee_num, fee_den) in [(0i128, 0i128), (1000, 1000), (1001, 1000), (-1, 1000)] {
            let mut p = pool(1_000_000_000_000, 1_000_000_000_000);
            p.datum.fee_num = fee_num;
            p.datum.fee_den = fee_den;
            assert!(
                solve(&orders, &p).is_none(),
                "fee {fee_num}/{fee_den} is invalid and must yield no clearing"
            );
        }
        // sanity: the same orders against a valid-fee pool DO clear.
        assert!(solve(&orders, &pool(1_000_000_000_000, 1_000_000_000_000)).is_some());
    }

    #[test]
    fn capped_solve_holds_across_the_operating_range() {
        // Deep pool so floors never bind; 35 loosely-priced sellers. solve_capped must
        // include EXACTLY the cap N across the live operating range (the proven ceiling
        // is N≈30) and re-verify each result. Guards against a refactor silently breaking
        // capped solving at a particular size — the §13.1 ceiling has no emulator gate, so
        // this solver-level regression is the standing guard for the cap path.
        let pool = pool(1_000_000_000_000, 1_000_000_000_000);
        let orders: Vec<OrderInput> = (0..35u8)
            .map(|i| token_seller(i, 1_000_000, 500_000))
            .collect();
        for n in [1usize, 10, 20, 30] {
            let s = solve_capped(&orders, &pool, n).unwrap_or_else(|| panic!("cap {n} must clear"));
            assert_eq!(s.orders.len(), n, "cap {n} must include exactly {n} orders");
            // owner outputs line up 1:1 with the included orders (build_settlement verified).
            assert_eq!(s.settlement.owner_outputs.len(), n);
        }
    }

    #[test]
    fn cap_of_one_still_produces_a_valid_single_order_batch() {
        let pool = pool(1_000_000_000_000, 1_000_000_000_000);
        let orders: Vec<OrderInput> = (0..3)
            .map(|i| token_seller(i, 1_000_000, 800_000))
            .collect();
        let one = solve_capped(&orders, &pool, 1).expect("a single-order settlement");
        assert_eq!(one.orders.len(), 1);
        // exactly one owner output + the pool output (re-verified by build_settlement).
        assert_eq!(one.settlement.owner_outputs.len(), 1);
    }

    // An asset_b-seller (sells ADA for token) with a loose floor. Mirror of
    // `token_seller` on the other side; distinct owner + ref ids so it never collides.
    fn ada_seller(i: u8, sell: i128, limit: i128) -> OrderInput {
        OrderInput {
            output_reference: OutputReference {
                transaction_id: vec![i; 32],
                output_index: 0,
            },
            address: Address {
                payment: Credential::Script(vec![0x0cu8; 28]),
                stake: Some(Credential::Script(vec![0x55u8; 28])),
            },
            // an ada-seller's UTXO holds the sold ADA + min-ADA + tip (all lovelace).
            value: Value::from_lovelace(ORDER_MIN_ADA + 2_000_000 + sell),
            datum: OrderDatum {
                owner: Credential::VerificationKey(vec![0xb2u8; 28]),
                owner_stake: None,
                pool_nft: nft(),
                sell_a: false,
                sell_amount: sell,
                limit,
                tip: 2_000_000,
                partial: false,
                deadline: None,
            },
        }
    }

    // A netted two-sided book: 4 token-sellers (8M each, floor price 0.5) + 4
    // ada-sellers (12M each, floor cap 2.0). Σ_ada (48M) > Σ_tok (32M) ⇒ the full-book
    // balance price is 1.5 — ABOVE the 1.0 spot. Reserves are only ~10× the per-order
    // size, so a capped subset's residual is large enough to actually fail the k-check
    // at the full-book price (the bug); the fix re-prices the subset to its own
    // balance price. Orders are in [all token, all ada] order so a naive cap truncates
    // to an unbalanced prefix — exactly what trips the old solver.
    fn netted_book() -> (Vec<OrderInput>, PoolInput) {
        let pool = pool(100_000_000, 100_000_000); // spot = 1.0
        let mut orders = Vec::new();
        for i in 0..4u8 {
            orders.push(token_seller(i, 8_000_000, 4_000_000)); // floor price 0.5
        }
        for i in 0..4u8 {
            orders.push(ada_seller(100 + i, 12_000_000, 6_000_000)); // floor cap 2.0
        }
        (orders, pool)
    }

    #[test]
    fn capped_netted_book_still_clears() {
        let (orders, pool) = netted_book();
        // Uncapped: the whole netted book clears at the balance price.
        let full = solve(&orders, &pool).expect("uncapped netted book clears");
        assert_eq!(full.orders.len(), 8);

        // Capped below the book size: a naive solver reuses the full-book price, whose
        // truncated residual fails the k-check → no clearing. The fix re-prices the
        // capped subset to its own balance price (and prefers a balanced subset), so
        // it still settles. This is the case that left posted orders unfulfilled.
        let capped = solve_capped(&orders, &pool, 6)
            .expect("capped netted book must still produce a settlement");
        assert_eq!(capped.orders.len(), 6, "cap of 6 includes exactly 6");

        let four = solve_capped(&orders, &pool, 4).expect("a tighter cap still clears");
        assert_eq!(four.orders.len(), 4);
    }

    #[test]
    fn capped_netted_book_with_uneven_sizes_clears() {
        // Uneven sizes within each side, so even a count-balanced (interleaved) capped
        // subset has a non-zero residual at the full-book price — only the per-subset
        // re-pricing (`refine_to_subset`) makes it net. Guards that path specifically.
        let pool = pool(100_000_000, 100_000_000); // spot = 1.0
        let mut orders = Vec::new();
        for (i, sell) in [10_000_000i128; 4].iter().enumerate() {
            orders.push(token_seller(i as u8, *sell, 5_000_000)); // floor price 0.5
        }
        for (i, sell) in [5_000_000i128, 5_000_000, 25_000_000, 25_000_000]
            .iter()
            .enumerate()
        {
            // floor cap 2.0 ⇒ limit = sell / 2.
            orders.push(ada_seller(100 + i as u8, *sell, sell / 2));
        }
        let full = solve(&orders, &pool).expect("uncapped clears");
        assert_eq!(full.orders.len(), 8);
        let capped = solve_capped(&orders, &pool, 6).expect("uneven netted book caps");
        assert_eq!(capped.orders.len(), 6);
    }
}
