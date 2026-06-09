//! # chain
//!
//! Chain access for the ShaSwap reference solver, behind the [`ChainBackend`]
//! abstraction so the provider is swappable (Kupo + Ogmios now; a local node like
//! Dolos later — the data-access rule from `CLAUDE.md`).
//!
//! Node-independent, fully-tested today:
//! - [`backend`] — the `ChainBackend` trait + its data types (tip, params, eval).
//! - [`config`] — the typed, fail-fast [`Config`](config::Config); `validate()`
//!   parses + length-checks the deployment identities (script hashes, refs). Pool
//!   discovery is dynamic, so the config has no per-pool/per-token fields.
//! - [`decode`] — on-chain Plutus `Data` → `solver-core` datums, the inverse of
//!   `txbuild::plutus`, round-trip tested so the two never diverge.
//!
//! Still to wire (needs a live preprod node): the Kupo/Ogmios HTTP impls of
//! `ChainBackend` (discovery by stake-cred `S` / pool NFT, params, the EvaluateTx
//! pre-submit gate, submit) and the final body stitch (fee, collateral,
//! `script_data_hash`, ex-units, sign).

pub mod assemble;
pub mod backend;
pub mod config;
pub mod decode;
pub mod fees;
pub mod fulfill;
pub mod kupo_ogmios;
