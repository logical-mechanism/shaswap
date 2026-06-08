//! Decode on-chain Plutus `Data` (CBOR) back into `solver-core` datum types — the
//! inverse of [`txbuild::plutus`]. The batcher needs this to read order and pool
//! UTXOs discovered on chain (via Kupo) into the domain types the solver reasons
//! about. Round-trip tested against the encoder so the two can't drift.

use pallas_primitives::{BigInt, PlutusData};
use solver_core::types::{
    AssetId, BoundDatum, Credential, LpIntentAction, LpIntentDatum, OrderDatum, OutputReference,
    PoolDatum, SettlementRedeemer,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    Cbor(String),
    /// A `Data` node wasn't the shape we expected (e.g. an int where a constr was).
    Shape(&'static str),
    /// A constructor index we don't recognize for the target type.
    BadConstructor {
        ty: &'static str,
        index: u64,
    },
    /// Wrong number of fields for a constructor.
    Arity {
        ty: &'static str,
        got: usize,
    },
    IntRange,
}

/// Parse raw CBOR into a pallas `PlutusData`.
pub fn from_cbor(bytes: &[u8]) -> Result<PlutusData, DecodeError> {
    pallas_codec::minicbor::decode(bytes).map_err(|e| DecodeError::Cbor(e.to_string()))
}

/// The constructor index (0-based) and field slice of a `Constr` node. Maps the
/// CBOR tag back to the index: `121..=127` → `0..=6`, `1280..` → `7..`, `102` uses
/// the explicit `any_constructor`.
fn constr<'a>(d: &'a PlutusData, ty: &'static str) -> Result<(u64, &'a [PlutusData]), DecodeError> {
    match d {
        PlutusData::Constr(c) => {
            let index = match (c.tag, c.any_constructor) {
                (102, Some(i)) => i,
                (t, _) if (121..=127).contains(&t) => t - 121,
                (t, _) if (1280..=1400).contains(&t) => t - 1280 + 7,
                _ => return Err(DecodeError::Shape("constr tag")),
            };
            Ok((index, c.fields.as_slice()))
        }
        _ => {
            let _ = ty;
            Err(DecodeError::Shape("expected constr"))
        }
    }
}

fn fields_n<'a>(
    d: &'a PlutusData,
    ty: &'static str,
    want_index: u64,
    want_arity: usize,
) -> Result<&'a [PlutusData], DecodeError> {
    let (index, fields) = constr(d, ty)?;
    if index != want_index {
        return Err(DecodeError::BadConstructor { ty, index });
    }
    if fields.len() != want_arity {
        return Err(DecodeError::Arity {
            ty,
            got: fields.len(),
        });
    }
    Ok(fields)
}

fn as_bytes(d: &PlutusData) -> Result<Vec<u8>, DecodeError> {
    match d {
        PlutusData::BoundedBytes(b) => Ok(b.to_vec()),
        _ => Err(DecodeError::Shape("expected bytes")),
    }
}

fn as_int(d: &PlutusData) -> Result<i128, DecodeError> {
    match d {
        PlutusData::BigInt(BigInt::Int(i)) => Ok(i128::from(*i)),
        PlutusData::BigInt(BigInt::BigUInt(b)) => be_to_i128(b, false),
        PlutusData::BigInt(BigInt::BigNInt(b)) => be_to_i128(b, true),
        _ => Err(DecodeError::Shape("expected int")),
    }
}

fn be_to_i128(bytes: &[u8], neg: bool) -> Result<i128, DecodeError> {
    if bytes.len() > 16 {
        return Err(DecodeError::IntRange);
    }
    let mut acc: i128 = 0;
    for &b in bytes {
        acc = acc.checked_shl(8).ok_or(DecodeError::IntRange)? | b as i128;
    }
    // CBOR negative bignum encodes -1 - value.
    Ok(if neg { -1 - acc } else { acc })
}

fn as_bool(d: &PlutusData) -> Result<bool, DecodeError> {
    let (index, _) = constr(d, "Bool")?;
    match index {
        0 => Ok(false),
        1 => Ok(true),
        i => Err(DecodeError::BadConstructor {
            ty: "Bool",
            index: i,
        }),
    }
}

