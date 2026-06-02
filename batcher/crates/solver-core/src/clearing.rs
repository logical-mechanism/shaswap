//! The settlement *pin generator* — a faithful, line-for-line port of
//! [`clearing.ak`](../../../contracts/lib/shaswap/clearing.ak)'s `run` / `process`
//! / `check_one`. Given the order inputs (in canonical order), the per-order
//! fills, the pool input, and the clearing price, it produces the **exact**
//! settlement outputs the on-chain anchor will accept — and returns the same
//! errors the anchor's `expect`s would fail on.
//!
//! This is the "oracle of correctness": `txbuild` lowers [`Settlement`] straight
//! into a transaction, and the on-chain anchor re-derives the identical values.
//! If this module and `clearing.ak` ever disagree by one lovelace, the settlement
//! is rejected — so the two are kept structurally identical and cross-checked by
//! golden tests mirroring `clearing_test.ak`.

use crate::output::{Address, Datum, OrderInput, Output, PoolInput};
use crate::types::{BoundDatum, OrderDatum, SettlementRedeemer, ORDER_MIN_ADA};
use crate::value::Value;

/// An exact clearing price `num/den` = amount of `asset_b` per unit of `asset_a`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Price {
    pub num: i128,
    pub den: i128,
}

/// Every way the settlement can be invalid — each maps to an `expect` in
/// `clearing.ak`. `index` is the order's position in canonical input order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClearingError {
    NonPositivePrice,
    DegeneratePair,
    PoolNftNotSingleton,
    PoolBindingMismatch,
    AssetUnderPoolPolicy,
    FillsLengthMismatch,
    OrderWrongPool {
        index: usize,
    },
    DeadlineUnhonorable {
        index: usize,
    },
    FillOutOfRange {
        index: usize,
    },
    PartialNotAllowed {
        index: usize,
    },
    FloorBreach {
        index: usize,
    },
    /// Arithmetic exceeded the solver's `i128` working range (the on-chain
    /// big-int can't overflow; we surface it instead of panicking).
    Overflow,
}

/// A fully-pinned settlement: the canonical output set + the witness redeemer +
/// the economic summary. Output layout matches the anchor exactly: `owner_outputs`
/// are tx outputs `[0, N)`, then `pool_output`, then `remainders`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub redeemer: SettlementRedeemer,
    pub owner_outputs: Vec<Output>,
    pub pool_output: Output,
    pub remainders: Vec<Output>,
    /// Net pool reserve movement in `(asset_a, asset_b)` units.
    pub net_a: i128,
    pub net_b: i128,
    /// Total tip the solver collects now (Σ `tip·f/sell`) — its only income.
    pub tip_taken_total: i128,
}

// ---- checked integer helpers (positive-operand floor/ceil division) ---------

fn mul(a: i128, b: i128) -> Result<i128, ClearingError> {
    a.checked_mul(b).ok_or(ClearingError::Overflow)
}

fn add(a: i128, b: i128) -> Result<i128, ClearingError> {
    a.checked_add(b).ok_or(ClearingError::Overflow)
}

/// Floor of `a*b/c` for non-negative operands (`c > 0`). Aiken's `*` then `/` is
/// truncation toward zero, which equals floor here because every operand is `≥ 0`.
fn mul_div_floor(a: i128, b: i128, c: i128) -> Result<i128, ClearingError> {
    Ok(mul(a, b)? / c)
}

/// Ceil of `a*b/c` for non-negative operands (`c > 0`).
fn mul_div_ceil(a: i128, b: i128, c: i128) -> Result<i128, ClearingError> {
    let p = mul(a, b)?;
    Ok((p + c - 1) / c)
}

/// `clearing.ak::deadline_ok` — an order with a deadline can settle only in a tx
/// bounded to end no later than the deadline.
fn deadline_ok(deadline: Option<i64>, tx_upper: Option<i64>) -> bool {
    match deadline {
        None => true,
        Some(d) => match tx_upper {
            Some(u) => u <= d,
            None => false,
        },
    }
}

/// Per-order result from [`check_one`].
struct OneResult {
    owner_output: Output,
    remainder: Option<Output>,
    d_a: i128,
    d_b: i128,
    tip_taken: i128,
}

