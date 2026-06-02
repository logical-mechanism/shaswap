//! On-chain datum/redeemer shapes and protocol constants, mirrored from
//! `contracts/lib/shaswap/{types,constants}.ak`. These are the *logical* shapes
//! the solver reasons about; CBOR (de)serialization for real chain data lives in
//! the (future) `chain`/`txbuild` crates, kept separate so this crate stays pure.

use crate::value::{AssetName, PolicyId, Value};

// ---- constants.ak (MUST equal the on-chain constants — drift = rejected tx) ----

/// `constants.total_lp` — full LP supply minted into the pool at creation.
pub const TOTAL_LP: i128 = 9_223_372_036_854_775_807; // i64::MAX
/// `constants.min_liq` — permanently-locked minimum liquidity (Uniswap-v2 style).
pub const MIN_LIQ: i128 = 1_000;
/// `constants.pool_min_ada` — min-ADA carved out of an ADA pool reserve.
pub const POOL_MIN_ADA: i128 = 2_000_000;
/// `constants.order_min_ada` — per-UTXO min-ADA for an order/remainder output.
pub const ORDER_MIN_ADA: i128 = 2_000_000;
/// `constants.lp_name` — `"LP"`.
pub const LP_NAME: &[u8] = &[0x4c, 0x50];
/// `constants.nft_name` — `"NFT"`.
pub const NFT_NAME: &[u8] = &[0x4e, 0x46, 0x54];

// ---- types.ak ---------------------------------------------------------------

/// A `(policy, name)` native-asset identifier (`types.AssetId`). ADA is the
/// `(empty, empty)` asset.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AssetId {
    pub policy: PolicyId,
    pub name: AssetName,
}

impl AssetId {
    pub fn new(policy: impl Into<Vec<u8>>, name: impl Into<Vec<u8>>) -> Self {
        AssetId {
            policy: policy.into(),
            name: name.into(),
        }
    }

    /// ADA, the `(empty, empty)` asset.
    pub fn ada() -> Self {
        AssetId::new(Vec::new(), Vec::new())
    }

    pub fn is_ada(&self) -> bool {
        self.policy.is_empty() && self.name.is_empty()
    }

    /// `utils.asset_qty(v, self)`.
    pub fn qty_in(&self, v: &Value) -> i128 {
        v.quantity_of(&self.policy, &self.name)
    }
}

/// A spending credential (`cardano/address.Credential`).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Credential {
    /// Payment by key signature (28-byte key hash). Order owners MUST be this
    /// variant to keep §5.1 reclaim working (a `Script` owner can settle but
    /// never reclaim — see `clearing_test.reclaim_script_owner`).
    VerificationKey(Vec<u8>),
    /// Payment governed by a script (28-byte script hash).
    Script(Vec<u8>),
}

/// A UTXO reference (`cardano/transaction.OutputReference`).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OutputReference {
    pub transaction_id: Vec<u8>,
    pub output_index: u64,
}

/// `types.OrderDatum` — a trade intent against one pool's `(asset_a, asset_b)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderDatum {
    pub owner: Credential,
    /// The owner's chosen stake credential for the settled-funds payout. `Some(c)`
    /// → a base address (so delegating/Lace-style wallets show + spend it), `None`
    /// → an enterprise address. Read FROM this datum, so the solver can't redirect
    /// the payout — the address stays fully pinned (audit M-01 preserved).
    pub owner_stake: Option<Credential>,
    pub pool_nft: AssetId,
    /// `True` sells `asset_a` for `asset_b`; `False` sells `asset_b` for `asset_a`.
    pub sell_a: bool,
    pub sell_amount: i128,
    /// Minimum amount of the *bought* asset — the per-order floor (§5.2.5).
    pub limit: i128,
    pub tip: i128,
    pub partial: bool,
    /// Optional settlement deadline (POSIX ms).
    pub deadline: Option<i64>,
}

/// `types.PoolDatum` — pool identity + traded pair + static fee. Reserves are
/// read from the UTXO value; `k` is never stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolDatum {
    pub nft: AssetId,
    pub asset_a: AssetId,
    pub asset_b: AssetId,
    pub fee_num: i128,
    pub fee_den: i128,
    pub creator: Credential,
}

/// `types.BoundDatum` — the injective binding key on each owner output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundDatum {
    pub order_ref: OutputReference,
}

/// `types.SettlementRedeemer` — the solver's witness (withdraw-0 redeemer).
/// `price = price_num / price_den` is `asset_b` per unit of `asset_a`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementRedeemer {
    pub price_num: i128,
    pub price_den: i128,
    pub asset_a: AssetId,
    pub asset_b: AssetId,
    pub pool_nft: AssetId,
    /// Per-order fill, in canonical input order; `fills[i] == sell_amount[i]` is
    /// a full fill, `< sell_amount[i]` a partial (requires `partial == True`).
    pub fills: Vec<i128>,
}
