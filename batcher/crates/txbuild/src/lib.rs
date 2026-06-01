//! # txbuild
//!
//! Lowers a `solver-core` [`Settlement`](solver_core::clearing::Settlement) into a
//! Plutus-v3 (Conway) Cardano transaction the ShaSwap validators accept.
//!
//! Layered so the parts that need no chain access are testable on their own:
//! - [`plutus`] — Plutus `Data` encoding of every datum/redeemer (matches
//!   `contracts/plutus.json` exactly). Fully unit-tested offline.
//! - [`address`] — solver `Address`/`Credential` → raw Cardano address bytes, and
//!   the reward account for the settlement stake credential `S`.
//! - [`value`] — solver `Value` → Conway ledger `Value` (coin + canonical multiasset).
//! - [`plan`] — the chain-independent settlement skeleton: the canonical output
//!   list (owners `[0,N)`, pool, remainders), the script spends (`Settle`/
//!   `PoolSettle`), the withdraw-0 account `S` + `SettlementRedeemer`, the POSIX
//!   validity bound, and [`plan::compute_redeemers`] (the `Spend`/`Reward` index
//!   assignment against the final, canonically-sorted input/withdrawal sets).
//!
//! What's left for the `chain` layer (it needs protocol params + a node): add the
//! solver's funding/collateral inputs and tip-change output, convert the POSIX
//! bound to a slot `ttl`, compute `script_data_hash` from the cost models, fill
//! ex-units via EvaluateTx, balance the fee, and sign. pallas-txbuilder can't help
//! — it has no withdrawal/reward-redeemer support, which is the anchor's mechanism.

pub mod address;
pub mod plan;
pub mod plutus;
pub mod value;
