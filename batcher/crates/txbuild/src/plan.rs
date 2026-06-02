//! The **settlement plan** — the chain-independent skeleton of a settlement
//! transaction. It lowers a `solver-core` [`Settlement`] (plus the order/pool
//! inputs it consumed) into:
//!
//! - the canonical **output list** (owner payouts `[0,N)`, then the NFT pool
//!   output, then remainders) as owned components;
//! - the **script spends** (each order input → `Settle`, the pool input →
//!   `PoolSettle`);
//! - the **withdraw-0** reward account `S` + its `SettlementRedeemer`;
//! - the POSIX validity upper bound implied by the included orders' deadlines.
//!
//! The chain layer adds the solver's funding/collateral inputs and tip-change
//! output, converts the POSIX bound to a slot `ttl`, computes `script_data_hash`
//! from the protocol cost models, fills ex-units from EvaluateTx, balances the fee,
//! and signs. The one subtle pure-logic piece kept (and tested) here is
//! [`compute_redeemers`]: a `Spend` redeemer's index is the input's position in the
//! *final, canonically-sorted* input set — which includes those funding inputs — so
//! it can only be assigned once they're known.

use crate::address::{self, AddressError};
use crate::plutus;
use crate::value::{self, ValueError};
use pallas_crypto::hash::Hash;
use pallas_primitives::conway::{RedeemerTag, Value as ConwayValue};
use pallas_primitives::{ExUnits, PlutusData, TransactionInput};
use solver_core::clearing::Settlement;
use solver_core::output::{OrderInput, Output, PoolInput};
use solver_core::types::Credential;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    Address(AddressError),
    Value(ValueError),
    BadTxIdLength(usize),
}

impl From<AddressError> for PlanError {
    fn from(e: AddressError) -> Self {
        PlanError::Address(e)
    }
}
impl From<ValueError> for PlanError {
    fn from(e: ValueError) -> Self {
        PlanError::Value(e)
    }
}

/// An output, lowered to owned components (the chain layer builds the concrete
/// `TransactionOutput`, handling its borrow-oriented lifetimes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedOutput {
    pub address: Vec<u8>,
    pub value: ConwayValue,
    /// CBOR of the inline datum, if any.
    pub inline_datum: Option<Vec<u8>>,
}

/// A script input being spent, with its redeemer data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptSpend {
    pub input: TransactionInput,
    pub redeemer: PlutusData,
}

/// The full chain-independent plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettlementPlan {
    pub outputs: Vec<PlannedOutput>,
    pub script_spends: Vec<ScriptSpend>,
    pub reward_account: Vec<u8>,
    pub withdraw_redeemer: PlutusData,
    /// The tightest POSIX-ms upper bound the tx validity must respect (the min
    /// deadline among included orders), or `None` if no included order has one.
    pub validity_upper_posix: Option<i64>,
}

fn tx_input(r: &solver_core::types::OutputReference) -> Result<TransactionInput, PlanError> {
    let arr: [u8; 32] = r
        .transaction_id
        .as_slice()
        .try_into()
        .map_err(|_| PlanError::BadTxIdLength(r.transaction_id.len()))?;
    Ok(TransactionInput {
        transaction_id: Hash::from(arr),
        index: r.output_index,
    })
}

fn lower_output(net: pallas_addresses::Network, o: &Output) -> Result<PlannedOutput, PlanError> {
    let inline_datum = plutus::datum(&o.datum).map(|d| plutus::to_cbor(&d));
    Ok(PlannedOutput {
        address: address::shelley_bytes(net, &o.address)?,
        value: value::lower(&o.value)?,
        inline_datum,
    })
}

