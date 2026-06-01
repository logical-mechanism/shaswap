//! The `ChainBackend` abstraction — every bit of chain access the solver needs,
//! behind one trait so the provider (Kupo + Ogmios today, a local Dolos node later)
//! is swappable. The orchestrator depends only on this trait.
//!
//! It is intentionally small and synchronous: a reference solver does one batch at
//! a time and clarity beats throughput. Discovery returns `solver-core` domain
//! types (datums already decoded via [`crate::decode`]); evaluation/submission take
//! and return raw tx CBOR.

use solver_core::output::{OrderInput, PoolInput};
use solver_core::types::{AssetId, Credential, OutputReference};
use solver_core::value::Value;

/// A plain wallet UTXO (no domain datum) — used to pick the solver's funding and
/// collateral inputs. `has_reference_script` flags the deployed reference-script
/// UTXOs so they're never spent as funding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Utxo {
    pub output_reference: OutputReference,
    pub value: Value,
    pub has_reference_script: bool,
    pub has_datum: bool,
}

impl Utxo {
    /// A pure-ADA UTXO with no datum and no attached reference script — the only
    /// kind safe to use as funding or collateral.
    pub fn is_pure_ada(&self) -> bool {
        !self.has_reference_script && !self.has_datum && self.value.is_ada_only()
    }
}

/// The chain tip — enough to set a slot-based validity bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tip {
    pub slot: u64,
}

/// The protocol parameters the chain layer needs to finalize a tx: fee
/// coefficients, the per-ex-unit script prices, and the reference-script fee. (Cost
/// models for the `script_data_hash` are fetched separately as raw language views.)
#[derive(Debug, Clone, PartialEq)]
pub struct ProtocolParams {
    pub min_fee_a: u64,
    pub min_fee_b: u64,
    /// Price per memory unit and per cpu step, as exact rationals (num, den).
    pub price_mem: (u64, u64),
    pub price_step: (u64, u64),
    pub max_tx_ex_units: ExUnits,
    pub coins_per_utxo_byte: u64,
    /// The PlutusV3 cost model (flat list of parameters), as the ledger orders it.
    /// Fed verbatim into the `language_views` that determine `script_data_hash`.
    pub cost_model_v3: Vec<i64>,
    /// Conway reference-script tiered pricing (`minFeeReferenceScripts`): per-byte
    /// `base` lovelace for the first `range` bytes, scaled by `multiplier` each
    /// subsequent tier. A settlement references 3 scripts, so this is non-trivial.
    pub ref_script_base: f64,
    pub ref_script_range: u64,
    pub ref_script_multiplier: f64,
}

/// Execution-unit budget/cost (memory + cpu steps), mirroring the ledger type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExUnits {
    pub mem: u64,
    pub steps: u64,
}

/// One redeemer's evaluated cost, as returned by Ogmios `EvaluateTx`. Keyed by the
/// redeemer's purpose tag + index so it can be matched back to the built redeemer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RedeemerEval {
    /// Purpose tag: `"spend" | "mint" | "publish"(cert) | "withdraw"(reward) | ...`.
    pub purpose: Purpose,
    pub index: u32,
    pub ex_units: ExUnits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Spend,
    Mint,
    Withdraw,
    Cert,
    Vote,
    Propose,
}

/// Everything the solver needs from the chain. Discovery, params, the EvaluateTx
/// **pre-submit gate**, and submission.
pub trait ChainBackend {
    type Error;

    /// Current chain tip (for the validity bound).
    fn tip(&self) -> Result<Tip, Self::Error>;

    /// Protocol parameters.
    fn protocol_params(&self) -> Result<ProtocolParams, Self::Error>;

    /// All order UTXOs tagged with the settlement stake credential `S`, decoded.
    fn find_orders(&self, s: &Credential) -> Result<Vec<OrderInput>, Self::Error>;

    /// The pool UTXO carrying `nft`, decoded.
    fn find_pool(&self, nft: &AssetId) -> Result<PoolInput, Self::Error>;

    /// All unspent UTXOs at `address` (the solver wallet) — for funding/collateral
    /// selection. Returns plain [`Utxo`]s (no domain decoding).
    fn find_wallet_utxos(&self, address: &str) -> Result<Vec<Utxo>, Self::Error>;

    /// Local Phase-2 evaluation of a built tx — the **pre-submit gate**. Every tx
    /// must pass this (and have its ex-units filled from the result) before submit.
    fn evaluate(&self, tx_cbor: &[u8]) -> Result<Vec<RedeemerEval>, Self::Error>;

    /// Submit a fully-built, signed tx; returns its id (32 bytes).
    fn submit(&self, tx_cbor: &[u8]) -> Result<Vec<u8>, Self::Error>;
}
