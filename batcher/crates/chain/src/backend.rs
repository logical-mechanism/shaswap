//! The `ChainBackend` abstraction — every bit of chain access the solver needs,
//! behind one trait so the provider (Kupo + Ogmios today, a local Dolos node later)
//! is swappable. The orchestrator depends only on this trait.
//!
//! It is intentionally small and synchronous: a reference solver does one batch at
//! a time and clarity beats throughput. Discovery returns `solver-core` domain
//! types (datums already decoded via [`crate::decode`]); evaluation/submission take
//! and return raw tx CBOR.

use solver_core::output::{OrderInput, PoolInput};
use solver_core::types::{AssetId, Credential};

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

    /// Local Phase-2 evaluation of a built tx — the **pre-submit gate**. Every tx
    /// must pass this (and have its ex-units filled from the result) before submit.
    fn evaluate(&self, tx_cbor: &[u8]) -> Result<Vec<RedeemerEval>, Self::Error>;

    /// Submit a fully-built, signed tx; returns its id (32 bytes).
    fn submit(&self, tx_cbor: &[u8]) -> Result<Vec<u8>, Self::Error>;
}
