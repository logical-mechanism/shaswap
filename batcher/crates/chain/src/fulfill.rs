//! Body assembly for an **LP-intent fulfillment** tx — the LP analogue of
//! [`crate::assemble`]. It lowers a [`solver_core::lp::LpFulfillment`] (the exact
//! pins both on-chain validators accept) into a fully-built, signed Conway tx and
//! gates it through Ogmios `EvaluateTx` before returning (it does NOT submit).
//!
//! A fulfillment tx is a **mini-settlement for one LP action** (BLUEPRINT §5.4,
//! `documentation/spec/lp-intents.md`). Two validators run, both bound by NFT:
//! - the **pool** spent with `LpAction` (caps over-release/over-mint — protects
//!   existing LPs), and
//! - the **lp_intent** spent with `Fulfill` (pins the owner payout AND the full
//!   pool output exactly, and asserts `!withdrawal_present(S)` — the no-fold guard).
//!
//! Layout (outputs): owner payout `[0]`, pool continuation `[1]`, solver change
//! `[2]` (LAST). Spends: pool → `LpAction`, intent → `Fulfill`. The 2 validators
//! come in as **reference inputs** (pool + lp_intent). **No withdrawal for `S`** —
//! a `Withdraw(S,0)` would make BOTH validators reject (the no-fold guard), so a
//! fulfillment tx must carry none. `mint == 0` (we never set a mint).
//!
//! Both pinned `Output`s come straight from `LpFulfillment` and are lowered
//! byte-for-byte — never recomputed — so the on-chain validators re-derive the
//! identical values. Only the solver-change output is computed here (`Σin − owner −
//! pool − fee`), which by the spec's conservation argument equals `funding + tip −
//! fee`: the batcher nets exactly the tip.

use crate::assemble::{
    add_value, apply_assets, core_exu, input_of, lower_output, FEE_MARGIN, WITNESS_OVERHEAD,
};
use crate::backend::{
    ChainBackend, ExUnits as BkExUnits, ProtocolParams, Purpose, RedeemerEval, ResolvedUtxo,
};
use crate::config::ValidatedConfig;
use crate::fees;
use crate::kupo_ogmios::ChainError;
use pallas_addresses::Address as PallasAddress;
use pallas_crypto::key::ed25519::SecretKey;
use shaswap_txbuilder::{BuildConway, BuiltTransaction, ExUnits, StagingTransaction};
use solver_core::lp::LpFulfillment;
use solver_core::output::{LpIntentInput, PoolInput};
use solver_core::types::OutputReference;
use solver_core::value::Value;
use std::collections::BTreeMap;
use txbuild::{address as txaddr, plutus};

/// Per-script-input ex-units, keyed by `(tx_id, output_index)` (as in `assemble`).
type SpendExUnits = BTreeMap<(Vec<u8>, u64), BkExUnits>;

/// The pool-continuation output index (right after the single owner payout).
const POOL_OUTPUT_INDEX: u64 = 1;
/// The solver-change output index (always last: owner, pool, change).
const CHANGE_OUTPUT_INDEX: u64 = 2;
/// A fulfillment tx always produces exactly these three outputs.
const OUTPUT_COUNT: usize = 3;

/// Everything the fulfillment assembler needs. Borrows the solved fulfillment + the
/// inputs it consumes.
pub struct FulfillInputs<'a> {
    /// The fully-pinned fulfillment from `solver_core::lp::build_fulfillment`.
    pub fulfillment: &'a LpFulfillment,
    /// The LP-intent UTXO being spent (for its `OutputReference` + value).
    pub intent: &'a LpIntentInput,
    /// The pool UTXO being spent (with `LpAction`).
    pub pool: &'a PoolInput,
    /// Solver funding input refs + values (leftover returns as change).
    pub funding: &'a [(OutputReference, Value)],
    /// Collateral input ref (a pure-ADA UTXO ≥ 5 ADA), shared across the chain.
    pub collateral: &'a OutputReference,
    /// The solver's own address (bech32) — receives the change output.
    pub solver_addr_bech32: &'a str,
    pub config: &'a ValidatedConfig,
    pub params: &'a ProtocolParams,
    /// The deployed `lp_intent` reference-script UTXO (the validator is referenced,
    /// not attached inline). The pool reference script is `config.pool_ref`.
    pub lp_intent_ref: &'a OutputReference,
    /// Total byte size of the 2 referenced scripts (pool + lp_intent), for the
    /// reference-script fee.
    pub ref_script_total_bytes: u64,
    /// `ttl` (slot) the tx must end by, if the intent carries a deadline.
    pub invalid_after_slot: Option<u64>,
}

