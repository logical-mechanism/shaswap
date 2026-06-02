//! Body assembly: turn a solved [`Settlement`] (+ the order/pool inputs it consumed
//! and the solver's funding/collateral) into a fully-built, signed Conway
//! transaction the validators accept — the exact tx shape `happy_path/06-settle.sh`
//! produced with cardano-cli, but programmatic.
//!
//! Layout (BLUEPRINT §5.2 / the anchor): owner payouts are outputs `[0,N)` (inline
//! `BoundDatum`), then the pool output (inline `PoolDatum`, carries the NFT), then
//! remainders, then the **solver change output LAST** (we compute change ourselves;
//! the forked builder does not auto-balance). Spends: each order → `Settle`, the
//! pool → `PoolSettle`; the withdraw-0 reward account `S` carries the
//! `SettlementRedeemer`. The 3 validators come in as reference inputs.
//!
//! Flow: build a draft (ex-units 0) → Ogmios `EvaluateTx` fills per-redeemer
//! ex-units (the pre-submit gate) → compute fee (script-exec + reference-script +
//! size, with a margin) → rebuild → sign.

use crate::backend::{
    ChainBackend, ExUnits as BkExUnits, ProtocolParams, Purpose, RedeemerEval, ResolvedUtxo,
};
use crate::config::ValidatedConfig;
use crate::fees;
use crate::kupo_ogmios::ChainError;
use pallas_addresses::{Address as PallasAddress, Network};
use pallas_crypto::hash::Hash;
use pallas_crypto::key::ed25519::SecretKey;
use shaswap_txbuilder::{
    BuildConway, BuiltTransaction, ExUnits, Input, Output, ScriptKind, StagingTransaction,
};
use solver_core::clearing::Settlement;
use solver_core::output::{OrderInput, Output as CoreOutput, PoolInput};
use solver_core::types::OutputReference;
use solver_core::value::Value;
use std::collections::BTreeMap;
use txbuild::{address as txaddr, plutus};

/// A fee safety margin (lovelace). The solver overpays a touch out of its own
/// change rather than risk a just-under-minimum fee; harmless for a reference solver.
const FEE_MARGIN: u64 = 50_000;
/// Bytes a single vkey witness adds to the encoded tx (vkey 32 + sig 64 + CBOR
/// overhead), used to size the fee before signing.
const WITNESS_OVERHEAD: u64 = 128;

/// Per-script-input ex-units, keyed by `(tx_id, output_index)`.
type SpendExUnits = BTreeMap<(Vec<u8>, u64), BkExUnits>;

/// Everything the assembler needs. Borrows the solved settlement + its inputs.
pub struct AssembleInputs<'a> {
    pub settlement: &'a Settlement,
    /// Included orders, in the SAME canonical order as `settlement.owner_outputs`.
    pub orders: &'a [OrderInput],
    pub pool: &'a PoolInput,
    /// Solver funding input refs + their values (leftover returns as change).
    pub funding: &'a [(OutputReference, Value)],
    /// Collateral input ref (a pure-ADA UTXO ≥ 5 ADA).
    pub collateral: &'a OutputReference,
    /// The solver's own address (bech32) — receives the change output.
    pub solver_addr_bech32: &'a str,
    pub config: &'a ValidatedConfig,
    pub params: &'a ProtocolParams,
    /// Total byte size of the 3 referenced validator scripts (for the ref-script fee).
    pub ref_script_total_bytes: u64,
    /// `ttl` (slot) the tx must end by, if any included order has a deadline.
    pub invalid_after_slot: Option<u64>,
}

fn core_exu(e: BkExUnits) -> ExUnits {
    ExUnits {
        mem: e.mem,
        steps: e.steps,
    }
}

fn hash28(bytes: &[u8]) -> Result<Hash<28>, ChainError> {
    let arr: [u8; 28] = bytes
        .try_into()
        .map_err(|_| ChainError::Shape(format!("expected 28-byte hash, got {}", bytes.len())))?;
    Ok(Hash::from(arr))
}