fn as_option_int(d: &PlutusData) -> Result<Option<i64>, DecodeError> {
    let (index, fields) = constr(d, "Option")?;
    match index {
        1 => Ok(None),
        0 => {
            let v = as_int(fields.first().ok_or(DecodeError::Arity {
                ty: "Option",
                got: 0,
            })?)?;
            Ok(Some(i64::try_from(v).map_err(|_| DecodeError::IntRange)?))
        }
        i => Err(DecodeError::BadConstructor {
            ty: "Option",
            index: i,
        }),
    }
}

fn as_option_credential(d: &PlutusData) -> Result<Option<Credential>, DecodeError> {
    let (index, fields) = constr(d, "Option")?;
    match index {
        1 => Ok(None),
        0 => Ok(Some(credential(fields.first().ok_or(
            DecodeError::Arity {
                ty: "Option",
                got: 0,
            },
        )?)?)),
        i => Err(DecodeError::BadConstructor {
            ty: "Option",
            index: i,
        }),
    }
}

pub fn asset_id(d: &PlutusData) -> Result<AssetId, DecodeError> {
    let f = fields_n(d, "AssetId", 0, 2)?;
    Ok(AssetId::new(as_bytes(&f[0])?, as_bytes(&f[1])?))
}

pub fn credential(d: &PlutusData) -> Result<Credential, DecodeError> {
    let (index, fields) = constr(d, "Credential")?;
    let hash = as_bytes(fields.first().ok_or(DecodeError::Arity {
        ty: "Credential",
        got: 0,
    })?)?;
    match index {
        0 => Ok(Credential::VerificationKey(hash)),
        1 => Ok(Credential::Script(hash)),
        i => Err(DecodeError::BadConstructor {
            ty: "Credential",
            index: i,
        }),
    }
}

pub fn output_reference(d: &PlutusData) -> Result<OutputReference, DecodeError> {
    let f = fields_n(d, "OutputReference", 0, 2)?;
    Ok(OutputReference {
        transaction_id: as_bytes(&f[0])?,
        output_index: u64::try_from(as_int(&f[1])?).map_err(|_| DecodeError::IntRange)?,
    })
}

pub fn order_datum(d: &PlutusData) -> Result<OrderDatum, DecodeError> {
    let f = fields_n(d, "OrderDatum", 0, 9)?;
    Ok(OrderDatum {
        owner: credential(&f[0])?,
        owner_stake: as_option_credential(&f[1])?,
        pool_nft: asset_id(&f[2])?,
        sell_a: as_bool(&f[3])?,
        sell_amount: as_int(&f[4])?,
        limit: as_int(&f[5])?,
        tip: as_int(&f[6])?,
        partial: as_bool(&f[7])?,
        deadline: as_option_int(&f[8])?,
    })
}

pub fn pool_datum(d: &PlutusData) -> Result<PoolDatum, DecodeError> {
    let f = fields_n(d, "PoolDatum", 0, 6)?;
    Ok(PoolDatum {
        nft: asset_id(&f[0])?,
        asset_a: asset_id(&f[1])?,
        asset_b: asset_id(&f[2])?,
        fee_num: as_int(&f[3])?,
        fee_den: as_int(&f[4])?,
        creator: credential(&f[5])?,
    })
}

pub fn bound_datum(d: &PlutusData) -> Result<BoundDatum, DecodeError> {
    let f = fields_n(d, "BoundDatum", 0, 1)?;
    Ok(BoundDatum {
        order_ref: output_reference(&f[0])?,
    })
}

fn lp_intent_action(d: &PlutusData) -> Result<LpIntentAction, DecodeError> {
    let (index, _) = constr(d, "LpIntentAction")?;
    match index {
        0 => Ok(LpIntentAction::LpDeposit),
        1 => Ok(LpIntentAction::LpWithdraw),
        i => Err(DecodeError::BadConstructor {
            ty: "LpIntentAction",
            index: i,
        }),
    }
}

pub fn lp_intent_datum(d: &PlutusData) -> Result<LpIntentDatum, DecodeError> {
    let f = fields_n(d, "LpIntentDatum", 0, 9)?;
    Ok(LpIntentDatum {
        owner: credential(&f[0])?,
        owner_stake: as_option_credential(&f[1])?,
        pool_nft: asset_id(&f[2])?,
        action: lp_intent_action(&f[3])?,
        min_a: as_int(&f[4])?,
        min_b: as_int(&f[5])?,
        min_shares: as_int(&f[6])?,
        tip: as_int(&f[7])?,
        deadline: as_option_int(&f[8])?,
    })
}

