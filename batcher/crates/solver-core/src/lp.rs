//! The LP-intent fulfillment *pin generator* — the faithful port of
//! [`lp_intent.ak`](../../../contracts/lib/shaswap/lp_intent.ak)'s `fulfill`. Given an
//! LP-intent input and the pool it binds (by NFT), it produces the **exact** pool
//! output and owner payout the on-chain `fulfill` (and the unchanged pool `LpAction`)
//! will accept — to the lovelace — and the same errors the validator's `expect`s would
//! fail on.
//!
//! This is the LP analogue of [`crate::clearing`]: `txbuild` lowers an [`LpFulfillment`]
//! straight into a transaction, and the two on-chain validators re-derive the identical
//! values. The amounts are computed by **rounding the pool's favour** (withdraw releases
//! the floor of the proportional share; a deposit's minimal balanced amount is the ceil),
//! so the pool validator's per-share backing inequality (`res_out·circ_in ≥
//! res_in·circ_out`) always holds and existing LPs are never diluted.

use crate::curve::reserve_of;
use crate::output::{Address, Datum, LpIntentInput, Output, PoolInput};
use crate::types::{AssetId, LpIntentAction, LpIntentDatum, LP_NAME, MIN_LIQ, TOTAL_LP};
use crate::value::Value;

/// Every way a fulfillment can be invalid — each maps to an `expect` in `lp_intent.ak`
/// (or a precondition the batcher must respect to satisfy the pool `LpAction`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LpError {
    /// `expect pool.nft == d.pool_nft` — the bound pool isn't the one named.
    PoolNftMismatch,
    /// Deposit into an unseeded pool (`circ_in == 0`) — not intent-fulfillable.
    FirstDepositExcluded,
    /// Withdraw of zero LP (`L < 1`).
    ZeroLp,
    /// Deposit minting zero shares (`shares < 1`).
    ZeroShares,
    /// The owner floor isn't met (`released < min_a/min_b`, or `shares < min_shares`).
    FloorBreach,
    /// The withdraw would drop circulating LP below the permanent `MIN_LIQ` lock (the
    /// pool `LpAction` would reject it).
    BelowMinLiq,
    /// A deposit's computed balanced amount exceeds what the intent holds (the app
    /// should fund a balanced intent; surfaced rather than producing a negative payout).
    InsufficientDeposit,
    /// The intent's tip exceeds its spare lovelace (would make the owner payout
    /// negative).
    TipTooLarge,
    /// The deadline can't be honored by the tx's validity bound.
    DeadlineUnhonorable,
    /// Arithmetic exceeded the solver's `i128` working range.
    Overflow,
}

fn mul(a: i128, b: i128) -> Result<i128, LpError> {
    a.checked_mul(b).ok_or(LpError::Overflow)
}

/// Floor of `a*b/c` for non-negative operands, `c > 0`.
fn mul_div_floor(a: i128, b: i128, c: i128) -> Result<i128, LpError> {
    Ok(mul(a, b)? / c)
}

/// Ceil of `a*b/c` for non-negative operands, `c > 0`.
fn mul_div_ceil(a: i128, b: i128, c: i128) -> Result<i128, LpError> {
    Ok((mul(a, b)? + c - 1) / c)
}

/// `lp_intent.deadline_ok` — an intent with a deadline can be fulfilled only in a tx
/// bounded to end no later than it.
fn deadline_ok(deadline: Option<i64>, tx_upper: Option<i64>) -> bool {
    match deadline {
        None => true,
        Some(d) => match tx_upper {
            Some(u) => u <= d,
            None => false,
        },
    }
}

/// The proportional withdraw amounts — `out = floor(L · res / circ_in)` per asset,
/// rounded DOWN so the on-chain backing check passes (the pool releases at most the
/// owner's proportional share). Pure; `circ_in > 0` required.
pub fn withdraw_amounts(
    l: i128,
    circ_in: i128,
    res_a_in: i128,
    res_b_in: i128,
) -> Result<(i128, i128), LpError> {
    let out_a = mul_div_floor(l, res_a_in, circ_in)?;
    let out_b = mul_div_floor(l, res_b_in, circ_in)?;
    Ok((out_a, out_b))
}