fn hash32(bytes: &[u8]) -> Result<Hash<32>, ChainError> {
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ChainError::Shape(format!("expected 32-byte id, got {}", bytes.len())))?;
    Ok(Hash::from(arr))
}

fn input_of(r: &OutputReference) -> Result<Input, ChainError> {
    Ok(Input::new(hash32(&r.transaction_id)?, r.output_index))
}

/// Apply a solver-core [`Value`]'s native assets onto a builder [`Output`] (ADA is
/// already set via `Output::new`).
fn apply_assets(mut o: Output, v: &Value) -> Result<Output, ChainError> {
    for (policy, name, qty) in v.flatten() {
        if policy.is_empty() && name.is_empty() {
            continue; // ADA
        }
        let amount = u64::try_from(qty)
            .map_err(|_| ChainError::Shape(format!("negative/oversized asset qty {qty}")))?;
        o = o
            .add_asset(hash28(policy)?, name.clone(), amount)
            .map_err(|e| ChainError::Shape(format!("add_asset: {e:?}")))?;
    }
    Ok(o)
}

/// Lower a settlement [`CoreOutput`] (owner/pool/remainder) into a builder output,
/// preserving its inline datum.
fn lower_output(net: Network, o: &CoreOutput) -> Result<Output, ChainError> {
    let addr_bytes = txaddr::shelley_bytes(net, &o.address)
        .map_err(|e| ChainError::Address(format!("{e:?}")))?;
    let addr = PallasAddress::from_bytes(&addr_bytes)
        .map_err(|e| ChainError::Address(format!("{e:?}")))?;
    let lovelace = u64::try_from(o.value.lovelace_of())
        .map_err(|_| ChainError::Shape("negative output lovelace".into()))?;
    let mut out = apply_assets(Output::new(addr, lovelace), &o.value)?;
    if let Some(d) = plutus::datum(&o.datum) {
        out = out.set_inline_datum(plutus::to_cbor(&d));
    }
    Ok(out)
}

/// Σ value over every input (orders + pool + funding).
fn total_in(inp: &AssembleInputs) -> Value {
    let mut bal = Value::zero();
    add_value(&mut bal, &inp.pool.value, 1);
    for o in inp.orders {
        add_value(&mut bal, &o.value, 1);
    }
    for (_, v) in inp.funding {
        add_value(&mut bal, v, 1);
    }
    bal
}

fn add_value(bal: &mut Value, v: &Value, sign: i128) {
    for (p, n, q) in v.flatten() {
        bal.add_mut(p, n, sign * q);
    }
}

/// The solver change value = Σin − (owner+pool+remainder outputs) − fee.
fn change_value(inp: &AssembleInputs, fee: u64) -> Result<Value, ChainError> {
    compute_change(&total_in(inp), inp.settlement, fee)
}

/// Pure change arithmetic: `total_in` − all pinned outputs − fee. Errors if any
/// asset goes negative (inputs don't cover outputs + fee).
fn compute_change(
    total_in: &Value,
    settlement: &Settlement,
    fee: u64,
) -> Result<Value, ChainError> {
    let mut bal = total_in.clone();
    for o in &settlement.owner_outputs {
        add_value(&mut bal, &o.value, -1);
    }
    add_value(&mut bal, &settlement.pool_output.value, -1);
    for r in &settlement.remainders {
        add_value(&mut bal, &r.value, -1);
    }
    bal.add_mut(&[], &[], -(fee as i128));
    for (_, _, q) in bal.flatten() {
        if q < 0 {
            return Err(ChainError::Shape(
                "inputs do not cover outputs + fee (negative change)".into(),
            ));
        }
    }
    Ok(bal)
}