/// Convenience: decode an LP-intent datum directly from inline-datum CBOR bytes.
pub fn lp_intent_datum_cbor(bytes: &[u8]) -> Result<LpIntentDatum, DecodeError> {
    lp_intent_datum(&from_cbor(bytes)?)
}

pub fn settlement_redeemer(d: &PlutusData) -> Result<SettlementRedeemer, DecodeError> {
    let f = fields_n(d, "SettlementRedeemer", 0, 6)?;
    let fills = match &f[5] {
        PlutusData::Array(a) => a.iter().map(as_int).collect::<Result<Vec<_>, _>>()?,
        _ => return Err(DecodeError::Shape("fills must be an array")),
    };
    Ok(SettlementRedeemer {
        price_num: as_int(&f[0])?,
        price_den: as_int(&f[1])?,
        asset_a: asset_id(&f[2])?,
        asset_b: asset_id(&f[3])?,
        pool_nft: asset_id(&f[4])?,
        fills,
    })
}

/// Convenience: decode an order datum directly from inline-datum CBOR bytes.
pub fn order_datum_cbor(bytes: &[u8]) -> Result<OrderDatum, DecodeError> {
    order_datum(&from_cbor(bytes)?)
}

/// Convenience: decode a pool datum directly from inline-datum CBOR bytes.
pub fn pool_datum_cbor(bytes: &[u8]) -> Result<PoolDatum, DecodeError> {
    pool_datum(&from_cbor(bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use txbuild::plutus;

    fn order() -> OrderDatum {
        OrderDatum {
            owner: Credential::VerificationKey(vec![0xb1; 28]),
            owner_stake: Some(Credential::Script(vec![0xe2; 28])),
            pool_nft: AssetId::new(vec![0x44; 28], vec![0x4e, 0x46, 0x54]),
            sell_a: true,
            sell_amount: 1_000_000,
            limit: 400_000,
            tip: 2_000_000,
            partial: true,
            deadline: Some(1700000000000),
        }
    }

    fn pool() -> PoolDatum {
        PoolDatum {
            nft: AssetId::new(vec![0x44; 28], vec![0x4e, 0x46, 0x54]),
            asset_a: AssetId::new(vec![0x33; 28], vec![0x54]),
            asset_b: AssetId::ada(),
            fee_num: 3,
            fee_den: 1000,
            creator: Credential::Script(vec![0x99; 28]),
        }
    }

    fn lp_intent(action: LpIntentAction) -> LpIntentDatum {
        LpIntentDatum {
            owner: Credential::VerificationKey(vec![0xb1; 28]),
            owner_stake: Some(Credential::VerificationKey(vec![0xe1; 28])),
            pool_nft: AssetId::new(vec![0x44; 28], vec![0x4e, 0x46, 0x54]),
            action,
            min_a: 19_000_000,
            min_b: 9_000_000,
            min_shares: 90_000,
            tip: 1_000_000,
            deadline: Some(1700000000000),
        }
    }

    #[test]
    fn order_datum_round_trips() {
        let o = order();
        let cbor = plutus::to_cbor(&plutus::order_datum(&o));
        assert_eq!(order_datum_cbor(&cbor).unwrap(), o);
    }

    #[test]
    fn decoder_never_panics_on_malformed_input() {
        // The order/pool/lp_intent addresses are PUBLIC — anyone can park junk there, and
        // `try_order`/`try_pool`/`try_lp_intent` rely on a malformed datum becoming an
        // Err (→ skip the UTXO), NEVER a panic that would crash the daemon. Exhaustive
        // adversarial battery: empties, garbage, every truncation, and every single-byte
        // corruption of a valid datum. NB: the decoder is structural — it rejects bad CBOR
        // SHAPE, not degenerate field *values* (e.g. sell_amount<1); those are the on-chain
        // validator's job, so we don't assert the decoder rejects them.
        let valid = plutus::to_cbor(&plutus::order_datum(&order()));

        // Obvious structural junk MUST be an explicit error (not just non-panicking).
        for bad in [&b""[..], &[0x00][..], &[0xff][..], b"not cbor at all"] {
            assert!(
                order_datum_cbor(bad).is_err(),
                "garbage must be DecodeError"
            );
            assert!(pool_datum_cbor(bad).is_err());
            assert!(lp_intent_datum_cbor(bad).is_err());
        }

        // Build the corruption battery: every prefix (truncation) + every byte flipped.
        let mut battery: Vec<Vec<u8>> = (0..=valid.len()).map(|n| valid[..n].to_vec()).collect();
        for i in 0..valid.len() {
            let mut m = valid.clone();
            m[i] ^= 0xff;
            battery.push(m);
        }
        // The invariant under test: each decoder RETURNS (Ok or Err) for every input — a
        // panic here fails the test, which is exactly the regression we guard against.
        for bytes in &battery {
            let _ = order_datum_cbor(bytes);
            let _ = pool_datum_cbor(bytes);
            let _ = lp_intent_datum_cbor(bytes);
        }
        // sanity: the unmodified datum still decodes (the battery didn't trivially pass
        // because everything errored).
        assert!(order_datum_cbor(&valid).is_ok());
    }

    #[test]
    fn lp_intent_datum_round_trips() {
        for action in [LpIntentAction::LpDeposit, LpIntentAction::LpWithdraw] {
            let d = lp_intent(action);
            let cbor = plutus::to_cbor(&plutus::lp_intent_datum(&d));
            assert_eq!(lp_intent_datum_cbor(&cbor).unwrap(), d);
        }
    }

    #[test]
    fn lp_intent_enterprise_owner_stake_round_trips() {
        let d = LpIntentDatum {
            owner_stake: None,
            ..lp_intent(LpIntentAction::LpWithdraw)
        };
        let cbor = plutus::to_cbor(&plutus::lp_intent_datum(&d));
        assert_eq!(lp_intent_datum_cbor(&cbor).unwrap(), d);
    }

    #[test]
    fn pool_datum_round_trips() {
        let p = pool();
        let cbor = plutus::to_cbor(&plutus::pool_datum(&p));
        assert_eq!(pool_datum_cbor(&cbor).unwrap(), p);
    }

    #[test]
    fn bound_and_redeemer_round_trip() {
        let b = BoundDatum {
            order_ref: OutputReference {
                transaction_id: vec![0xa1; 32],
                output_index: 7,
            },
        };
        let cbor = plutus::to_cbor(&plutus::bound_datum(&b));
        assert_eq!(bound_datum(&from_cbor(&cbor).unwrap()).unwrap(), b);

        let r = SettlementRedeemer {
            price_num: 1,
            price_den: 2,
            asset_a: AssetId::new(vec![0x33; 28], vec![0x54]),
            asset_b: AssetId::ada(),
            pool_nft: AssetId::new(vec![0x44; 28], vec![0x4e, 0x46, 0x54]),
            fills: vec![1_000_000, 500_000],
        };
        let cbor = plutus::to_cbor(&plutus::settlement_redeemer(&r));
        assert_eq!(settlement_redeemer(&from_cbor(&cbor).unwrap()).unwrap(), r);
    }

    #[test]
    fn empty_fills_round_trip() {
        let r = SettlementRedeemer {
            price_num: 3,
            price_den: 1,
            asset_a: AssetId::new(vec![0x33; 28], vec![0x54]),
            asset_b: AssetId::new(vec![0x88; 28], vec![0x42]),
            pool_nft: AssetId::new(vec![0x44; 28], vec![0x4e, 0x46, 0x54]),
            fills: vec![],
        };
        let cbor = plutus::to_cbor(&plutus::settlement_redeemer(&r));
        assert_eq!(settlement_redeemer(&from_cbor(&cbor).unwrap()).unwrap(), r);
    }

    #[test]
    fn rejects_wrong_shape() {
        // a bare int is not an OrderDatum.
        let cbor = plutus::to_cbor(&plutus::settlement_redeemer(&SettlementRedeemer {
            price_num: 1,
            price_den: 1,
            asset_a: AssetId::ada(),
            asset_b: AssetId::new(vec![0x33; 28], vec![0x54]),
            pool_nft: AssetId::new(vec![0x44; 28], vec![0x4e, 0x46, 0x54]),
            fills: vec![],
        }));
        // decoding a 6-field SettlementRedeemer as a 9-field OrderDatum must fail.
        assert!(matches!(
            order_datum_cbor(&cbor),
            Err(DecodeError::Arity { .. })
        ));
    }
}
