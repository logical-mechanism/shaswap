//! Plutus `Data` encoding of the ShaSwap datums/redeemers, matching the Aiken
//! schema in `contracts/plutus.json` exactly. Constructor indices and field order
//! are the make-or-break detail: a wrong tag or reordered field decodes to a
//! different value and the validator rejects.
//!
//! Mapping (confirmed against `plutus.json`):
//! - `AssetId` → `Constr 0 [policy, name]`
//! - `Credential` → `VerificationKey` = `Constr 0 [hash]`, `Script` = `Constr 1 [hash]`
//! - `OutputReference` → `Constr 0 [tx_id, index]` (Plutus v3: tx_id is plain bytes)
//! - `OrderDatum` → `Constr 0 [owner, owner_stake, pool_nft, sell_a, sell_amount, limit, tip, partial, deadline]`
//! - `PoolDatum` → `Constr 0 [nft, asset_a, asset_b, fee_num, fee_den, creator]`
//! - `BoundDatum` → `Constr 0 [order_ref]`
//! - `SettlementRedeemer` → `Constr 0 [price_num, price_den, asset_a, asset_b, pool_nft, fills]`
//! - `OrderRedeemer` → `Settle` = `Constr 0 []`, `Reclaim` = `Constr 1 []`
//! - `PoolRedeemer` → `PoolSettle` = `Constr 0 []`, `LpAction` = `Constr 1 []`, `ClosePool` = `Constr 2 []`
//! - `Bool` → `False` = `Constr 0 []`, `True` = `Constr 1 []`
//! - `Option` → `Some(x)` = `Constr 0 [x]`, `None` = `Constr 1 []`

use pallas_codec::utils::{Int, MaybeIndefArray};
use pallas_primitives::{BigInt, Constr, PlutusData};
use solver_core::output::Datum;
use solver_core::types::{
    AssetId, BoundDatum, Credential, OrderDatum, OutputReference, PoolDatum, SettlementRedeemer,
};

/// Build a constructor `Data`. Nonempty fields use an indefinite-length array and
/// empty fields a definite empty array — the canonical Plutus form. Only indices
/// `< 7` occur here (max constructor is 2), so the `121 + i` tag path always applies.
fn constr(index: u64, fields: Vec<PlutusData>) -> PlutusData {
    debug_assert!(index < 7, "all ShaSwap constructors are index < 7");
    let arr = if fields.is_empty() {
        MaybeIndefArray::Def(fields)
    } else {
        MaybeIndefArray::Indef(fields)
    };
    PlutusData::Constr(Constr {
        tag: 121 + index,
        any_constructor: None,
        fields: arr,
    })
}

/// Encode a (non-negative on-chain) integer. Values within `i128`'s CBOR-int range
/// use a plain int; anything larger falls back to a bignum (won't occur for v1
/// datum fields, which are all `≤ i64::MAX`, but kept correct and panic-free).
fn int(n: i128) -> PlutusData {
    match Int::try_from(n) {
        Ok(i) => PlutusData::BigInt(BigInt::Int(i)),
        Err(_) => {
            // CBOR bignum: tag 2 (pos) / tag 3 (neg, magnitude is -1-n).
            if n >= 0 {
                let mag = trim(n.unsigned_abs().to_be_bytes());
                PlutusData::BigInt(BigInt::BigUInt(mag.into()))
            } else {
                let mag = trim((n.unsigned_abs() - 1).to_be_bytes());
                PlutusData::BigInt(BigInt::BigNInt(mag.into()))
            }
        }
    }
}

fn trim(bytes: [u8; 16]) -> Vec<u8> {
    let v: Vec<u8> = bytes.into_iter().skip_while(|b| *b == 0).collect();
    if v.is_empty() {
        vec![0]
    } else {
        v
    }
}

fn bytes(b: &[u8]) -> PlutusData {
    PlutusData::BoundedBytes(b.to_vec().into())
}

fn bool_data(b: bool) -> PlutusData {
    constr(if b { 1 } else { 0 }, vec![])
}

fn option_int(o: Option<i64>) -> PlutusData {
    match o {
        Some(x) => constr(0, vec![int(x as i128)]),
        None => constr(1, vec![]),
    }
}

fn option_credential(o: &Option<Credential>) -> PlutusData {
    match o {
        Some(c) => constr(0, vec![credential(c)]),
        None => constr(1, vec![]),
    }
}

pub fn asset_id(a: &AssetId) -> PlutusData {
    constr(0, vec![bytes(&a.policy), bytes(&a.name)])
}

pub fn credential(c: &Credential) -> PlutusData {
    match c {
        Credential::VerificationKey(h) => constr(0, vec![bytes(h)]),
        Credential::Script(h) => constr(1, vec![bytes(h)]),
    }
}

pub fn output_reference(r: &OutputReference) -> PlutusData {
    constr(
        0,
        vec![bytes(&r.transaction_id), int(r.output_index as i128)],
    )
}