/// Port of `clearing.ak::check_one`. Computes the order's owner payout, its signed
/// pool contribution `(d_a, d_b)`, and (if partial) its remainder UTXO.
fn check_one(
    input: &OrderInput,
    f: i128,
    r: &SettlementRedeemer,
    tx_upper: Option<i64>,
    index: usize,
) -> Result<OneResult, ClearingError> {
    let order: &OrderDatum = &input.datum;

    // (C-02) the order consents to THIS pool only.
    if order.pool_nft != r.pool_nft {
        return Err(ClearingError::OrderWrongPool { index });
    }
    if !deadline_ok(order.deadline, tx_upper) {
        return Err(ClearingError::DeadlineUnhonorable { index });
    }
    if f < 1 || f > order.sell_amount {
        return Err(ClearingError::FillOutOfRange { index });
    }
    let is_partial = f < order.sell_amount;
    if is_partial && !order.partial {
        return Err(ClearingError::PartialNotAllowed { index });
    }

    let in_val = &input.value;
    let unsold = order.sell_amount - f;
    let tip_taken = mul_div_floor(order.tip, f, order.sell_amount)?;
    let tip_rem = order.tip - tip_taken;
    let min_to_rem = if is_partial { ORDER_MIN_ADA } else { 0 };

    // price p = asset_b per asset_a. Resolve sold/bought asset, received amount,
    // signed pool delta, and the per-order floor (checked at the full-fill floor).
    let (sold, bought, received, d_a, d_b, floor_ok) = if order.sell_a {
        let recv = mul_div_floor(f, r.price_num, r.price_den)?;
        let floor = mul(order.sell_amount, r.price_num)? >= mul(order.limit, r.price_den)?;
        (&r.asset_a, &r.asset_b, recv, f, -recv, floor)
    } else {
        let recv = mul_div_floor(f, r.price_den, r.price_num)?;
        let floor = mul(order.sell_amount, r.price_den)? >= mul(order.limit, r.price_num)?;
        (&r.asset_b, &r.asset_a, recv, -recv, f, floor)
    };
    if !floor_ok {
        return Err(ClearingError::FloorBreach { index });
    }

    // (1) full-value pin: input − all sold asset + bought asset − (tip + the one
    // min-ADA that funds a partial's remainder). Incidental assets ride to owner.
    let owner_val = in_val
        .add(&sold.policy, &sold.name, -order.sell_amount)
        .add(&bought.policy, &bought.name, received)
        .ada_add(-add(order.tip, min_to_rem)?);

    let owner_output = Output {
        address: Address::payout(order.owner.clone(), order.owner_stake.clone()),
        value: owner_val,
        datum: Datum::Bound(BoundDatum {
            order_ref: input.output_reference.clone(),
        }),
        reference_script: None,
    };

    let remainder = if is_partial {
        // remainder holds unsold sold-asset + pre-funded min-ADA + leftover tip.
        let rem_val = Value::from_lovelace(add(ORDER_MIN_ADA, tip_rem)?).add(
            &sold.policy,
            &sold.name,
            unsold,
        );
        // limit price preserved/improved: the anchor requires
        //   limit' * sell_amount >= limit * unsold.
        // `ceil(limit*unsold/sell_amount)` is the tightest always-valid choice
        // (a floor would violate it whenever the division truncates).
        let rem_limit = mul_div_ceil(order.limit, unsold, order.sell_amount)?;
        let rem_datum = OrderDatum {
            owner: order.owner.clone(),
            // remainder preserves the payout stake (mirrors `consume_remainder`'s
            // `ro.owner_stake == order.owner_stake` continuity pin).
            owner_stake: order.owner_stake.clone(),
            pool_nft: order.pool_nft.clone(),
            sell_a: order.sell_a,
            sell_amount: unsold,
            limit: rem_limit,
            tip: tip_rem,
            partial: false,
            deadline: order.deadline,
        };
        Some(Output {
            address: input.address.clone(),
            value: rem_val,
            datum: Datum::Order(rem_datum),
            reference_script: None,
        })
    } else {
        None
    };

    Ok(OneResult {
        owner_output,
        remainder,
        d_a,
        d_b,
        tip_taken,
    })
}