/// The finalized, signed fulfillment tx plus the numbers worth logging and the
/// outputs needed to chain the next pool-spend onto this one.
pub struct BuiltFulfillment {
    pub signed: BuiltTransaction,
    pub fee: u64,
    pub total_ex_units: BkExUnits,
    /// The solver-change output (last) — funding for the next chained tx, and its
    /// `additionalUtxo` entry for that tx's gate.
    pub change: ResolvedUtxo,
    /// The pool-continuation output (index 1) — resolves the next pool-spend's
    /// pool input via `additionalUtxo`.
    pub pool_out: ResolvedUtxo,
    /// The pool as it exists after this tx — the [`PoolInput`] the next pool-spend
    /// (settlement or fulfillment) must spend. Address/datum come from this tx's
    /// pool input (both validators pin them unchanged).
    pub next_pool: PoolInput,
}

/// Σ value over every input (pool + intent + funding).
fn total_in(inp: &FulfillInputs) -> Value {
    let mut bal = Value::zero();
    add_value(&mut bal, &inp.pool.value, 1);
    add_value(&mut bal, &inp.intent.value, 1);
    for (_, v) in inp.funding {
        add_value(&mut bal, v, 1);
    }
    bal
}

/// The solver change value = Σin − owner − pool − fee. Errors if any asset goes
/// negative (inputs don't cover the pinned outputs + fee). By the conservation
/// argument this equals `funding + tip − fee` (ada-only when funding is ada-only).
fn compute_change(inp: &FulfillInputs, fee: u64) -> Result<Value, ChainError> {
    let mut bal = total_in(inp);
    add_value(&mut bal, &inp.fulfillment.owner_output.value, -1);
    add_value(&mut bal, &inp.fulfillment.pool_output.value, -1);
    bal.add_mut(&[], &[], -(fee as i128));
    for (_, _, q) in bal.flatten() {
        if q < 0 {
            return Err(ChainError::Shape(
                "inputs do not cover fulfillment outputs + fee (negative change)".into(),
            ));
        }
    }
    Ok(bal)
}

/// The canonical sorted refs of every tx input (pool + intent + funding) — the
/// order Ogmios/ledger indexes `Spend` redeemers against.
fn sorted_input_refs(inp: &FulfillInputs) -> Vec<OutputReference> {
    let mut refs: Vec<OutputReference> = vec![
        inp.pool.output_reference.clone(),
        inp.intent.output_reference.clone(),
    ];
    for (r, _) in inp.funding {
        refs.push(r.clone());
    }
    refs.sort_by(|a, b| {
        (&a.transaction_id, a.output_index).cmp(&(&b.transaction_id, b.output_index))
    });
    refs
}

/// Map `EvaluateTx` results back to each script input's ex-units by matching the
/// canonical sorted indices. A fulfillment has ONLY spend redeemers (pool + intent)
/// — no withdraw redeemer (the no-fold guard forbids a `Withdraw(S,0)`), so a
/// non-spend purpose is a hard error rather than something to silently ignore.
fn map_exunits(inp: &FulfillInputs, evals: &[RedeemerEval]) -> Result<SpendExUnits, ChainError> {
    let sorted = sorted_input_refs(inp);
    let mut spend: SpendExUnits = BTreeMap::new();
    for e in evals {
        match e.purpose {
            Purpose::Spend => {
                let r = sorted.get(e.index as usize).ok_or_else(|| {
                    ChainError::Shape(format!("spend eval index {} out of range", e.index))
                })?;
                spend.insert((r.transaction_id.clone(), r.output_index), e.ex_units);
            }
            other => {
                return Err(ChainError::Shape(format!(
                    "unexpected redeemer purpose {other:?} in a fulfillment (it has no withdrawal)"
                )))
            }
        }
    }
    Ok(spend)
}

