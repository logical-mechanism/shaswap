//! # solver-core
//!
//! The pure, IO-free core of the ShaSwap reference solver. It mirrors the on-chain
//! settlement arithmetic in `contracts/lib/shaswap/{clearing,spend,constants}.ak`
//! exactly, so a settlement it builds is one the validators accept *to the
//! lovelace*. Everything here is deterministic and unit/property tested in
//! isolation — no chain access, no Pallas, no node.
//!
//! Pipeline:
//! - [`value`] / [`types`] / [`output`] — the ledger value + datum/redeemer shapes.
//! - [`curve`] — the pool curve (`reserve_of`, `k`-with-fee, forward swap).
//! - [`clearing`] — the settlement **pin generator** (port of `clearing.ak::run`).
//! - [`solve`] — the v1 floor-only clearing algorithm (valid, not yet optimal).
//! - [`sim`] — a synthetic order-book harness measuring netting rate + surplus.

pub mod clearing;
pub mod curve;
pub mod lp;
pub mod output;
pub mod sim;
pub mod solve;
pub mod types;
pub mod value;
