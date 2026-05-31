//// Provisional datum/redeemer encodings for the ShaSwap ex-unit spike (BLUEPRINT §13.1).
//// Throwaway measurement code — representative, not production-complete.
////
//// Spike scenario: ONE constant-product pool trading token X against ADA.
//// Every order SELLS `sell_amount` units of X and receives ADA at one uniform
//// clearing price. This exercises every cost-bearing §5.2 check (conservation
//// with ADA's three roles, uniform price, k non-decreasing, per-order floor,
//// injective order->output binding, account-for-every-input).

use cardano/address.{Credential}
use cardano/transaction.{OutputReference}

/// Pool UTXO datum. Reserves are read from the UTXO *value*, never stored here
/// (BLUEPRINT §5.1: `k` is derived from actual reserves, not stored).
pub type PoolDatum {
  fee_num: Int,
  fee_den: Int,
}

/// Order UTXO datum (the intent). Locked by the immutable order validator.
/// Order value carries: `sell_amount` of token X + (min_ada + tip) lovelace.
pub type OrderDatum {
  owner: Credential,
  sell_amount: Int,
  limit: Int,
  tip: Int,
  partial: Bool,
}

/// Datum attached to each owner-output. It is the injective binding key
/// (BLUEPRINT §5.2.6): the unique OutputReference of the order it satisfies.
/// No per-order NFT needed — Cardano guarantees OutputReference uniqueness.
pub type BoundDatum {
  order_ref: OutputReference,
}

/// The solver-supplied settlement witness. The clearing price is an exact
/// rational (integer numerator/denominator) — no floats (Principle 4, §5.2).
pub type SettlementRedeemer {
  price_num: Int,
  price_den: Int,
}

/// Order spend redeemer: either join a settlement (defer to the withdraw-0
/// validator) or reclaim on the owner's signature alone (§5.1, non-custodial).
pub type OrderRedeemer {
  Settle
  Reclaim
}