/// Build the chain-independent plan from a solved settlement plus the inputs it
/// consumed. `orders` MUST be in the same canonical order the settlement used
/// (its `owner_outputs[i]` corresponds to `orders[i]`).
pub fn plan(
    settlement: &Settlement,
    orders: &[OrderInput],
    pool: &PoolInput,
    network_id: u8,
    s_cred: &Credential,
) -> Result<SettlementPlan, PlanError> {
    let net = address::network(network_id);

    // outputs: owners [0,N), pool, remainders — exactly the anchor's layout.
    let mut outputs = Vec::new();
    for o in &settlement.owner_outputs {
        outputs.push(lower_output(net, o)?);
    }
    outputs.push(lower_output(net, &settlement.pool_output)?);
    for r in &settlement.remainders {
        outputs.push(lower_output(net, r)?);
    }

    // script spends: each order input defers via `Settle`; the pool via `PoolSettle`.
    let mut script_spends = Vec::with_capacity(orders.len() + 1);
    for o in orders {
        script_spends.push(ScriptSpend {
            input: tx_input(&o.output_reference)?,
            redeemer: plutus::order_settle(),
        });
    }
    script_spends.push(ScriptSpend {
        input: tx_input(&pool.output_reference)?,
        redeemer: plutus::pool_settle(),
    });

    // the tightest POSIX deadline bound among included orders.
    let validity_upper_posix = orders.iter().filter_map(|o| o.datum.deadline).min();

    Ok(SettlementPlan {
        outputs,
        script_spends,
        reward_account: address::reward_account(net, s_cred)?,
        withdraw_redeemer: plutus::settlement_redeemer(&settlement.redeemer),
        validity_upper_posix,
    })
}

/// Canonical ledger input ordering: by `(transaction_id, index)`.
fn input_key(i: &TransactionInput) -> (&[u8], u64) {
    (i.transaction_id.as_ref(), i.index)
}

/// A redeemer with its purpose, ex-units left to be filled by EvaluateTx.
fn redeemer(tag: RedeemerTag, index: u32, data: PlutusData) -> pallas_primitives::conway::Redeemer {
    pallas_primitives::conway::Redeemer {
        tag,
        index,
        data,
        ex_units: ExUnits { mem: 0, steps: 0 },
    }
}