/// Build the staging tx for a given fee + ex-units assignment (zeros for the draft).
fn build_staging(
    inp: &FulfillInputs,
    fee: u64,
    spend_exu: &SpendExUnits,
) -> Result<StagingTransaction, ChainError> {
    let net = txaddr::network(inp.config.network_id);
    let mut tx = StagingTransaction::new().fee(fee);

    // --- inputs: pool, intent, funding ---
    tx = tx.input(input_of(&inp.pool.output_reference)?);
    tx = tx.input(input_of(&inp.intent.output_reference)?);
    for (r, _) in inp.funding {
        tx = tx.input(input_of(r)?);
    }

    // --- collateral + the 2 reference scripts (pool + lp_intent) ---
    tx = tx.collateral_input(input_of(inp.collateral)?);
    tx = tx
        .reference_input(input_of(&inp.config.pool_ref)?)
        .reference_input(input_of(inp.lp_intent_ref)?);

    // --- outputs: owner payout, pool continuation, then solver change LAST ---
    // Both pinned outputs are lowered VERBATIM from the fulfillment (never adjusted)
    // so the validators re-derive identical values.
    tx = tx.output(lower_output(net, &inp.fulfillment.owner_output)?);
    tx = tx.output(lower_output(net, &inp.fulfillment.pool_output)?);
    let change = compute_change(inp, fee)?;
    let solver_addr = PallasAddress::from_bech32(inp.solver_addr_bech32)
        .map_err(|e| ChainError::Address(format!("{e:?}")))?;
    // `compute_change` already guarantees a non-negative balance, but convert (don't
    // `unwrap`) so an invariant slip surfaces as a skipped intent, never a daemon
    // panic on live funds.
    let change_lovelace = u64::try_from(change.lovelace_of()).map_err(|_| {
        ChainError::Shape(format!("negative change lovelace {}", change.lovelace_of()))
    })?;
    let change_out = apply_assets(
        shaswap_txbuilder::Output::new(solver_addr, change_lovelace),
        &change,
    )?;
    tx = tx.output(change_out);

    // Pin the built layout to the chaining indices: change must be last. A reorder
    // without updating the index consts fails loudly here, not as a submit failure.
    let n_outputs = tx.outputs.as_ref().map_or(0, Vec::len);
    if n_outputs != OUTPUT_COUNT {
        return Err(ChainError::Shape(format!(
            "fulfillment output layout drift: built {n_outputs}, expected {OUTPUT_COUNT}"
        )));
    }

    // --- redeemers: pool LpAction, intent Fulfill. NO withdrawal for S. ---
    let lp_action = plutus::to_cbor(&plutus::pool_lp_action());
    let fulfill = plutus::to_cbor(&plutus::lp_intent_fulfill());
    let exu_of = |r: &OutputReference| -> Option<ExUnits> {
        spend_exu
            .get(&(r.transaction_id.clone(), r.output_index))
            .copied()
            .map(core_exu)
    };
    let zero = ExUnits { mem: 0, steps: 0 };
    tx = tx.add_spend_redeemer(
        input_of(&inp.pool.output_reference)?,
        lp_action,
        Some(exu_of(&inp.pool.output_reference).unwrap_or(zero.clone())),
    );
    tx = tx.add_spend_redeemer(
        input_of(&inp.intent.output_reference)?,
        fulfill,
        Some(exu_of(&inp.intent.output_reference).unwrap_or(zero)),
    );

    // --- validity bound (honor the intent deadline) + the PlutusV3 cost model ---
    if let Some(slot) = inp.invalid_after_slot {
        tx = tx.invalid_from_slot(slot);
    }
    tx = tx.add_language(
        shaswap_txbuilder::ScriptKind::PlutusV3,
        inp.params.cost_model_v3.clone(),
    );

    Ok(tx)
}