/// The canonical sorted refs of every tx input (orders + pool + funding) — the
/// order Ogmios/ledger index `Spend` redeemers against.
fn sorted_input_refs(inp: &AssembleInputs) -> Vec<OutputReference> {
    let mut refs: Vec<OutputReference> = Vec::new();
    refs.push(inp.pool.output_reference.clone());
    for o in inp.orders {
        refs.push(o.output_reference.clone());
    }
    for (r, _) in inp.funding {
        refs.push(r.clone());
    }
    refs.sort_by(|a, b| {
        (&a.transaction_id, a.output_index).cmp(&(&b.transaction_id, b.output_index))
    });
    refs
}

/// Map `EvaluateTx` results back to each script input's ex-units + the withdraw
/// redeemer's ex-units, by matching the canonical sorted indices.
fn map_exunits(
    inp: &AssembleInputs,
    evals: &[RedeemerEval],
) -> Result<(SpendExUnits, BkExUnits), ChainError> {
    let sorted = sorted_input_refs(inp);
    let mut spend: SpendExUnits = BTreeMap::new();
    let mut reward: Option<BkExUnits> = None;
    for e in evals {
        match e.purpose {
            Purpose::Spend => {
                let r = sorted.get(e.index as usize).ok_or_else(|| {
                    ChainError::Shape(format!("spend eval index {} out of range", e.index))
                })?;
                spend.insert((r.transaction_id.clone(), r.output_index), e.ex_units);
            }
            Purpose::Withdraw => reward = Some(e.ex_units),
            // a settlement has only spend + withdraw redeemers.
            other => {
                return Err(ChainError::Shape(format!(
                    "unexpected redeemer purpose {other:?}"
                )))
            }
        }
    }
    let reward = reward
        .ok_or_else(|| ChainError::Shape("EvaluateTx returned no withdraw redeemer".into()))?;
    Ok((spend, reward))
}

/// Build the staging tx for a given fee and ex-units assignment (zeros for the
/// draft pass). `spend_exu`/`reward_exu` keyed as in [`map_exunits`].
fn build_staging(
    inp: &AssembleInputs,
    fee: u64,
    spend_exu: &SpendExUnits,
    reward_exu: BkExUnits,
) -> Result<StagingTransaction, ChainError> {
    let net = txaddr::network(inp.config.network_id);
    let mut tx = StagingTransaction::new().fee(fee);

    // --- inputs: orders + pool + funding ---
    tx = tx.input(input_of(&inp.pool.output_reference)?);
    for o in inp.orders {
        tx = tx.input(input_of(&o.output_reference)?);
    }
    for (r, _) in inp.funding {
        tx = tx.input(input_of(r)?);
    }

    // --- collateral + the 3 reference scripts ---
    tx = tx.collateral_input(input_of(inp.collateral)?);
    tx = tx
        .reference_input(input_of(&inp.config.settlement_ref)?)
        .reference_input(input_of(&inp.config.order_ref)?)
        .reference_input(input_of(&inp.config.pool_ref)?);

    // --- outputs: owners [0,N), pool, remainders, then solver change LAST ---
    for o in &inp.settlement.owner_outputs {
        tx = tx.output(lower_output(net, o)?);
    }
    tx = tx.output(lower_output(net, &inp.settlement.pool_output)?);
    for r in &inp.settlement.remainders {
        tx = tx.output(lower_output(net, r)?);
    }
    let change = change_value(inp, fee)?;
    let solver_addr = PallasAddress::from_bech32(inp.solver_addr_bech32)
        .map_err(|e| ChainError::Address(format!("{e:?}")))?;
    let change_out = apply_assets(
        Output::new(solver_addr, u64::try_from(change.lovelace_of()).unwrap()),
        &change,
    )?;
    tx = tx.output(change_out);

    // Tie the actual built layout to the index helpers used for chaining: the
    // change output must be the last, at `change_output_index`. If anyone reorders
    // or inserts an output above without updating the index fns, this fails loudly
    // here instead of silently stamping a wrong output_index into the next link's
    // funding/pool ref (which would only surface as a submit failure downstream).
    let n_outputs = tx.outputs.as_ref().map_or(0, Vec::len);
    if n_outputs != change_output_index(inp.settlement) as usize + 1 {
        return Err(ChainError::Shape(format!(
            "output layout drift: built {n_outputs} outputs, change index {}",
            change_output_index(inp.settlement)
        )));
    }

    // --- redeemers: each order Settle, pool PoolSettle, withdraw-0 SettlementRedeemer ---
    let order_settle = plutus::to_cbor(&plutus::order_settle());
    let pool_settle = plutus::to_cbor(&plutus::pool_settle());
    let exu_of = |r: &OutputReference| -> Option<ExUnits> {
        spend_exu
            .get(&(r.transaction_id.clone(), r.output_index))
            .copied()
            .map(core_exu)
    };
    tx = tx.add_spend_redeemer(
        input_of(&inp.pool.output_reference)?,
        pool_settle,
        Some(exu_of(&inp.pool.output_reference).unwrap_or(ExUnits { mem: 0, steps: 0 })),
    );
    for o in inp.orders {
        tx = tx.add_spend_redeemer(
            input_of(&o.output_reference)?,
            order_settle.clone(),
            Some(exu_of(&o.output_reference).unwrap_or(ExUnits { mem: 0, steps: 0 })),
        );
    }

    // withdraw-0 reward account S + the settlement redeemer.
    let reward_account = txaddr::reward_account(net, &inp.config.settlement_cred)
        .map_err(|e| ChainError::Address(format!("{e:?}")))?;
    let sr = plutus::to_cbor(&plutus::settlement_redeemer(&inp.settlement.redeemer));
    tx = tx
        .withdrawal(reward_account.clone(), 0)
        .add_withdraw_redeemer(reward_account, sr, Some(core_exu(reward_exu)));

    // --- validity bound + the PlutusV3 cost model (drives script_data_hash) ---
    if let Some(slot) = inp.invalid_after_slot {
        tx = tx.invalid_from_slot(slot);
    }
    tx = tx.add_language(ScriptKind::PlutusV3, inp.params.cost_model_v3.clone());

    Ok(tx)
}