/// Compute the settlement's redeemers against the **final** input/withdrawal sets.
///
/// `all_inputs` is every input of the tx (script inputs + the solver's funding
/// inputs), in any order — this fn sorts them canonically and assigns each script
/// spend the `Spend` redeemer at its sorted position. `reward_accounts` is every
/// withdrawal account (here just `S`), sorted as the ledger sorts them; the
/// `Reward` redeemer gets `S`'s index. Ex-units are placeholders (`0,0`) for the
/// chain layer to fill from EvaluateTx.
///
/// Returns `None` if a script input or the reward account isn't present (a caller
/// bug — the plan and the final tx disagree).
pub fn compute_redeemers(
    spends: &[ScriptSpend],
    all_inputs: &[TransactionInput],
    withdraw_account: &[u8],
    withdraw_redeemer: &PlutusData,
    reward_accounts: &[Vec<u8>],
) -> Option<Vec<pallas_primitives::conway::Redeemer>> {
    let mut sorted: Vec<&TransactionInput> = all_inputs.iter().collect();
    sorted.sort_by(|a, b| input_key(a).cmp(&input_key(b)));

    let mut out = Vec::with_capacity(spends.len() + 1);
    for s in spends {
        let idx = sorted.iter().position(|i| **i == s.input)? as u32;
        out.push(redeemer(RedeemerTag::Spend, idx, s.redeemer.clone()));
    }

    let mut accts: Vec<&Vec<u8>> = reward_accounts.iter().collect();
    accts.sort();
    let widx = accts
        .iter()
        .position(|a| a.as_slice() == withdraw_account)? as u32;
    out.push(redeemer(
        RedeemerTag::Reward,
        widx,
        withdraw_redeemer.clone(),
    ));

    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use solver_core::clearing::{build_settlement, Price};
    use solver_core::output::Address;
    use solver_core::types::{AssetId, OrderDatum, OutputReference, PoolDatum, NFT_NAME};
    use solver_core::value::Value;

    fn tok() -> AssetId {
        AssetId::new(vec![0x33u8; 28], vec![0x54])
    }
    fn nft() -> AssetId {
        AssetId::new(vec![0x44u8; 28], NFT_NAME.to_vec())
    }
    fn owner() -> Credential {
        Credential::VerificationKey(vec![0xb1u8; 28])
    }
    fn s_cred() -> Credential {
        Credential::Script(vec![0x55u8; 28])
    }
    fn tagged(p: Credential) -> Address {
        Address {
            payment: p,
            stake: Some(s_cred()),
        }
    }

    fn order(idx: u64) -> OrderInput {
        OrderInput {
            output_reference: OutputReference {
                transaction_id: vec![0xa1u8; 32],
                output_index: idx,
            },
            address: tagged(Credential::Script(vec![0x0bu8; 28])),
            value: Value::from_lovelace(4_000_000).add(&tok().policy, &tok().name, 1_000_000),
            datum: OrderDatum {
                owner: owner(),
                owner_stake: None,
                pool_nft: nft(),
                sell_a: true,
                sell_amount: 1_000_000,
                limit: 400_000,
                tip: 2_000_000,
                partial: false,
                deadline: None,
            },
        }
    }

    fn pool() -> PoolInput {
        PoolInput {
            output_reference: OutputReference {
                transaction_id: vec![0xd1u8; 32],
                output_index: 0,
            },
            address: tagged(Credential::Script(vec![0x99u8; 28])),
            value: Value::from_lovelace(1_000_000_002_000_000)
                .add(&tok().policy, &tok().name, 1_000_000_000_000)
                .add(&nft().policy, &nft().name, 1),
            datum: PoolDatum {
                nft: nft(),
                asset_a: tok(),
                asset_b: AssetId::ada(),
                fee_num: 3,
                fee_den: 1000,
                creator: owner(),
            },
        }
    }

    #[test]
    fn plan_layout_matches_anchor() {
        let orders = [order(0), order(1)];
        let st = build_settlement(
            &orders,
            &[1_000_000, 1_000_000],
            &pool(),
            Price { num: 1, den: 2 },
            None,
        )
        .unwrap();
        let p = plan(&st, &orders, &pool(), 0, &s_cred()).unwrap();
        // 2 owner outputs + 1 pool + 0 remainders.
        assert_eq!(p.outputs.len(), 3);
        // owner outputs carry an inline BoundDatum; pool carries the PoolDatum.
        assert!(p.outputs[0].inline_datum.is_some());
        assert!(p.outputs[2].inline_datum.is_some());
        // 2 order spends + 1 pool spend.
        assert_eq!(p.script_spends.len(), 3);
        assert_eq!(p.reward_account.len(), 29);
    }

    #[test]
    fn redeemer_indices_track_the_sorted_input_set() {
        let orders = [order(0), order(1)];
        let st = build_settlement(
            &orders,
            &[1_000_000, 1_000_000],
            &pool(),
            Price { num: 1, den: 2 },
            None,
        )
        .unwrap();
        let p = plan(&st, &orders, &pool(), 0, &s_cred()).unwrap();

        // Final input set: script inputs + two funding inputs the chain adds. The
        // funding txid 0x00.. sorts BEFORE the orders (0xa1..) and pool (0xd1..).
        let fund = |b: u8, i: u64| TransactionInput {
            transaction_id: Hash::from([b; 32]),
            index: i,
        };
        let mut all: Vec<TransactionInput> =
            p.script_spends.iter().map(|s| s.input.clone()).collect();
        all.push(fund(0x00, 0));
        all.push(fund(0x00, 1));

        let reward_accounts = vec![p.reward_account.clone()];
        let rs = compute_redeemers(
            &p.script_spends,
            &all,
            &p.reward_account,
            &p.withdraw_redeemer,
            &reward_accounts,
        )
        .unwrap();

        // sorted inputs: [0x00#0, 0x00#1, 0xa1#0, 0xa1#1, 0xd1#0]
        //   order#0 -> idx 2, order#1 -> idx 3, pool -> idx 4.
        let spend_idx: Vec<u32> = rs
            .iter()
            .filter(|r| r.tag == RedeemerTag::Spend)
            .map(|r| r.index)
            .collect();
        assert_eq!(spend_idx, vec![2, 3, 4]);
        // the lone withdrawal gets Reward index 0.
        let reward: Vec<u32> = rs
            .iter()
            .filter(|r| r.tag == RedeemerTag::Reward)
            .map(|r| r.index)
            .collect();
        assert_eq!(reward, vec![0]);
    }

    #[test]
    fn validity_bound_is_tightest_deadline() {
        let mut o0 = order(0);
        o0.datum.deadline = Some(5000);
        let mut o1 = order(1);
        o1.datum.deadline = Some(3000);
        let orders = [o0, o1];
        let st = build_settlement(
            &orders,
            &[1_000_000, 1_000_000],
            &pool(),
            Price { num: 1, den: 2 },
            Some(3000),
        )
        .unwrap();
        let p = plan(&st, &orders, &pool(), 0, &s_cred()).unwrap();
        assert_eq!(p.validity_upper_posix, Some(3000));
    }
}