/// Deposit plan: the shares the available `(da, db)` back, and the **minimal** balanced
/// amount the pool must actually absorb to mint them. `shares = min(floor(da·circ/res_a),
/// floor(db·circ/res_b))`; `dep = ceil(res·shares/circ)` (rounded UP so backing holds).
/// `dep_a ≤ da` and `dep_b ≤ db` always, so the over-supplied side rides back to the
/// owner. Pure; `circ_in > 0`, `res_* > 0` required.
pub fn deposit_plan(
    da: i128,
    db: i128,
    circ_in: i128,
    res_a_in: i128,
    res_b_in: i128,
) -> Result<(i128, i128, i128), LpError> {
    let shares_a = mul_div_floor(da, circ_in, res_a_in)?;
    let shares_b = mul_div_floor(db, circ_in, res_b_in)?;
    let shares = shares_a.min(shares_b);
    let dep_a = mul_div_ceil(res_a_in, shares, circ_in)?;
    let dep_b = mul_div_ceil(res_b_in, shares, circ_in)?;
    Ok((shares, dep_a, dep_b))
}

/// A fully-pinned LP fulfillment: the recreated pool output + the exact owner payout +
/// the economic summary. The batcher takes only `tip` lovelace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LpFulfillment {
    pub action: LpIntentAction,
    /// The recreated pool UTXO (NFT + datum continuity, reserves/held shifted).
    pub pool_output: Output,
    /// The exact owner payout (released reserves / minted shares + leftover, tip removed).
    pub owner_output: Output,
    /// Withdraw: released asset_a / asset_b. Deposit: deposited asset_a / asset_b.
    pub amount_a: i128,
    pub amount_b: i128,
    /// Withdraw: `L` LP burned into held. Deposit: `shares` minted to the owner.
    pub shares: i128,
    /// The tip the batcher collects (its only income).
    pub tip: i128,
}

/// The LP token of the pool the intent binds.
fn lp_asset(pool_nft: &AssetId) -> AssetId {
    AssetId::new(pool_nft.policy.clone(), LP_NAME.to_vec())
}