/// The finalized, signed transaction plus the numbers worth logging.
pub struct BuiltSettlement {
    pub signed: BuiltTransaction,
    pub fee: u64,
    pub total_ex_units: BkExUnits,
    /// The solver-change output this tx creates (last output) — its resolved
    /// form. In a chain it becomes the next tx's funding input, and is supplied
    /// as `additionalUtxo` to that tx's `EvaluateTx` (it isn't on-chain yet).
    pub change: ResolvedUtxo,
    /// The pool-continuation output this tx creates (the pool, at index N). When
    /// the SAME pool is settled again in this pass (a capped batch was split), the
    /// next tx spends this as its pool input and resolves it via `additionalUtxo`.
    /// Carries the pool's inline `PoolDatum` (unchanged by settlement).
    pub pool_out: ResolvedUtxo,
    /// The pool as it will exist after this tx — the [`PoolInput`] the next capped
    /// batch of the SAME pool must spend. Built here (not hand-assembled by the
    /// caller) so its `output_reference`/`value` stay consistent with `pool_out`,
    /// and its `address`/`datum` come from this tx's pool input (the settlement
    /// validator pins both unchanged). Resolving it at the next gate uses `pool_out`.
    pub next_pool: PoolInput,
}

/// The output index of the solver-change output (always last): owners `[0,N)`,
/// then the pool, then remainders, then change. Single source of the layout the
/// chaining refs depend on; `build_staging` asserts the built tx matches it.
fn change_output_index(s: &Settlement) -> u64 {
    (s.owner_outputs.len() + 1 + s.remainders.len()) as u64
}

/// The output index of the pool-continuation output: right after the N owner
/// outputs (owners `[0,N)`, then the pool).
fn pool_output_index(s: &Settlement) -> u64 {
    s.owner_outputs.len() as u64
}

