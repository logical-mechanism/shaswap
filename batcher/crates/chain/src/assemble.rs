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

use crate::backend::{ChainBackend, ExUnits as BkExUnits, ProtocolParams, Purpose, RedeemerEval};
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
}

/// Build + evaluate + fee-balance + sign a settlement tx. Does NOT submit (the
/// orchestrator does, via the backend), so the same backend serves the
/// EvaluateTx gate here and submission there.
pub fn build_signed<B: ChainBackend<Error = ChainError>>(
    inp: &AssembleInputs,
    backend: &B,
    skey: &SecretKey,
) -> Result<BuiltSettlement, ChainError> {
    let empty: SpendExUnits = BTreeMap::new();
    let zero = BkExUnits { mem: 0, steps: 0 };

    // Pass 1 — draft with zero ex-units + a provisional fee, for EvaluateTx.
    let draft = build_staging(inp, 1_500_000, &empty, zero)?
        .build_conway_raw()
        .map_err(|e| ChainError::Shape(format!("draft build: {e:?}")))?;
    let evals = backend.evaluate(&draft.tx_bytes.0)?;
    let (spend_exu, reward_exu) = map_exunits(inp, &evals)?;

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

    Ok(BuiltSettlement {
        signed,
        fee,
        total_ex_units: total,
    })
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
            address: Address::payout(Credential::VerificationKey(vec![addr_owner; 28])),
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
}