/// Port of `clearing.ak::run` + `process`. `orders` MUST already be in canonical
/// input order (sort by `OutputReference`); `fills[i]` aligns with `orders[i]`.
pub fn build_settlement(
    orders: &[OrderInput],
    fills: &[i128],
    pool: &PoolInput,
    price: Price,
    tx_upper: Option<i64>,
) -> Result<Settlement, ClearingError> {
    // (L-02) strictly-positive price.
    if price.num <= 0 || price.den <= 0 {
        return Err(ClearingError::NonPositivePrice);
    }
    if fills.len() != orders.len() {
        return Err(ClearingError::FillsLengthMismatch);
    }

    let d = &pool.datum;

    // The solver declares the pair/NFT; bind them to the pool's REAL datum (the
    // anchor asserts equality), so we just adopt the pool's identities.
    let r = SettlementRedeemer {
        price_num: price.num,
        price_den: price.den,
        asset_a: d.asset_a.clone(),
        asset_b: d.asset_b.clone(),
        pool_nft: d.nft.clone(),
        fills: fills.to_vec(),
    };

    // distinct pair (also implied by the binding, kept as an early guard).
    if r.asset_a == r.asset_b {
        return Err(ClearingError::DegeneratePair);
    }
    // the pool input must carry exactly one NFT.
    if r.pool_nft.qty_in(&pool.value) != 1 {
        return Err(ClearingError::PoolNftNotSingleton);
    }
    // binding to the spent PoolDatum (trivially holds since we adopted them, but
    // assert to mirror the anchor and catch a caller passing a mismatched price).
    if r.pool_nft != d.nft || r.asset_a != d.asset_a || r.asset_b != d.asset_b {
        return Err(ClearingError::PoolBindingMismatch);
    }
    // defense-in-depth: neither traded asset shares the pool's own policy.
    if r.asset_a.policy == r.pool_nft.policy || r.asset_b.policy == r.pool_nft.policy {
        return Err(ClearingError::AssetUnderPoolPolicy);
    }

    let mut owner_outputs = Vec::with_capacity(orders.len());
    let mut remainders = Vec::new();
    let mut net_a: i128 = 0;
    let mut net_b: i128 = 0;
    let mut tip_taken_total: i128 = 0;

    for (index, (input, &f)) in orders.iter().zip(fills.iter()).enumerate() {
        let one = check_one(input, f, &r, tx_upper, index)?;
        net_a = add(net_a, one.d_a)?;
        net_b = add(net_b, one.d_b)?;
        tip_taken_total = add(tip_taken_total, one.tip_taken)?;
        owner_outputs.push(one.owner_output);
        if let Some(rem) = one.remainder {
            remainders.push(rem);
        }
    }

    // (1) the pool absorbs EXACTLY the net residual; NFT/LP/min-ADA/incidental
    // assets are preserved by pinning the input value shifted by (net_a, net_b).
    let pool_value = pool
        .value
        .add(&r.asset_a.policy, &r.asset_a.name, net_a)
        .add(&r.asset_b.policy, &r.asset_b.name, net_b);
    let pool_output = Output {
        address: pool.address.clone(),
        value: pool_value,
        datum: Datum::Pool(d.clone()),
        reference_script: None,
    };

    Ok(Settlement {
        redeemer: r,
        owner_outputs,
        pool_output,
        remainders,
        net_a,
        net_b,
        tip_taken_total,
    })
}

/// The amount of bought asset an order receives at `price` for fill `f`
/// (`f·num/den` selling `asset_a`, `f·den/num` selling `asset_b`). Exposed for the
/// solver to size fills and netting consistently with the anchor.
pub fn received_for(sell_a: bool, f: i128, price: Price) -> Result<i128, ClearingError> {
    if sell_a {
        mul_div_floor(f, price.num, price.den)
    } else {
        mul_div_floor(f, price.den, price.num)
    }
}

/// Does an order's full-fill floor hold at `price`? (Independent of `f`.)
pub fn floor_ok(order: &OrderDatum, price: Price) -> Result<bool, ClearingError> {
    if order.sell_a {
        Ok(mul(order.sell_amount, price.num)? >= mul(order.limit, price.den)?)
    } else {
        Ok(mul(order.sell_amount, price.den)? >= mul(order.limit, price.num)?)
    }
}

/// Canonical input ordering: by `(transaction_id, output_index)`. The anchor zips
/// fills/owner-outputs against inputs in this order, so the solver must too.
pub fn canonical_key(o: &OrderInput) -> (Vec<u8>, u64) {
    (
        o.output_reference.transaction_id.clone(),
        o.output_reference.output_index,
    )
}