/// Build + evaluate + fee-balance + sign a settlement tx. Does NOT submit (the
/// orchestrator does, via the backend), so the same backend serves the
/// EvaluateTx gate here and submission there.
///
/// `additional` resolves any not-yet-on-chain ancestor outputs the tx spends (the
/// previous chained settlement's change), passed to the `EvaluateTx` gate as
/// `additionalUtxo`. Empty for a standalone (non-chained) settlement.
pub fn build_signed<B: ChainBackend<Error = ChainError>>(
    inp: &AssembleInputs,
    backend: &B,
    skey: &SecretKey,
    additional: &[ResolvedUtxo],
) -> Result<BuiltSettlement, ChainError> {
    let empty: SpendExUnits = BTreeMap::new();
    let zero = BkExUnits { mem: 0, steps: 0 };

    // Pass 1 — draft with zero ex-units + a provisional fee, for EvaluateTx.
    let draft = build_staging(inp, 1_500_000, &empty, zero)?
        .build_conway_raw()
        .map_err(|e| ChainError::Shape(format!("draft build: {e:?}")))?;
    let evals = backend.evaluate(&draft.tx_bytes.0, additional)?;
    let (spend_exu, reward_exu) = map_exunits(inp, &evals)?;

    // Every script input MUST have a real ex-units budget from EvaluateTx. The
    // draft passes zeros deliberately, but the probe/final builds fall back to
    // zero for any input missing here — which would silently produce a tx the
    // node rejects phase-2. Fail loudly instead if EvaluateTx under-reported.
    let mut script_refs = vec![&inp.pool.output_reference];
    script_refs.extend(inp.orders.iter().map(|o| &o.output_reference));
    for r in script_refs {
        if !spend_exu.contains_key(&(r.transaction_id.clone(), r.output_index)) {
            return Err(ChainError::Service(format!(
                "EvaluateTx returned no ex-units for script input {}#{}",
                hex::encode(&r.transaction_id),
                r.output_index
            )));
        }
    }

    // Total ex-units must fit the per-tx budget (the gate).
    let total = fees::total_ex_units(
        spend_exu
            .values()
            .copied()
            .chain(std::iter::once(reward_exu))
            .map(|e| crate::backend::ExUnits {
                mem: e.mem,
                steps: e.steps,
            }),
    );
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
    // Measure the body with real ex-units (fee placeholder) to size the size-fee.
    let probe = build_staging(inp, 2_000_000, &spend_exu, reward_exu)?
        .build_conway_raw()
        .map_err(|e| ChainError::Shape(format!("probe build: {e:?}")))?;
    let size = probe.tx_bytes.0.len() as u64 + WITNESS_OVERHEAD;
    let fee = exec_fee + ref_fee + fees::size_fee(inp.params, size) + FEE_MARGIN;

    // Final build with the real fee, then sign.
    let signed = build_staging(inp, fee, &spend_exu, reward_exu)?
        .build_conway_raw()
        .map_err(|e| ChainError::Shape(format!("final build: {e:?}")))?
        .sign(skey)
        .map_err(|e| ChainError::Shape(format!("sign: {e:?}")))?;

    // The change output's resolved form — funding for the next tx in a chain, and
    // the `additionalUtxo` entry that lets its gate resolve this still-unconfirmed
    // output. Its ref is (this tx's id, the change index).
    let tx_id = signed.tx_hash.0.to_vec();
    let change_value = change_value(inp, fee)?;
    let change = ResolvedUtxo {
        output_reference: OutputReference {
            transaction_id: tx_id.clone(),
            output_index: change_output_index(inp.settlement),
        },
        address_bech32: inp.solver_addr_bech32.to_string(),
        value: change_value,
        datum: None,
    };

    // The pool-continuation output's resolved form — funding/input for the next
    // capped batch of the SAME pool. Its address is the pool's (tagged `S`); its
    // inline datum is the (unchanged) `PoolDatum`.
    let net = txaddr::network(inp.config.network_id);
    let pool_addr = txaddr::shelley_bech32(net, &inp.settlement.pool_output.address)
        .map_err(|e| ChainError::Address(format!("{e:?}")))?;
    let pool_datum = plutus::datum(&inp.settlement.pool_output.datum).map(|d| plutus::to_cbor(&d));
    let pool_ref = OutputReference {
        transaction_id: tx_id,
        output_index: pool_output_index(inp.settlement),
    };
    let pool_out = ResolvedUtxo {
        output_reference: pool_ref.clone(),
        address_bech32: pool_addr,
        value: inp.settlement.pool_output.value.clone(),
        datum: pool_datum,
    };
    // The pool as it will exist after this tx — the next capped batch's input.
    // Same ref/value as `pool_out`; address + datum from THIS tx's pool input, which
    // the settlement validator pins unchanged (so no need to re-decode `pool_out`).
    let next_pool = PoolInput {
        output_reference: pool_ref,
        address: inp.pool.address.clone(),
        value: inp.settlement.pool_output.value.clone(),
        datum: inp.pool.datum.clone(),
    };

    Ok(BuiltSettlement {
        signed,
        fee,
        total_ex_units: total,
        change,
        pool_out,
        next_pool,
    })
}