/// Build the exact pinned fulfillment for one LP intent against its pool, or the same
/// error the on-chain `fulfill` (or the pool `LpAction`) would reject with. `tx_upper`
/// is the fulfillment tx's finite upper validity bound (POSIX ms), if any.
pub fn build_fulfillment(
    intent: &LpIntentInput,
    pool: &PoolInput,
    tx_upper: Option<i64>,
) -> Result<LpFulfillment, LpError> {
    let d: &LpIntentDatum = &intent.datum;
    if pool.datum.nft != d.pool_nft {
        return Err(LpError::PoolNftMismatch);
    }
    if !deadline_ok(d.deadline, tx_upper) {
        return Err(LpError::DeadlineUnhonorable);
    }

    let lp = lp_asset(&d.pool_nft);
    let asset_a = &pool.datum.asset_a;
    let asset_b = &pool.datum.asset_b;

    let res_a_in = reserve_of(&pool.value, asset_a);
    let res_b_in = reserve_of(&pool.value, asset_b);
    let held_in = lp.qty_in(&pool.value);
    let circ_in = TOTAL_LP - held_in;

    let payout_addr = Address::payout(d.owner.clone(), d.owner_stake.clone());

    match d.action {
        LpIntentAction::LpWithdraw => {
            let l = lp.qty_in(&intent.value);
            if l < 1 {
                return Err(LpError::ZeroLp);
            }
            // the pool validator caps circ_out ≥ MIN_LIQ.
            let circ_out = circ_in - l;
            if circ_out < MIN_LIQ {
                return Err(LpError::BelowMinLiq);
            }
            let (out_a, out_b) = withdraw_amounts(l, circ_in, res_a_in, res_b_in)?;
            if out_a < d.min_a || out_b < d.min_b {
                return Err(LpError::FloorBreach);
            }

            // pool output: reserves down by the released amounts, held up by L.
            let pool_value = shift(&pool.value, asset_a, -out_a, asset_b, -out_b, &lp, l);
            // owner payout: intent − L·lp + out_a·a + out_b·b − tip (a reuse of `shift`
            // plus the tip). ADA triple-role handled automatically: out_b and −tip both
            // land on lovelace when a side is ADA. The guard surfaces an over-large tip.
            let owner_value =
                shift(&intent.value, asset_a, out_a, asset_b, out_b, &lp, -l).ada_add(-d.tip);
            if owner_value.lovelace_of() < 0 {
                return Err(LpError::TipTooLarge);
            }

            Ok(LpFulfillment {
                action: LpIntentAction::LpWithdraw,
                pool_output: pool_out(pool, pool_value),
                owner_output: payout_out(payout_addr, owner_value),
                amount_a: out_a,
                amount_b: out_b,
                shares: l,
                tip: d.tip,
            })
        }
        LpIntentAction::LpDeposit => {
            if circ_in <= 0 {
                return Err(LpError::FirstDepositExcluded);
            }
            if res_a_in <= 0 || res_b_in <= 0 {
                return Err(LpError::FirstDepositExcluded);
            }
            let da = asset_a.qty_in(&intent.value);
            let db = asset_b.qty_in(&intent.value);
            let (shares, dep_a, dep_b) = deposit_plan(da, db, circ_in, res_a_in, res_b_in)?;
            if shares < 1 {
                return Err(LpError::ZeroShares);
            }
            if shares < d.min_shares {
                return Err(LpError::FloorBreach);
            }
            if dep_a > da || dep_b > db {
                return Err(LpError::InsufficientDeposit);
            }

            // pool output: reserves up by the deposit, held down by the minted shares.
            let pool_value = shift(&pool.value, asset_a, dep_a, asset_b, dep_b, &lp, -shares);
            // owner payout: intent − dep_a·a − dep_b·b + shares·lp − tip.
            let owner_value =
                shift(&intent.value, asset_a, -dep_a, asset_b, -dep_b, &lp, shares).ada_add(-d.tip);
            if owner_value.lovelace_of() < 0 {
                return Err(LpError::TipTooLarge);
            }

            Ok(LpFulfillment {
                action: LpIntentAction::LpDeposit,
                pool_output: pool_out(pool, pool_value),
                owner_output: payout_out(payout_addr, owner_value),
                amount_a: dep_a,
                amount_b: dep_b,
                shares,
                tip: d.tip,
            })
        }
    }
}

/// Shift a value by three asset deltas (asset_a, asset_b, lp). When `asset_a`/`asset_b`
/// is ADA the delta lands on the lovelace field — the same value-transform the validator
/// uses, so reserves carve `POOL_MIN_ADA` consistently on both sides.
fn shift(
    v: &Value,
    asset_a: &AssetId,
    da: i128,
    asset_b: &AssetId,
    db: i128,
    lp: &AssetId,
    dlp: i128,
) -> Value {
    v.add(&asset_a.policy, &asset_a.name, da)
        .add(&asset_b.policy, &asset_b.name, db)
        .add(&lp.policy, &lp.name, dlp)
}

fn pool_out(pool: &PoolInput, value: Value) -> Output {
    Output {
        address: pool.address.clone(),
        value,
        datum: Datum::Pool(pool.datum.clone()),
        reference_script: None,
    }
}

