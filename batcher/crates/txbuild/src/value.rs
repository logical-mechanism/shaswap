//! Lower a `solver-core` [`Value`] into a Conway ledger `Value` (a `Coin` plus a
//! canonical `Multiasset` of positive quantities). Output values pinned by the
//! anchor are always non-negative, so any negative/zero asset here is a bug and is
//! surfaced as an error rather than silently dropped.

use pallas_codec::utils::PositiveCoin;
use pallas_crypto::hash::Hash;
use pallas_primitives::conway::Value as ConwayValue;
use pallas_primitives::{AssetName, PolicyId};
use solver_core::value::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValueError {
    BadPolicyLength(usize),
    NonPositiveAsset(i128),
    NegativeLovelace(i128),
}

fn policy(bytes: &[u8]) -> Result<PolicyId, ValueError> {
    let arr: [u8; 28] = bytes
        .try_into()
        .map_err(|_| ValueError::BadPolicyLength(bytes.len()))?;
    Ok(Hash::from(arr))
}

/// Lower to a Conway `Value`. ADA (the empty-policy asset) becomes the `Coin`; every
/// native asset becomes a `Multiasset` entry (canonically ordered by `BTreeMap`).
pub fn lower(v: &Value) -> Result<ConwayValue, ValueError> {
    let lovelace = v.lovelace_of();
    if lovelace < 0 {
        return Err(ValueError::NegativeLovelace(lovelace));
    }
    let coin = lovelace as u64;

    let mut ma: BTreeMap<PolicyId, BTreeMap<AssetName, PositiveCoin>> = BTreeMap::new();
    for (p, n, q) in v.flatten() {
        if p.is_empty() && n.is_empty() {
            continue; // ADA, already the coin
        }
        if q <= 0 {
            return Err(ValueError::NonPositiveAsset(q));
        }
        let pc = PositiveCoin::try_from(q as u64).map_err(|_| ValueError::NonPositiveAsset(q))?;
        ma.entry(policy(p)?)
            .or_default()
            .insert(AssetName::from(n.to_vec()), pc);
    }

    if ma.is_empty() {
        Ok(ConwayValue::Coin(coin))
    } else {
        Ok(ConwayValue::Multiasset(coin, ma))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solver_core::value::Value;

    #[test]
    fn ada_only_is_coin() {
        let v = Value::from_lovelace(2_500_000);
        assert!(matches!(lower(&v).unwrap(), ConwayValue::Coin(2_500_000)));
    }

    #[test]
    fn token_value_is_multiasset() {
        let tok = vec![0x33u8; 28];
        let v = Value::from_lovelace(2_000_000).add(&tok, b"T", 1_000_000);
        match lower(&v).unwrap() {
            ConwayValue::Multiasset(c, ma) => {
                assert_eq!(c, 2_000_000);
                let names = ma.values().next().unwrap();
                assert_eq!(u64::from(*names.values().next().unwrap()), 1_000_000);
            }
            _ => panic!("expected multiasset"),
        }
    }

    #[test]
    fn negative_asset_errors() {
        let tok = vec![0x33u8; 28];
        // a value with a negative token quantity must not silently lower.
        let v = Value::zero().add(&tok, b"T", -5);
        assert_eq!(lower(&v), Err(ValueError::NonPositiveAsset(-5)));
    }
}