/// Build + evaluate + fee-balance + sign a fulfillment tx. Does NOT submit (the
/// orchestrator does). `additional` resolves not-yet-on-chain ancestor outputs the
/// tx spends (a prior chained tx's change + pool output), passed to the `EvaluateTx`
/// gate as `additionalUtxo`. Empty for a standalone fulfillment.
pub fn build_fulfillment_signed<B: ChainBackend<Error = ChainError>>(
    inp: &FulfillInputs,
    backend: &B,
    skey: &SecretKey,
    additional: &[ResolvedUtxo],
) -> Result<BuiltFulfillment, ChainError> {
    let empty: SpendExUnits = BTreeMap::new();

    // Pass 1 — draft with zero ex-units + a provisional fee, for EvaluateTx.
    let draft = build_staging(inp, 1_500_000, &empty)?
        .build_conway_raw()
        .map_err(|e| ChainError::Shape(format!("draft build: {e:?}")))?;
    let evals = backend.evaluate(&draft.tx_bytes.0, additional)?;
    let spend_exu = map_exunits(inp, &evals)?;

    // Both script inputs (pool + intent) MUST have a real ex-units budget — else the
    // probe/final build would silently pass zeros and the node rejects phase-2.
    for r in [&inp.pool.output_reference, &inp.intent.output_reference] {
        if !spend_exu.contains_key(&(r.transaction_id.clone(), r.output_index)) {
            return Err(ChainError::Service(format!(
                "EvaluateTx returned no ex-units for script input {}#{}",
                hex::encode(&r.transaction_id),
                r.output_index
            )));
        }
    }

    // Total ex-units must fit the per-tx budget.
    let total = fees::total_ex_units(spend_exu.values().copied());
    if total.mem > inp.params.max_tx_ex_units.mem || total.steps > inp.params.max_tx_ex_units.steps
    {
        return Err(ChainError::Service(format!(
            "ex-units exceed per-tx budget: {total:?} > {:?}",
            inp.params.max_tx_ex_units
        )));
    }

    // Fee = script-exec + reference-script + size (measured) + margin.
    let exec_fee = fees::script_exec_fee(inp.params, total);
    let ref_fee = fees::reference_script_fee(inp.params, inp.ref_script_total_bytes);
    let probe = build_staging(inp, 2_000_000, &spend_exu)?
        .build_conway_raw()
        .map_err(|e| ChainError::Shape(format!("probe build: {e:?}")))?;
    let size = probe.tx_bytes.0.len() as u64 + WITNESS_OVERHEAD;
    let fee = exec_fee + ref_fee + fees::size_fee(inp.params, size) + FEE_MARGIN;

    // Final build with the real fee, then sign.
    let signed = build_staging(inp, fee, &spend_exu)?
        .build_conway_raw()
        .map_err(|e| ChainError::Shape(format!("final build: {e:?}")))?
        .sign(skey)
        .map_err(|e| ChainError::Shape(format!("sign: {e:?}")))?;

    let tx_id = signed.tx_hash.0.to_vec();
    let change_value = compute_change(inp, fee)?;
    let change = ResolvedUtxo {
        output_reference: OutputReference {
            transaction_id: tx_id.clone(),
            output_index: CHANGE_OUTPUT_INDEX,
        },
        address_bech32: inp.solver_addr_bech32.to_string(),
        value: change_value,
        datum: None,
    };

    let net = txaddr::network(inp.config.network_id);
    let pool_addr = txaddr::shelley_bech32(net, &inp.fulfillment.pool_output.address)
        .map_err(|e| ChainError::Address(format!("{e:?}")))?;
    let pool_datum = plutus::datum(&inp.fulfillment.pool_output.datum).map(|d| plutus::to_cbor(&d));
    let pool_ref = OutputReference {
        transaction_id: tx_id,
        output_index: POOL_OUTPUT_INDEX,
    };
    let pool_out = ResolvedUtxo {
        output_reference: pool_ref.clone(),
        address_bech32: pool_addr,
        value: inp.fulfillment.pool_output.value.clone(),
        datum: pool_datum,
    };
    let next_pool = PoolInput {
        output_reference: pool_ref,
        address: inp.pool.address.clone(),
        value: inp.fulfillment.pool_output.value.clone(),
        datum: inp.pool.datum.clone(),
    };

    Ok(BuiltFulfillment {
        signed,
        fee,
        total_ex_units: total,
        change,
        pool_out,
        next_pool,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Snapshot, Tip, Utxo};
    use shaswap_txbuilder::RedeemerPurpose;
    use solver_core::lp::build_fulfillment;
    use solver_core::output::Address;
    use solver_core::types::{
        AssetId, Credential, LpIntentAction, LpIntentDatum, PoolDatum, LP_NAME, POOL_MIN_ADA,
        TOTAL_LP,
    };

    // ---- fixtures ----------------------------------------------------------

    fn nft() -> AssetId {
        AssetId::new(vec![0x44; 28], vec![0x4e, 0x46, 0x54])
    }
    fn tok() -> AssetId {
        AssetId::new(vec![0x33; 28], vec![0x54])
    }
    fn lp() -> AssetId {
        AssetId::new(vec![0x44; 28], LP_NAME.to_vec())
    }
    fn owner() -> Credential {
        Credential::VerificationKey(vec![0xb1; 28])
    }
    fn lp_intent_hash() -> Vec<u8> {
        vec![0x1c; 28]
    }
    fn pool_hash() -> Vec<u8> {
        vec![0x99; 28]
    }
    fn s_cred() -> Credential {
        Credential::Script(vec![0x55; 28])
    }

    fn pool_datum() -> PoolDatum {
        PoolDatum {
            nft: nft(),
            asset_a: tok(),
            asset_b: AssetId::ada(),
            fee_num: 3,
            fee_den: 1000,
            creator: Credential::Script(vec![0xc0; 28]),
        }
    }

    fn pool_value(res_tok: i128, res_ada: i128, held: i128) -> Value {
        Value::from_lovelace(res_ada + POOL_MIN_ADA)
            .add(&tok().policy, &tok().name, res_tok)
            .add(&nft().policy, &nft().name, 1)
            .add(&lp().policy, &lp().name, held)
    }

    fn pool_input() -> PoolInput {
        PoolInput {
            output_reference: OutputReference {
                transaction_id: vec![0xd1; 32],
                output_index: 0,
            },
            address: Address {
                payment: Credential::Script(pool_hash()),
                stake: Some(s_cred()),
            },
            value: pool_value(200_000_000, 100_000_000, TOTAL_LP - 1_000_000),
            datum: pool_datum(),
        }
    }

    fn wd_intent(l: i128, tip: i128) -> LpIntentInput {
        LpIntentInput {
            output_reference: OutputReference {
                transaction_id: vec![0x1a; 32],
                output_index: 0,
            },
            address: Address {
                payment: Credential::Script(lp_intent_hash()),
                stake: None,
            },
            value: Value::from_lovelace(2_000_000 + tip).add(&lp().policy, &lp().name, l),
            datum: LpIntentDatum {
                owner: owner(),
                owner_stake: None,
                pool_nft: nft(),
                action: LpIntentAction::LpWithdraw,
                min_a: 0,
                min_b: 0,
                min_shares: 0,
                tip,
                deadline: None,
            },
        }
    }

    fn dep_intent(da: i128, db: i128, tip: i128) -> LpIntentInput {
        LpIntentInput {
            output_reference: OutputReference {
                transaction_id: vec![0x1b; 32],
                output_index: 0,
            },
            address: Address {
                payment: Credential::Script(lp_intent_hash()),
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
                min_shares: 0,
                tip,
                deadline: None,
            },
        }
    }

    fn funding_ref() -> OutputReference {
        OutputReference {
            transaction_id: vec![0xf0; 32],
            output_index: 0,
        }
    }
    fn collateral_ref() -> OutputReference {
        OutputReference {
            transaction_id: vec![0xc1; 32],
            output_index: 0,
        }
    }
    fn lp_intent_ref() -> OutputReference {
        OutputReference {
            transaction_id: vec![0xab; 32],
            output_index: 7,
        }
    }

    const SOLVER_ADDR: &str = "addr_test1vq6vymyr2plj92javazvvxfqj5aaqxhk5u3u87ud4dc8u5gyasnly";

    fn config() -> ValidatedConfig {
        // Mirror config::tests::good_json with a distinct pool_ref index.
        let h = vec![0x55u8; 28];
        ValidatedConfig {
            network_id: 0,
            settlement_cred: Credential::Script(h.clone()),
            order_script_hash: h.clone(),
            pool_script_hash: pool_hash(),
            lp_intent_script_hash: lp_intent_hash(),
            kupo_url: String::new(),
            ogmios_url: String::new(),
            settlement_ref: OutputReference {
                transaction_id: vec![0xd1; 32],
                output_index: 0,
            },
            order_ref: OutputReference {
                transaction_id: vec![0xd1; 32],
                output_index: 2,
            },
            pool_ref: OutputReference {
                transaction_id: vec![0xd1; 32],
                output_index: 1,
            },
            lp_intent_ref: Some(lp_intent_ref()),
            max_orders_per_tx: 20,
        }
    }

    fn params() -> ProtocolParams {
        ProtocolParams {
            min_fee_a: 44,
            min_fee_b: 155_381,
            price_mem: (577, 10_000),
            price_step: (721, 10_000_000),
            max_tx_ex_units: BkExUnits {
                mem: 14_000_000,
                steps: 10_000_000_000,
            },
            coins_per_utxo_byte: 4_310,
            cost_model_v3: vec![0; 251],
            ref_script_base: 15.0,
            ref_script_range: 25_600,
            ref_script_multiplier: 1.2,
        }
    }

    fn funding_value() -> Value {
        Value::from_lovelace(100_000_000)
    }

    #[allow(clippy::too_many_arguments)]
    fn inputs<'a>(
        f: &'a LpFulfillment,
        intent: &'a LpIntentInput,
        pool: &'a PoolInput,
        funding: &'a [(OutputReference, Value)],
        coll: &'a OutputReference,
        lp_ref: &'a OutputReference,
        cfg: &'a ValidatedConfig,
        p: &'a ProtocolParams,
    ) -> FulfillInputs<'a> {
        FulfillInputs {
            fulfillment: f,
            intent,
            pool,
            funding,
            collateral: coll,
            solver_addr_bech32: SOLVER_ADDR,
            config: cfg,
            params: p,
            lp_intent_ref: lp_ref,
            ref_script_total_bytes: 8_000,
            invalid_after_slot: None,
        }
    }

    // ---- a canned backend that returns spend ex-units for every input index ----

    struct MockBackend;
    impl ChainBackend for MockBackend {
        type Error = ChainError;
        fn tip(&self) -> Result<Tip, ChainError> {
            Ok(Tip { slot: 0 })
        }
        fn protocol_params(&self) -> Result<ProtocolParams, ChainError> {
            Ok(params())
        }
        fn find_orders(
            &self,
            _s: &Credential,
        ) -> Result<Vec<solver_core::output::OrderInput>, ChainError> {
            Ok(vec![])
        }
        fn find_pools(&self) -> Result<Vec<PoolInput>, ChainError> {
            Ok(vec![])
        }
        fn find_wallet_utxos(&self, _a: &str) -> Result<Vec<Utxo>, ChainError> {
            Ok(vec![])
        }
        fn evaluate(
            &self,
            _tx: &[u8],
            _add: &[ResolvedUtxo],
        ) -> Result<Vec<RedeemerEval>, ChainError> {
            // pool + intent + funding = 3 inputs; return a spend budget for each
            // index (the funding entry is simply unused — it has no redeemer).
            Ok((0..3)
                .map(|i| RedeemerEval {
                    purpose: Purpose::Spend,
                    index: i,
                    ex_units: BkExUnits {
                        mem: 500_000,
                        steps: 200_000_000,
                    },
                })
                .collect())
        }
        fn submit(&self, _tx: &[u8]) -> Result<Vec<u8>, ChainError> {
            unreachable!("the assembler never submits")
        }
        #[allow(unused)]
        fn discover(&self, _s: &Credential, _w: &str) -> Result<Snapshot, ChainError> {
            unreachable!()
        }
    }

    fn skey() -> SecretKey {
        SecretKey::from([0x11u8; 32])
    }

    // ---- compute_change is funding + tip − fee (the batcher nets only the tip) ----

    #[test]
    fn change_is_funding_plus_tip_minus_fee() {
        let tip = 1_500_000;
        let intent = wd_intent(100_000, tip);
        let pool = pool_input();
        let f = build_fulfillment(&intent, &pool, None).unwrap();
        let funding = vec![(funding_ref(), funding_value())];
        let coll = collateral_ref();
        let cfg = config();
        let p = params();
        let lp_ref = lp_intent_ref();
        let inp = inputs(&f, &intent, &pool, &funding, &coll, &lp_ref, &cfg, &p);
        let fee = 700_000;
        let change = compute_change(&inp, fee).unwrap();
        // funding (100 ADA) + tip − fee, ada-only (no native tokens leak to solver).
        assert_eq!(change.lovelace_of(), 100_000_000 + tip - fee as i128);
        assert!(change.is_ada_only(), "batcher change must be ada-only");
    }

    // ---- the built staging tx satisfies the hard safety constraints -------------

    #[test]
    fn staging_layout_and_redeemers_withdraw_free() {
        let intent = wd_intent(100_000, 1_500_000);
        let pool = pool_input();
        let f = build_fulfillment(&intent, &pool, None).unwrap();
        let funding = vec![(funding_ref(), funding_value())];
        let coll = collateral_ref();
        let cfg = config();
        let p = params();
        let lp_ref = lp_intent_ref();
        let inp = inputs(&f, &intent, &pool, &funding, &coll, &lp_ref, &cfg, &p);
        let tx = build_staging(&inp, 700_000, &BTreeMap::new()).unwrap();

        // HARD CONSTRAINT: no withdrawal for S (a Withdraw(S,0) would make BOTH
        // validators reject — the no-fold guard).
        assert!(
            tx.withdrawals.is_none(),
            "a fulfillment must carry no withdrawal"
        );
        // HARD CONSTRAINT: mint == 0 (we never set a mint).
        assert!(tx.mint.is_none(), "a fulfillment must not mint/burn");

        // inputs: pool + intent + 1 funding = 3.
        assert_eq!(tx.inputs.as_ref().unwrap().len(), 3);
        // reference inputs: pool + lp_intent = 2.
        assert_eq!(tx.reference_inputs.as_ref().unwrap().len(), 2);
        // outputs: owner, pool, change = 3.
        assert_eq!(tx.outputs.as_ref().unwrap().len(), OUTPUT_COUNT);

        // exactly two spend redeemers, no others.
        let rdmrs = tx.redeemers.as_ref().unwrap();
        assert_eq!(rdmrs.len(), 2);
        let pool_in = input_of(&pool.output_reference).unwrap();
        let intent_in = input_of(&intent.output_reference).unwrap();
        let pool_rd = rdmrs
            .get(&RedeemerPurpose::Spend(pool_in))
            .expect("pool redeemer");
        let intent_rd = rdmrs
            .get(&RedeemerPurpose::Spend(intent_in))
            .expect("intent redeemer");
        // pool → LpAction (Constr 1 []); intent → Fulfill (Constr 0 []).
        assert_eq!(
            pool_rd.0.as_ref(),
            plutus::to_cbor(&plutus::pool_lp_action())
        );
        assert_eq!(
            intent_rd.0.as_ref(),
            plutus::to_cbor(&plutus::lp_intent_fulfill())
        );
        for k in rdmrs.keys() {
            assert!(
                matches!(k, RedeemerPurpose::Spend(_)),
                "only spend redeemers allowed in a fulfillment, got {k:?}"
            );
        }
    }

    // ---- end-to-end: build a signed withdraw + deposit fulfillment via the gate --

    #[test]
    fn builds_signed_withdraw_and_deposit() {
        let backend = MockBackend;
        let sk = skey();
        let cfg = config();
        let p = params();
        let lp_ref = lp_intent_ref();
        let coll = collateral_ref();
        let funding = vec![(funding_ref(), funding_value())];
        let pool = pool_input();

        for intent in [
            wd_intent(100_000, 1_500_000),
            dep_intent(20_000_000, 10_000_000, 1_500_000),
        ] {
            let f = build_fulfillment(&intent, &pool, None).unwrap();
            let inp = inputs(&f, &intent, &pool, &funding, &coll, &lp_ref, &cfg, &p);
            let built = build_fulfillment_signed(&inp, &backend, &sk, &[]).expect("builds");
            // the pool continuation + change refs point at THIS tx, at the pinned indices.
            assert_eq!(
                built.pool_out.output_reference.output_index,
                POOL_OUTPUT_INDEX
            );
            assert_eq!(
                built.change.output_reference.output_index,
                CHANGE_OUTPUT_INDEX
            );
            assert_eq!(
                built.pool_out.output_reference.transaction_id,
                built.signed.tx_hash.0.to_vec()
            );
            // next_pool carries the recreated pool value + unchanged datum/address.
            assert_eq!(built.next_pool.value, f.pool_output.value);
            assert_eq!(built.next_pool.datum, pool.datum);
            assert_eq!(built.next_pool.address, pool.address);
            // change is ada-only and positive (funding + tip − fee).
            assert!(built.change.value.is_ada_only());
            assert!(built.change.value.lovelace_of() > 0);
            // a real fee was charged.
            assert!(built.fee > 0);
        }
    }
}
