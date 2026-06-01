//! # txbuild
//!
//! Lowers a `solver-core` [`Settlement`](solver_core::clearing::Settlement) into a
//! Plutus-v3 (Conway) Cardano transaction the ShaSwap validators accept.
//!
//! Layered so the parts that need no chain access are testable on their own:
//! - [`plutus`] — Plutus `Data` encoding of every datum/redeemer (matches
//!   `contracts/plutus.json` exactly). Fully unit-tested offline.
//! - `tx` (next) — assemble the transaction body: owner outputs first in canonical
//!   input order with `BoundDatum`, the NFT pool output, remainders, the solver
//!   tip/change output; order inputs `Settle`, pool input `PoolSettle`, withdraw-0
//!   for `S` with the `SettlementRedeemer`; `mint == 0`; validity upper bound for
//!   deadlines. Balancing fees/collateral + the EvaluateTx gate live in `chain`.

pub mod plutus;