pub fn order_datum(d: &OrderDatum) -> PlutusData {
    constr(
        0,
        vec![
            credential(&d.owner),
            option_credential(&d.owner_stake),
            asset_id(&d.pool_nft),
            bool_data(d.sell_a),
            int(d.sell_amount),
            int(d.limit),
            int(d.tip),
            bool_data(d.partial),
            option_int(d.deadline),
        ],
    )
}

pub fn pool_datum(d: &PoolDatum) -> PlutusData {
    constr(
        0,
        vec![
            asset_id(&d.nft),
            asset_id(&d.asset_a),
            asset_id(&d.asset_b),
            int(d.fee_num),
            int(d.fee_den),
            credential(&d.creator),
        ],
    )
}

pub fn bound_datum(d: &BoundDatum) -> PlutusData {
    constr(0, vec![output_reference(&d.order_ref)])
}

pub fn settlement_redeemer(r: &SettlementRedeemer) -> PlutusData {
    let fills = if r.fills.is_empty() {
        MaybeIndefArray::Def(vec![])
    } else {
        MaybeIndefArray::Indef(r.fills.iter().map(|f| int(*f)).collect())
    };
    constr(
        0,
        vec![
            int(r.price_num),
            int(r.price_den),
            asset_id(&r.asset_a),
            asset_id(&r.asset_b),
            asset_id(&r.pool_nft),
            PlutusData::Array(fills),
        ],
    )
}

/// `OrderRedeemer::Settle`.
pub fn order_settle() -> PlutusData {
    constr(0, vec![])
}

/// `PoolRedeemer::PoolSettle`.
pub fn pool_settle() -> PlutusData {
    constr(0, vec![])
}

/// Encode an output's typed [`Datum`] into Plutus `Data` (for an inline datum).
pub fn datum(d: &Datum) -> Option<PlutusData> {
    match d {
        Datum::None => None,
        Datum::Order(o) => Some(order_datum(o)),
        Datum::Pool(p) => Some(pool_datum(p)),
        Datum::Bound(b) => Some(bound_datum(b)),
    }
}

/// Serialize a `Data` to its canonical CBOR bytes.
pub fn to_cbor(d: &PlutusData) -> Vec<u8> {
    pallas_codec::minicbor::to_vec(d).expect("PlutusData encoding is infallible")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn nullary_redeemers_match_known_cbor() {
        // Constr 0 [] = tag 121 (0xd879) + empty def array (0x80).
        assert_eq!(hex(&to_cbor(&order_settle())), "d87980");
        assert_eq!(hex(&to_cbor(&pool_settle())), "d87980");
        // Constr 1 [] = tag 122 (0xd87a) + 0x80.
        assert_eq!(hex(&to_cbor(&constr(1, vec![]))), "d87a80");
        // Constr 2 [] = tag 123 (0xd87b) + 0x80.
        assert_eq!(hex(&to_cbor(&constr(2, vec![]))), "d87b80");
    }

    #[test]
    fn ada_asset_id_cbor() {
        // Constr 0 [h'', h''] = d8799f 40 40 ff.
        assert_eq!(hex(&to_cbor(&asset_id(&AssetId::ada()))), "d8799f4040ff");
    }

    #[test]
    fn small_int_is_major0() {
        // 5 -> 0x05; 0 -> 0x00.
        assert_eq!(hex(&to_cbor(&int(5))), "05");
        assert_eq!(hex(&to_cbor(&int(0))), "00");
        // 1_000_000 -> 0x1a000f4240.
        assert_eq!(hex(&to_cbor(&int(1_000_000))), "1a000f4240");
    }

    #[test]
    fn round_trips_through_decode() {
        // any Data we encode must decode back to an equal Data (sanity on structure).
        use pallas_codec::minicbor;
        let d = order_datum(&OrderDatum {
            owner: Credential::VerificationKey(vec![0xab; 28]),
            owner_stake: Some(Credential::VerificationKey(vec![0xe1; 28])),
            pool_nft: AssetId::new(vec![0x44; 28], vec![0x4e, 0x46, 0x54]),
            sell_a: true,
            sell_amount: 1_000_000,
            limit: 400_000,
            tip: 2_000_000,
            partial: false,
            deadline: Some(1000),
        });
        let cbor = to_cbor(&d);
        let back: PlutusData = minicbor::decode(&cbor).expect("decodes");
        assert_eq!(d, back);
    }

    #[test]
    fn bound_datum_structure() {
        // Constr 0 [ Constr 0 [ bytes32, int ] ].
        let d = bound_datum(&BoundDatum {
            order_ref: OutputReference {
                transaction_id: vec![0xa1; 32],
                output_index: 0,
            },
        });
        let cbor = to_cbor(&d);
        // outer tag 121 + indef; inner tag 121 + indef; 32-byte string (0x5820..).
        assert!(hex(&cbor).starts_with("d8799fd8799f5820a1a1"));
    }
}