/// Build + sign a plain (no-script) tx that carves a pure-ADA collateral UTXO of
/// `collateral_lovelace` out of `source`, returning the rest (incl. any native
/// tokens, minus fee) as change — both to `solver_addr_bech32`. Used once at
/// startup to self-provision collateral when the operator funded the solver as a
/// single lump (a settlement needs a funding input AND a distinct collateral
/// input, so ≥2 wallet UTXOs are required). Caller must ensure `source` holds
/// enough ADA (collateral + fee + a min-ADA change).
pub fn build_collateral_split(
    source: &OutputReference,
    source_value: &Value,
    solver_addr_bech32: &str,
    collateral_lovelace: u64,
    params: &ProtocolParams,
    skey: &SecretKey,
) -> Result<BuiltTransaction, ChainError> {
    let solver = PallasAddress::from_bech32(solver_addr_bech32)
        .map_err(|e| ChainError::Address(format!("{e:?}")))?;

    let build = |fee: u64| -> Result<StagingTransaction, ChainError> {
        // collateral output: pure ADA, no datum/tokens.
        let collateral = Output::new(solver.clone(), collateral_lovelace);
        // change: everything else, minus collateral + fee from the ADA side.
        let change_val = source_value.add(&[], &[], -((collateral_lovelace + fee) as i128));
        let change_ada = change_val.lovelace_of();
        if change_ada < 0 {
            return Err(ChainError::Shape(
                "source UTXO can't cover collateral + fee".into(),
            ));
        }
        let change = apply_assets(Output::new(solver.clone(), change_ada as u64), &change_val)?;
        Ok(StagingTransaction::new()
            .fee(fee)
            .input(input_of(source)?)
            .output(collateral)
            .output(change))
    };

    // Two-pass fee: a plain tx pays only the size fee (no scripts).
    let probe = build(300_000)?
        .build_conway_raw()
        .map_err(|e| ChainError::Shape(format!("split probe: {e:?}")))?;
    let size = probe.tx_bytes.0.len() as u64 + WITNESS_OVERHEAD;
    let fee = fees::size_fee(params, size) + FEE_MARGIN;
    build(fee)?
        .build_conway_raw()
        .map_err(|e| ChainError::Shape(format!("split build: {e:?}")))?
        .sign(skey)
        .map_err(|e| ChainError::Shape(format!("split sign: {e:?}")))
}

