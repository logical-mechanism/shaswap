//! A Cardano multi-asset `Value`, modelled to match `aiken/cardano/assets`
//! semantics exactly — because every settlement output is pinned by an *exact
//! value equality* in [`clearing.ak`](../../../contracts/lib/shaswap/clearing.ak)
//! (`bound.value == owner_val`, `rem.value == exp_value`,
//! `pool_out.value == pool_val_exp`). Any divergence here = a rejected settlement.
//!
//! Two properties of the on-chain representation we must reproduce:
//!
//! 1. **Normalized:** an asset with quantity `0` is not present. `assets.add(v, p,
//!    n, q)` that drives a quantity to `0` removes the entry, and value equality is
//!    over the normalized maps. We normalize on every mutation so `==` matches.
//! 2. **ADA is the `(policy="", name="")` asset.** `ada_policy_id` and
//!    `ada_asset_name` are both the empty byte string.
//!
//! Quantities are `i128`: every on-chain quantity fits in `i64`, intermediate
//! owner/pool deltas can go negative, and sums over a settlement's ≤~44 orders
//! stay far inside `i128`. The only place two large reserves are *multiplied* is
//! the pool `k`-check, which uses `BigInt` (see `curve.rs`).

use std::collections::BTreeMap;

/// A native-asset policy id: 28 bytes, or empty (`[]`) for ADA.
pub type PolicyId = Vec<u8>;
/// A native-asset name: 0..=32 bytes.
pub type AssetName = Vec<u8>;

/// ADA's policy id (the empty byte string), matching `assets.ada_policy_id`.
pub fn ada_policy_id() -> PolicyId {
    Vec::new()
}
/// ADA's asset name (the empty byte string), matching `assets.ada_asset_name`.
pub fn ada_asset_name() -> AssetName {
    Vec::new()
}

/// A normalized multi-asset value. `BTreeMap` gives a canonical ordering and
/// makes `==` a structural compare over the normalized contents.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Value {
    inner: BTreeMap<(PolicyId, AssetName), i128>,
}

impl Value {
    /// The empty value (`assets.zero`).
    pub fn zero() -> Self {
        Value {
            inner: BTreeMap::new(),
        }
    }

    /// `assets.from_lovelace(n)` — a value holding only ADA.
    pub fn from_lovelace(n: i128) -> Self {
        let mut v = Value::zero();
        v.add_mut(&ada_policy_id(), &ada_asset_name(), n);
        v
    }

    /// `assets.add(self, policy, name, delta)` — add a signed quantity, dropping
    /// the entry if it reaches zero (normalization). Returns a new value.
    pub fn add(&self, policy: &[u8], name: &[u8], delta: i128) -> Value {
        let mut out = self.clone();
        out.add_mut(policy, name, delta);
        out
    }

    /// In-place variant of [`Value::add`].
    pub fn add_mut(&mut self, policy: &[u8], name: &[u8], delta: i128) {
        if delta == 0 {
            return;
        }
        let key = (policy.to_vec(), name.to_vec());
        let entry = self.inner.entry(key.clone()).or_insert(0);
        *entry += delta;
        if *entry == 0 {
            self.inner.remove(&key);
        }
    }

    /// `assets.add` for ADA specifically (matches `clearing.ak::ada_add`).
    pub fn ada_add(&self, delta: i128) -> Value {
        self.add(&ada_policy_id(), &ada_asset_name(), delta)
    }

    /// `assets.quantity_of(self, policy, name)` — 0 if absent.
    pub fn quantity_of(&self, policy: &[u8], name: &[u8]) -> i128 {
        *self
            .inner
            .get(&(policy.to_vec(), name.to_vec()))
            .unwrap_or(&0)
    }

    /// `assets.lovelace_of(self)`.
    pub fn lovelace_of(&self) -> i128 {
        self.quantity_of(&ada_policy_id(), &ada_asset_name())
    }

    /// `assets.is_zero(self)` — no assets at all (normalized empty).
    pub fn is_zero(&self) -> bool {
        self.inner.is_empty()
    }

    /// True if this value holds nothing but ADA (no native assets). An empty value
    /// counts as ADA-only. Used to pick pure-ADA funding/collateral UTXOs.
    pub fn is_ada_only(&self) -> bool {
        self.inner
            .keys()
            .all(|(p, n)| p == &ada_policy_id() && n == &ada_asset_name())
    }

    /// Sum of two values (`assets.merge`), normalized. Used for conservation
    /// checks (Σ inputs vs Σ outputs).
    pub fn merge(&self, other: &Value) -> Value {
        let mut out = self.clone();
        for ((p, n), q) in &other.inner {
            out.add_mut(p, n, *q);
        }
        out
    }

    /// Iterate `(policy, name, quantity)` triples in canonical order
    /// (`assets.flatten`). All quantities are non-zero by normalization.
    pub fn flatten(&self) -> impl Iterator<Item = (&PolicyId, &AssetName, i128)> {
        self.inner.iter().map(|((p, n), q)| (p, n, *q))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_to_zero_removes_entry() {
        let v = Value::from_lovelace(5).add(&[], &[], -5);
        assert!(v.is_zero());
        assert_eq!(v, Value::zero());
    }

    #[test]
    fn normalized_equality_ignores_order_of_construction() {
        let tok = vec![0x33u8; 28];
        let a = Value::from_lovelace(10).add(&tok, b"T", 7);
        let b = Value::zero().add(&tok, b"T", 7).add(&[], &[], 10);
        assert_eq!(a, b);
    }

    #[test]
    fn lovelace_and_quantity_of() {
        let tok = vec![0x33u8; 28];
        let v = Value::from_lovelace(2_000_000).add(&tok, b"T", 1_000_000);
        assert_eq!(v.lovelace_of(), 2_000_000);
        assert_eq!(v.quantity_of(&tok, b"T"), 1_000_000);
        assert_eq!(v.quantity_of(&tok, b"X"), 0);
    }
}
