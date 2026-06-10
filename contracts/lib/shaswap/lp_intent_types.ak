//// LP-intent datum/redeemer encodings (BLUEPRINT §5.1 Rev 22,
//// `documentation/spec/lp-intents.md`).
////
//// A batcher-fulfilled deposit/withdraw *intent*. The `lp_intent` validator is
//// **parameterised by the settlement credential `S`** (so `fulfill` can assert
//// `!withdrawal_present(S)` and forbid the settlement fold). The intent UTXO sits at
//// that validator's address with a **non-`S` (enterprise) stake credential**, so the
//// settlement anchor never enumerates it — LP fulfillment is its own tx, never folded
//// into a settlement (§5.4). Kept in a SEPARATE module so the frozen
//// `types.ak`/`constants.ak` (imported by the immutable validators) do not change at all.

use cardano/address.{Credential}
use shaswap/types.{AssetId}

/// Per-UTXO min-ADA assumed for an LP-intent and its owner payout. This is an
/// **app/batcher funding constant**, NOT a validator-enforced floor: `fulfill` pins the
/// owner-output value exactly and the ledger's own min-ADA rule rejects an under-funded
/// payout (so a too-small intent is simply un-fulfillable, never a fund risk). Defined
/// here (not in the frozen `constants.ak`) to keep the immutable validators byte-stable.
/// = `order_min_ada` (2 ADA).
pub const lp_intent_min_ada: Int = 2_000_000

/// Which LP action the intent requests.
pub type LpIntentAction {
  LpDeposit
  LpWithdraw
}

/// LP-intent UTXO datum (§5.1 Rev 22). Flat shape (mirrors `OrderDatum`): a **withdraw**
/// uses `min_a`/`min_b` (the released-reserve floor) and ignores `min_shares`; a
/// **deposit** uses `min_shares` (the minted-share floor) and ignores `min_a`/`min_b`.
pub type LpIntentDatum {
  /// Owner credential — a VK in v1 (spends + reclaims by signature, non-custodial).
  owner: Credential,
  /// Payout stake half (as `OrderDatum.owner_stake`): `Some(c)` → base address, `None`
  /// → enterprise. Read FROM the datum, so the batcher can neither choose nor redirect
  /// the payout's staking rewards (audit M-01 parity).
  owner_stake: Option<Credential>,
  /// The pool this intent consents to, bound by its unique NFT.
  pool_nft: AssetId,
  action: LpIntentAction,
  /// Withdraw floor: released `asset_a` ≥ `min_a` (ignored for deposit).
  min_a: Int,
  /// Withdraw floor: released `asset_b` ≥ `min_b` (ignored for deposit).
  min_b: Int,
  /// Deposit floor: minted `shares` ≥ `min_shares` (ignored for withdraw).
  min_shares: Int,
  /// Solver reward (lovelace) — the ONLY value the batcher keeps.
  tip: Int,
  /// Optional fulfillment deadline (POSIX ms); the tx's finite upper validity bound
  /// must be ≤ this. Owner reclaim is always allowed, so an expired intent is never
  /// stuck.
  deadline: Option<Int>,
}

/// LP-intent spend redeemer: batcher fulfillment, or owner reclaim.
pub type LpIntentRedeemer {
  Fulfill
  ReclaimLp
}