/// Load a cardano-cli `PaymentSigningKeyShelley_ed25519` skey (TextEnvelope) into
/// an [`ed25519::SecretKey`](SecretKey). The `cborHex` is `5820<32 raw bytes>`.
pub fn load_signing_key(path: &str) -> Result<SecretKey, ChainError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| ChainError::Http(format!("read skey {path}: {e}")))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| ChainError::Shape(format!("skey json: {e}")))?;
    let cbor_hex = json
        .get("cborHex")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ChainError::Shape("skey missing cborHex".into()))?;
    let bytes = hex::decode(cbor_hex).map_err(|e| ChainError::Shape(format!("skey hex: {e}")))?;
    // Strip the CBOR bytestring header (0x5820 = bytes(32)).
    let raw = bytes
        .strip_prefix(&[0x58, 0x20])
        .ok_or_else(|| ChainError::Shape("skey not a 32-byte CBOR bytestring".into()))?;
    let arr: [u8; 32] = raw
        .try_into()
        .map_err(|_| ChainError::Shape("skey wrong length".into()))?;
    Ok(SecretKey::from(arr))
}

#[cfg(test)]
mod tests {
    use super::*;

    use solver_core::output::{Address, Datum};
    use solver_core::types::{AssetId, Credential, SettlementRedeemer, NFT_NAME};

    fn out(addr_owner: u8, v: Value) -> CoreOutput {
        CoreOutput {
            address: Address::payout(Credential::VerificationKey(vec![addr_owner; 28]), None),
            value: v,
            datum: Datum::None,
            reference_script: None,
        }
    }

    fn settlement(owner: Value, pool: Value) -> Settlement {
        Settlement {
            redeemer: SettlementRedeemer {
                price_num: 1,
                price_den: 1,
                asset_a: AssetId::new(vec![0x33; 28], vec![0x54]),
                asset_b: AssetId::ada(),
                pool_nft: AssetId::new(vec![0x44; 28], NFT_NAME.to_vec()),
                fills: vec![],
            },
            owner_outputs: vec![out(0xb1, owner)],
            pool_output: out(0x99, pool),
            remainders: vec![],
            net_a: 0,
            net_b: 0,
            tip_taken_total: 0,
        }
    }

    #[test]
    fn change_is_inputs_minus_outputs_minus_fee() {
        let tok = vec![0x33u8; 28];
        // Σin = 100 ADA + 7 TEST; owner gets 6 ADA, pool keeps 90 ADA + 7 TEST.
        let total = Value::from_lovelace(100_000_000).add(&tok, b"T", 7);
        let st = settlement(
            Value::from_lovelace(6_000_000),
            Value::from_lovelace(90_000_000).add(&tok, b"T", 7),
        );
        let change = compute_change(&total, &st, 1_000_000).unwrap();
        // 100 - 6 - 90 - 1 (fee) = 3 ADA; TEST nets to 0.
        assert_eq!(change.lovelace_of(), 3_000_000);
        assert_eq!(change.quantity_of(&tok, b"T"), 0);
    }

    #[test]
    fn change_rejects_when_inputs_short() {
        let total = Value::from_lovelace(5_000_000);
        let st = settlement(Value::from_lovelace(6_000_000), Value::zero());
        assert!(compute_change(&total, &st, 1_000_000).is_err());
    }

    // A settlement with N owner outputs and R remainders, for index math.
    fn settlement_with(n_owners: usize, n_remainders: usize) -> Settlement {
        let mut s = settlement(Value::from_lovelace(1), Value::from_lovelace(1));
        s.owner_outputs = (0..n_owners).map(|i| out(i as u8, Value::zero())).collect();
        s.remainders = (0..n_remainders)
            .map(|i| out(0x70 + i as u8, Value::zero()))
            .collect();
        s
    }

    #[test]
    fn output_indices_track_the_owners_pool_remainders_change_layout() {
        // Layout: owners [0,N) -> pool (N) -> remainders -> change (last).
        let st = settlement_with(3, 2);
        assert_eq!(pool_output_index(&st), 3); // right after the 3 owners
        assert_eq!(change_output_index(&st), 3 + 1 + 2); // owners + pool + remainders
                                                         // No remainders: pool at N, change immediately after the pool.
        let st0 = settlement_with(1, 0);
        assert_eq!(pool_output_index(&st0), 1);
        assert_eq!(change_output_index(&st0), 2);
    }
}
