//// ShaSwap on-chain datum/redeemer encodings (BLUEPRINT §5.1/§5.2/§5.4).
////
//// Trust-anchor wiring (Rev 6 §5.4): order/pool UTXOs are tagged with the
//// settlement staking credential `S` as their stake credential; the settlement
//// validator is unparameterised and enumerates its input set by `S`.
////
//// `OrderDatum` (8 fields) and `PoolDatum` (6 fields) are intentionally distinct
//// shapes so a well-formed order can NEVER be parsed as the pool — this is what
//// makes the order-spend deferral safe against a solver relabelling an order as
//// "the pool" to skip its checks (§5.4 role-identification).
////
//// Pairs are general **`asset_a`/`asset_b`** (Rev 10): either side may be ADA
//// (the `policy == ""` asset) or any native token, so token/token pools are
//// first-class. ADA's per-UTXO min-ADA is carved out of whichever reserve is ADA
//// (pure overhead when neither is), keeping the §5.2.1 three roles separate.

use cardano/address.{Credential}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{OutputReference}

/// A (policy, name) pair identifying a native asset.
pub type AssetId {
  policy: PolicyId,
  name: AssetName,
}

/// Order UTXO datum — the intent (§5.1). Bidirectional against one pool whose
/// pair is `(asset_a, asset_b)`: `sell_a = True` sells `sell_amount` of `asset_a`
/// for `asset_b`; `sell_a = False` sells `sell_amount` of `asset_b` for `asset_a`.
/// `limit` is the minimum amount of the *bought* asset — the per-order floor
/// (§5.2.5). Either asset may be ADA or a native token.
///
/// `pool_nft` **binds the order to the exact pool it consents to** (§5.2 identity
/// binding). The settlement anchor pins the solver-declared pair/NFT to the spent
/// `PoolDatum` and then requires every order's `pool_nft` to equal it — so a solver
/// can neither settle the order against an attacker-created worthless-pair pool nor
/// pay the owner a token of the solver's choosing (closes the unbound-bought-asset
/// rug). The bought/sold asset identities then follow from `sell_a` + the verified
/// pair, so no separate buy/sell field is needed.
pub type OrderDatum {
  owner: Credential,
  pool_nft: AssetId,
  sell_a: Bool,
  sell_amount: Int,
  limit: Int,
  tip: Int,
  partial: Bool,
  /// Optional settlement deadline (POSIX ms). If `Some(d)`, a settlement may
  /// only include this order while the tx is valid no later than `d` (the tx's
  /// finite upper validity bound ≤ d). Owner reclaim is always allowed (§5.1),
  /// so an expired order is never stuck.
  deadline: Option<Int>,
}

/// Order spend redeemer: join a settlement (defer to `S`) or owner-reclaim.
pub type OrderRedeemer {
  Settle
  Reclaim
}

/// Pool UTXO datum (§5.1). Reserves are read from the UTXO *value*; `k` is NOT
/// stored. Identity (`nft`) + the traded pair (`asset_a`, `asset_b`) + static fee.
/// Either asset may be ADA. Distinct shape (6 fields) from `OrderDatum` (8).
///
/// `creator` is the credential that may tear down a created-but-never-seeded pool
/// via `ClosePool` (§5.1 path c). It authorizes the teardown by **signature**, so it
/// must be a verification-key credential (like order reclaim); the field is otherwise
/// inert (immutable across settlement/LP, pinned by datum continuity). Post-seed pools
/// are immortal, so `creator` only ever governs the pre-seed UTXO (NFT + LP + seed).
pub type PoolDatum {
  nft: AssetId,
  asset_a: AssetId,
  asset_b: AssetId,
  fee_num: Int,
  fee_den: Int,
  creator: Credential,
}

/// Pool spend redeemer.
pub type PoolRedeemer {
  /// Spent inside a settlement: pool owns its `k` non-decreasing check (§5.4
  /// split) and defers the rest to `S`.
  PoolSettle
  /// LP deposit/withdraw (share-token based, §6 LP model).
  LpAction
  /// Tear down a created-but-never-seeded pool (held == total_lp ⟺ circ == 0):
  /// burn the NFT + full LP supply. Post-seed pools are immortal (the locked
  /// MIN_LIQ can never be reassembled), so reserves can't be stolen this way.
  ClosePool
}

/// Datum on each owner-output: the injective binding key (§5.2.6) — the unique
/// OutputReference of the order it satisfies. No per-order NFT.
pub type BoundDatum {
  order_ref: OutputReference,
}

/// Pool mint policy redeemer: create a pool (mint NFT + full LP supply into it)
/// or close it (burn-only).
pub type MintRedeemer {
  Create
  Close
}

/// The solver-supplied settlement witness (the redeemer of the withdraw-0
/// settlement validator). Clearing price is an exact rational (no floats):
/// `price = price_num / price_den` is the amount of `asset_b` per unit of
/// `asset_a`. `asset_a`/`asset_b`/`pool_nft` are solver-declared identities, but
/// they are **bound to the spent `PoolDatum`** (the anchor asserts they equal the
/// pool's real `(asset_a, asset_b, nft)`) and each order consents to `pool_nft` —
/// so the solver cannot substitute asset identities. The anchor still reads the
/// curve/fee from neither datum nor redeemer, staying curve-agnostic (§5.4 split).
pub type SettlementRedeemer {
  price_num: Int,
  price_den: Int,
  asset_a: AssetId,
  asset_b: AssetId,
  pool_nft: AssetId,
  /// Per-order fill amount (canonical input order; one entry per order input).
  /// `fills[i] == sell_amount` is a full fill; `fills[i] < sell_amount` is a
  /// partial fill (requires `partial == True`) producing a remainder UTXO.
  fills: List<Int>,
}