fn payout_out(address: Address, value: Value) -> Output {
    Output {
        address,
        value,
        datum: Datum::None,
        reference_script: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Credential, OutputReference, POOL_MIN_ADA};

    fn nft() -> AssetId {
        AssetId::new(vec![0x44; 28], vec![0x4e, 0x46, 0x54])
    }
    fn tok() -> AssetId {
        AssetId::new(vec![0x33; 28], vec![0x54])
    }
    fn lp() -> AssetId {
        AssetId::new(vec![0x44; 28], LP_NAME.to_vec())
    }
    fn pool_addr() -> Address {
        Address {
            payment: Credential::Script(vec![0x99; 28]),
            stake: Some(Credential::Script(vec![0x55; 28])),
        }
    }
    fn owner() -> Credential {
        Credential::VerificationKey(vec![0xb1; 28])
    }

    // ADA-paired pool value: asset_a = tok, asset_b = ada.
    fn pool_value(res_tok: i128, res_ada: i128, held: i128) -> Value {
        Value::from_lovelace(res_ada + POOL_MIN_ADA)
            .add(&tok().policy, &tok().name, res_tok)
            .add(&nft().policy, &nft().name, 1)
            .add(&lp().policy, &lp().name, held)
    }

    fn pool_input(res_tok: i128, res_ada: i128, held: i128) -> PoolInput {
        PoolInput {
            output_reference: OutputReference {
                transaction_id: vec![0xd1; 32],
                output_index: 0,
            },
            address: pool_addr(),
            value: pool_value(res_tok, res_ada, held),
            datum: PoolDatum_fixture(),
        }
    }

    #[allow(non_snake_case)]
    fn PoolDatum_fixture() -> crate::types::PoolDatum {
        crate::types::PoolDatum {
            nft: nft(),
            asset_a: tok(),
            asset_b: AssetId::ada(),
            fee_num: 3,
            fee_den: 1000,
            creator: Credential::Script(vec![0xc0; 28]),
        }
    }

    fn wd_intent(l: i128, tip: i128, min_a: i128, min_b: i128) -> LpIntentInput {
        LpIntentInput {
            output_reference: OutputReference {
                transaction_id: vec![0x1a; 32],
                output_index: 0,
            },
            address: Address {
                payment: Credential::Script(vec![0x1c; 28]),
                stake: None,
            },
            value: Value::from_lovelace(2_000_000 + tip).add(&lp().policy, &lp().name, l),
            datum: LpIntentDatum {
                owner: owner(),
                owner_stake: None,
                pool_nft: nft(),
                action: LpIntentAction::LpWithdraw,
                min_a,
                min_b,
                min_shares: 0,
                tip,
                deadline: None,
            },
        }
    }

    fn dep_intent(da: i128, db: i128, tip: i128, min_shares: i128) -> LpIntentInput {
        LpIntentInput {
            output_reference: OutputReference {
                transaction_id: vec![0x1a; 32],
                output_index: 0,
            },
            address: Address {
                payment: Credential::Script(vec![0x1c; 28]),
                stake: None,
            },
            value: Value::from_lovelace(db + tip + 2_000_000).add(&tok().policy, &tok().name, da),
            datum: LpIntentDatum {
                owner: owner(),
                owner_stake: None,
                pool_nft: nft(),
                action: LpIntentAction::LpDeposit,
                min_a: 0,
                min_b: 0,
                min_shares,
                tip,
                deadline: None,
            },
        }
    }

    // mirrors the Aiken `withdraw_ok`: 10% of a 1_000_000-circ pool releases 20M tok + 10M ada.
    #[test]
    fn withdraw_matches_aiken_fixture() {
        let f = build_fulfillment(
            &wd_intent(100_000, 1_000_000, 19_000_000, 9_000_000),
            &pool_input(200_000_000, 100_000_000, TOTAL_LP - 1_000_000),
            None,
        )
        .unwrap();
        assert_eq!(f.amount_a, 20_000_000);
        assert_eq!(f.amount_b, 10_000_000);
        assert_eq!(f.shares, 100_000);
        // owner gets 20M tok + (2M min + 10M released) ada.
        assert_eq!(f.owner_output.value.lovelace_of(), 12_000_000);
        assert_eq!(
            f.owner_output.value.quantity_of(&tok().policy, &tok().name),
            20_000_000
        );
        assert_eq!(
            f.owner_output.value.quantity_of(&lp().policy, &lp().name),
            0
        );
        // pool: reserves down, held up by L.
        assert_eq!(reserve_of(&f.pool_output.value, &tok()), 180_000_000);
        assert_eq!(
            reserve_of(&f.pool_output.value, &AssetId::ada()),
            90_000_000
        );
        assert_eq!(lp().qty_in(&f.pool_output.value), TOTAL_LP - 900_000);
    }

    // mirrors the Aiken `deposit_ok`: 20M tok + 10M ada mints 100k shares.
    #[test]
    fn deposit_matches_aiken_fixture() {
        let f = build_fulfillment(
            &dep_intent(20_000_000, 10_000_000, 1_000_000, 90_000),
            &pool_input(200_000_000, 100_000_000, TOTAL_LP - 1_000_000),
            None,
        )
        .unwrap();
        assert_eq!(f.shares, 100_000);
        assert_eq!(f.amount_a, 20_000_000);
        assert_eq!(f.amount_b, 10_000_000);
        // owner gets 100k LP + 2M min back.
        assert_eq!(f.owner_output.value.lovelace_of(), 2_000_000);
        assert_eq!(lp().qty_in(&f.owner_output.value), 100_000);
        assert_eq!(reserve_of(&f.pool_output.value, &tok()), 220_000_000);
        assert_eq!(lp().qty_in(&f.pool_output.value), TOTAL_LP - 1_100_000);
    }

    // (Rev 25) Rust↔Aiken parity for the at-ratio deposit pin: `deposit_plan`'s (dep_a, dep_b)
    // MUST equal the on-chain `need = ceil(shares·res/circ) = (shares·res + circ − 1)/circ`
    // (lp_intent.ak LpDeposit), so every batcher deposit satisfies the new `dep == need` pin
    // exactly and the over-supplied side always rides back to the owner. Grid spans at-ratio
    // and OFF-ratio intents; guards against future divergence of the two ceil formulas.
    #[test]
    fn deposit_dep_matches_contract_ceil_pin() {
        let reserves = [1i128, 1_000, 1_000_003, 200_000_000, 999_999_937];
        let circs = [1_000i128, 1_000_000, 7_777_777];
        let avails = [1i128, 101, 10_000_000, 50_000_000, 123_456_789];
        for &res_a in &reserves {
            for &res_b in &reserves {
                for &circ in &circs {
                    for &da in &avails {
                        for &db in &avails {
                            let Ok((shares, dep_a, dep_b)) =
                                deposit_plan(da, db, circ, res_a, res_b)
                            else {
                                continue;
                            };
                            if shares < 1 {
                                continue;
                            }
                            // the EXACT on-chain formula (Aiken `(x + y − 1) / y`).
                            let (Some(sra), Some(srb)) =
                                (shares.checked_mul(res_a), shares.checked_mul(res_b))
                            else {
                                continue;
                            };
                            let need_a = (sra + circ - 1) / circ;
                            let need_b = (srb + circ - 1) / circ;
                            assert_eq!(dep_a, need_a, "dep_a≠need_a s={shares} ra={res_a} c={circ}");
                            assert_eq!(dep_b, need_b, "dep_b≠need_b s={shares} rb={res_b} c={circ}");
                            // over-supply rides back to the owner (the pool absorbs ≤ available).
                            assert!(dep_a <= da && dep_b <= db, "absorbed more than available");
                            // the pool's per-share backing holds (dep·circ ≥ res·shares).
                            assert!(dep_a * circ >= sra && dep_b * circ >= srb, "backing breached");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn withdraw_floor_breach_rejected() {
        let r = build_fulfillment(
            &wd_intent(100_000, 1_000_000, 21_000_000, 9_000_000),
            &pool_input(200_000_000, 100_000_000, TOTAL_LP - 1_000_000),
            None,
        );
        assert_eq!(r, Err(LpError::FloorBreach));
    }

    #[test]
    fn deposit_first_deposit_excluded() {
        let r = build_fulfillment(
            &dep_intent(100_000_000, 100_000_000, 1_000_000, 0),
            &pool_input(0, 0, TOTAL_LP),
            None,
        );
        assert_eq!(r, Err(LpError::FirstDepositExcluded));
    }

    #[test]
    fn deadline_honored() {
        // tx upper 900 ≤ deadline 1000 → ok; 1500 → rejected.
        let mut intent = wd_intent(100_000, 1_000_000, 0, 0);
        intent.datum.deadline = Some(1000);
        let pool = pool_input(200_000_000, 100_000_000, TOTAL_LP - 1_000_000);
        assert!(build_fulfillment(&intent, &pool, Some(900)).is_ok());
        assert_eq!(
            build_fulfillment(&intent, &pool, Some(1500)),
            Err(LpError::DeadlineUnhonorable)
        );
    }
}
